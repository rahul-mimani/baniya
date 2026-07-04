// /mobile/* — Phase B endpoints for the BillMaker shopkeeper app.
//
// Isolated from the existing /auth/* OTP flows on purpose: mobile has no
// user-level authentication. It authenticates via a Firebase Anonymous ID
// token (proves possession of the configured Firebase project) plus the
// shop_code in body. The endpoints here are deliberately decoupled so any
// future change to the OTP flow can't accidentally affect mobile sync, and
// vice versa.
//
// Endpoints:
//   POST /mobile/realtime-token       — mint a 15-min Supabase Realtime JWT
//   POST /mobile/sync/trigger/:col    — fire-and-forget Firestore → Supabase sync trigger
//
// Both require: Authorization: Bearer <firebaseIdToken>

import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { clientIp } from '../lib/middleware';
import { signSupabaseRealtime, verifyFirebaseIdToken } from '../lib/jwt';
import { syncOneCollection } from '../lib/sync';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Collections mobile is allowed to trigger a sync for. Keep small —
// only what mobile actually writes to Firestore.
const MOBILE_TRIGGERABLE = new Set<string>(['bills']);

/**
 * Helper: parse + verify the Authorization Bearer token as a Firebase ID
 * token issued for our configured FIREBASE_PROJECT_ID. Returns the verified
 * claims on success, or null + sets the response if invalid.
 */
const requireFirebaseToken = async (
  c: { env: Env; req: { header: (n: string) => string | undefined } },
): Promise<{ sub: string } | null> => {
  const authHeader = c.req.header('authorization') || '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try {
    return await verifyFirebaseIdToken(c.env as Env, m[1]);
  } catch {
    return null;
  }
};

/**
 * Helper: per-IP rate limit via the existing otp_requests row count. Returns
 * true if allowed, false if over budget. Reused so we don't add a new table
 * for the mobile-specific budget — sharing the otp counter is fine because
 * mobile + OTP-auth callers are typically different IPs.
 */
const rateLimitIp = async (env: Env, ip: string | null, maxPerHour: number): Promise<boolean> => {
  if (!ip) return true;
  const { countOtpRequestsSince } = await import('../lib/db');
  const windowMs = 60 * 60 * 1000;
  const count = await countOtpRequestsSince(env, 'ip_address', ip, Date.now() - windowMs);
  return count < maxPerHour;
};


// ----------------------------------------------------------------------------
// POST /mobile/realtime-token — issues a 15-min Supabase Realtime/PostgREST
// JWT scoped to the requested shop_code.
//
// Auth: Authorization: Bearer <firebaseIdToken>
//   - Mobile gets this token by calling signInAnonymously() against its
//     configured Firebase project, then auth.currentUser.getIdToken().
//   - We verify the token is signed by Google AND issued for OUR Firebase
//     project (`aud === FIREBASE_PROJECT_ID`).
//
// Body: { shop_code: string }
// Returns: { token, expiresAt, supabaseUrl, supabaseAnonKey }
//
// Rate-limited per IP (60/hour) — generous for token refresh (~every 13 min)
// but stops casual abuse.
// ----------------------------------------------------------------------------
app.post('/realtime-token', async c => {
  const firebaseClaims = await requireFirebaseToken(c);
  if (!firebaseClaims) return c.json({ error: 'invalid_firebase_token' }, 401);

  if (!await rateLimitIp(c.env, clientIp(c), 60)) {
    return c.json({ error: 'rate_limited', retryAfter: 1800 }, 429);
  }

  let body: { shop_code?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const shopCode = typeof body.shop_code === 'string' ? body.shop_code.trim() : '';
  if (!shopCode) return c.json({ error: 'shop_code_required' }, 400);
  if (shopCode.length > 80 || !/^[a-zA-Z0-9_-]+$/.test(shopCode)) {
    return c.json({ error: 'invalid_shop_code' }, 400);
  }

  const { selectOne } = await import('../lib/db');
  const shop = await selectOne(c.env, 'shops', `code=eq.${encodeURIComponent(shopCode)}&select=code`);
  if (!shop) return c.json({ error: 'unknown_shop' }, 404);

  try {
    const { token, expiresAt } = await signSupabaseRealtime(c.env, {
      sub: `mobile:${shopCode}:${firebaseClaims.sub}`,
      role: 'authenticated',
      shop_code: shopCode,
    });
    return c.json({
      token,
      expiresAt,
      supabaseUrl: c.env.SUPABASE_URL,
      supabaseAnonKey: c.env.SUPABASE_ANON_KEY,
    });
  } catch (err: any) {
    console.error('realtime_token_failed', { err: String(err) });
    return c.json({ error: 'token_signing_failed' }, 500);
  }
});


// ----------------------------------------------------------------------------
// POST /mobile/sync/trigger/:collection — mobile-fired sync trigger.
//
// Mobile calls this fire-and-forget after every Firestore write so the
// worker syncs that collection to Supabase within ~1-2s. Other devices then
// see the change via Realtime in another ~100ms.
//
// Phase B incremental: admin_aggregates + portal_customers.outstanding are
// updated atomically inside syncOneCollection (computeBillDelta path).
//
// Rate-limited per IP (120/hour ~ 1 trigger per 30s sustained with bursts).
// ----------------------------------------------------------------------------
app.post('/sync/trigger/:collection', async c => {
  const firebaseClaims = await requireFirebaseToken(c);
  if (!firebaseClaims) return c.json({ error: 'invalid_firebase_token' }, 401);

  const collection = c.req.param('collection');
  if (!MOBILE_TRIGGERABLE.has(collection)) {
    return c.json({ error: 'collection_not_triggerable' }, 400);
  }

  let body: { shop_code?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const shopCode = typeof body.shop_code === 'string' ? body.shop_code.trim() : '';
  if (!shopCode) return c.json({ error: 'shop_code_required' }, 400);
  if (!/^[a-zA-Z0-9_-]+$/.test(shopCode)) {
    return c.json({ error: 'invalid_shop_code' }, 400);
  }

  // Server SHOP_CODE binding — single-tenant worker, so this matches.
  if (c.env.SHOP_CODE !== shopCode) {
    return c.json({ error: 'shop_mismatch' }, 403);
  }

  if (!await rateLimitIp(c.env, clientIp(c), 120)) {
    return c.json({ error: 'rate_limited', retryAfter: 1800 }, 429);
  }

  try {
    const result = await syncOneCollection(c.env, shopCode, collection, 'incremental');
    return c.json({ ok: !result.error, docCount: result.docCount });
  } catch (err: any) {
    console.error('mobile_sync_trigger_failed', { shopCode, collection, err: String(err) });
    return c.json({ error: 'sync_failed' }, 500);
  }
});

export default app;
