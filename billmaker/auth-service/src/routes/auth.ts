// /auth/* — public-ish endpoints. All responses are constant-shape regardless
// of whether the address is registered, to defeat user-enumeration.
//
// Two identifier paths are supported on the request/verify endpoints:
//   - email: admin path (matches users.identifier directly)
//   - phone: client path (matches replica_documents.portal_customers
//            data->>'phone' via the normalized index; resolves to the user
//            who has customer_id = that portal_customer.firestore_id)
//
// /auth/lookup gives the login UI the data it needs to show a personalized
// greeting + masked email (or admin-contact fallback) before the user has
// committed to receiving an OTP.

import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import {
  findUserByIdentifier,
  findUserById,
  insertOtpRequest,
  findPendingOtp,
  incrementOtpAttempts,
  markOtpUsed,
  insertSession,
  revokeSession,
  updateUserLastLogin,
  selectOne,
  select,
  type DbUser,
} from '../lib/db';
import { checkOtpRateLimit, checkVerifyOtpRateLimit } from '../lib/ratelimit';
import { generateOtp, hashOtp, verifyOtp } from '../lib/otp';
import { sendEmail, renderOtpEmail } from '../lib/email';
import { signSession } from '../lib/jwt';
import { clientIp, requireAuth } from '../lib/middleware';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const num = (s: string | undefined, d: number) => {
  const n = parseInt(s ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const isValidEmail = (s: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 320;

const normalizePhone = (s: string): string => s.replace(/[^0-9]/g, '');

const isValidPhone = (digits: string): boolean => digits.length >= 7 && digits.length <= 15;

const maskEmail = (email: string): string => {
  const at = email.indexOf('@');
  if (at < 1) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 2) return `${local[0]}***${domain}`;
  return `${local[0]}${local[1]}***${local.slice(-1)}${domain}`;
};


// ----------------------------------------------------------------------------
// Phone → user resolution.
//
// Two-step query because users are keyed by `identifier` (email) but the
// phone lives on the linked portal_customer in the replica:
//   1. Find portal_customers row with matching phone_normalized
//   2. Find users row with customer_id = that firestore_id (active only)
//
// MULTI-SHOP: this helper deliberately does NOT filter by shop_code. A
// single auth-service worker (the primary/main worker)
// handles client logins for ALL shops. The matched user row carries its
// own `shop_code`, which propagates into the minted JWT — client API
// requests on this worker then scope reads/writes by user.shop_code (NOT
// env.SHOP_CODE). This lets shops served by separate "internal" worker
// deployments (e.g. billmaker-auth-shop2) still funnel their CLIENTS
// through the main worker, keeping the internal worker URL invisible to
// end users.
// ----------------------------------------------------------------------------
interface DbReplicaRowMin {
  firestore_id: string;
  data: { name?: string; email?: string; phone?: string };
}

const findUserByPhone = async (
  env: Env,
  phoneDigits: string,
): Promise<{ user: DbUser; customer: DbReplicaRowMin } | null> => {
  if (!phoneDigits) return null;

  // Match against multiple representations of the same phone number.
  // The admin portal stores customer phones in whichever format the user
  // typed — sometimes "+91 98765 43210" (12 digits after normalization),
  // sometimes just "9876543210" (10 digits). Login sends the full form
  // (with country prefix). Try the full digits first, then fall back to
  // the last 10 digits so both saved formats match.
  const candidates = new Set<string>([phoneDigits]);
  if (phoneDigits.length > 10) candidates.add(phoneDigits.slice(-10));

  // PostgREST `in.()` accepts a comma-separated list. Values are digits so
  // no quoting/escaping is needed.
  const inList = Array.from(candidates).join(',');

  // Search across ALL shops — no shop_code filter (see note above).
  const customer = await selectOne<DbReplicaRowMin>(
    env,
    'replica_documents',
    `collection=eq.portal_customers` +
    `&phone_normalized=in.(${encodeURIComponent(inList)})` +
    `&select=firestore_id,data`,
  );
  if (!customer) return null;

  // Look up the user by customer_id. firestore_id is unique across shops
  // so no shop_code filter needed here either. The returned user row
  // carries its own shop_code which is used downstream for JWT minting.
  const users = await select<DbUser>(
    env,
    'users',
    `customer_id=eq.${encodeURIComponent(customer.firestore_id)}` +
    `&active=eq.true&limit=1`,
  );
  if (!users[0]) return null;
  return { user: users[0], customer };
};


// ----------------------------------------------------------------------------
// POST /auth/lookup { phone? , email? }
// Used by the login UI to personalize the next step. Always returns 200 with
// a `found` flag — caller decides whether to show a greeting or fallback.
//
// Response shape:
//   {
//     found: boolean,
//     name?: string,            // greeting name (only if found)
//     hasEmail: boolean,        // whether OTP delivery is possible
//     emailMasked?: string,     // partial mask, e.g. "r***l@gmail.com"
//     adminContact: {           // for "contact us" fallback message
//       email?: string,
//       phone?: string,
//       shopName?: string,
//     }
//   }
// ----------------------------------------------------------------------------
app.post('/lookup', async c => {
  // EDGE rate limit FIRST — before any parsing or DB work. /auth/lookup
  // doesn't insert into otp_requests, so the slower DB-based limiter
  // below never triggers from lookup spam alone. This binding catches it
  // at the edge in ~1ms.
  const ip = clientIp(c);
  if (ip && c.env.LOOKUP_LIMITER) {
    const { success } = await c.env.LOOKUP_LIMITER.limit({ key: ip });
    if (!success) {
      return c.json({ error: 'rate_limited', retry_after: 60 }, 429);
    }
  }

  let body: { phone?: string; email?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const rawPhone = (body.phone || '').trim();
  const rawEmail = (body.email || '').trim().toLowerCase();
  const phoneDigits = rawPhone ? normalizePhone(rawPhone) : '';

  // Reject if neither side provided OR provided invalid.
  if (!phoneDigits && !rawEmail) return c.json({ error: 'invalid_input' }, 400);
  if (phoneDigits && !isValidPhone(phoneDigits)) return c.json({ error: 'invalid_phone' }, 400);
  if (rawEmail && !isValidEmail(rawEmail)) return c.json({ error: 'invalid_email' }, 400);

  // Secondary slower rate limit (kept as defense in depth). Reuses OTP rate
  // limiter. Note: this counter only goes up from /auth/request-otp, NOT
  // from /auth/lookup, so it's mostly a no-op for pure lookup spam. The
  // edge binding above is the actual gatekeeper.
  const decision = await checkOtpRateLimit(c.env, phoneDigits || rawEmail, ip);
  if (!decision.ok) {
    return c.json(
      { error: 'rate_limited', retry_after: decision.retryAfterSeconds },
      429,
    );
  }

  // Always include the shop's contact info, even if user is found — UI may
  // surface it elsewhere.
  const shop = await selectOne<{
    name: string;
    admin_contact_email: string | null;
    admin_contact_phone: string | null;
    display_name: string | null;
  }>(c.env, 'shops', `code=eq.${encodeURIComponent(c.env.SHOP_CODE)}`);
  const adminContact = {
    email: shop?.admin_contact_email || undefined,
    phone: shop?.admin_contact_phone || undefined,
    shopName: shop?.display_name || shop?.name || undefined,
  };

  let found = false;
  let name: string | undefined;
  let hasEmail = false;
  let emailMasked: string | undefined;

  if (phoneDigits) {
    const res = await findUserByPhone(c.env, phoneDigits);
    if (res) {
      found = true;
      name = res.user.name || res.customer.data.name;
      // identifier on a real user is their email
      if (res.user.identifier_type === 'email' && isValidEmail(res.user.identifier)) {
        hasEmail = true;
        emailMasked = maskEmail(res.user.identifier);
      }
    }
  } else if (rawEmail) {
    const user = await findUserByIdentifier(c.env, rawEmail);
    if (user) {
      found = true;
      name = user.name;
      hasEmail = isValidEmail(user.identifier);
      emailMasked = hasEmail ? maskEmail(user.identifier) : undefined;
    }
  }

  return c.json({
    found,
    name,
    hasEmail,
    emailMasked,
    adminContact,
  });
});


// ----------------------------------------------------------------------------
// POST /auth/request-otp { email? , phone? }
// Sends an OTP to the registered email of whoever matches.
// Always responds the same way (200 + prefix). Attacker can't enumerate.
// ----------------------------------------------------------------------------
app.post('/request-otp', async c => {
  let body: { email?: string; phone?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const rawEmail = (body.email || '').trim().toLowerCase();
  const rawPhone = (body.phone || '').trim();
  const phoneDigits = rawPhone ? normalizePhone(rawPhone) : '';

  if (!rawEmail && !phoneDigits) return c.json({ error: 'invalid_input' }, 400);
  if (rawEmail && !isValidEmail(rawEmail)) return c.json({ error: 'invalid_email' }, 400);
  if (phoneDigits && !isValidPhone(phoneDigits)) return c.json({ error: 'invalid_phone' }, 400);

  const ip = clientIp(c);
  // For rate-limit purposes the identifier used is whichever was supplied.
  const rateKey = rawEmail || phoneDigits;
  const decision = await checkOtpRateLimit(c.env, rateKey, ip);
  if (!decision.ok) {
    return c.json(
      { error: 'rate_limited', retry_after: decision.retryAfterSeconds },
      429,
      { 'Retry-After': String(decision.retryAfterSeconds) },
    );
  }

  // Resolve to a user. Phone path → portal_customers join (multi-shop, sees
  // users across all shops). Email path → direct (already multi-shop because
  // identifier is unique per user regardless of shop).
  let user: DbUser | null = null;
  if (phoneDigits) {
    const res = await findUserByPhone(c.env, phoneDigits);
    user = res?.user ?? null;
  } else if (rawEmail) {
    user = await findUserByIdentifier(c.env, rawEmail);
  }

  // The identifier we'll log against the OTP row (used by verify-otp later).
  // Same rule as lookup: use the actual user's identifier so the verify step
  // can find this OTP regardless of which channel the client used.
  const identifierForOtp = user?.identifier || rawEmail || phoneDigits;

  const { prefix, full } = generateOtp();
  const ttl = num(c.env.OTP_TTL_MINUTES, 10);
  const otpHash = await hashOtp(full, c.env.OTP_PEPPER);

  await insertOtpRequest(c.env, {
    user_id: user?.id ?? null,
    identifier: identifierForOtp,
    ip_address: ip,
    otp_hash: otpHash,
    prefix,
    expires_at: new Date(Date.now() + ttl * 60_000).toISOString(),
  });

  // Only send if there's a real user with a usable email
  if (user && isValidEmail(user.identifier)) {
    const { subject, html, text } = renderOtpEmail(full, ttl, user.name, c.env.SHOP_NAME || c.env.EMAIL_FROM_NAME || 'BillMaker');
    c.executionCtx.waitUntil(
      sendEmail(c.env, { to: user.identifier, subject, html, text }).catch(err => {
        console.error('email send failed', { err: String(err) });
      }),
    );
  }

  return c.json({
    ok: true,
    prefix,
    ttl_minutes: ttl,
    emailMasked: user && isValidEmail(user.identifier) ? maskEmail(user.identifier) : undefined,
    message: 'If this account exists with a valid email, a code has been sent.',
  });
});

// ----------------------------------------------------------------------------
// POST /auth/verify-otp { email? , phone? , otp }
// On success returns { token, user }.
// ----------------------------------------------------------------------------
app.post('/verify-otp', async c => {
  // EDGE rate limit — Cloudflare's Workers Rate Limiting binding.
  // Runs at the edge in ~1ms, zero subrequest cost. Used as a fast-path
  // rejection BEFORE any DB work. Configured in wrangler.toml
  // (5 req / 60s per IP).
  const ip = clientIp(c);
  if (ip && c.env.VERIFY_OTP_LIMITER) {
    const { success } = await c.env.VERIFY_OTP_LIMITER.limit({ key: ip });
    if (!success) {
      return c.json({ error: 'rate_limited', retryAfter: 60 }, 429);
    }
  }

  // SECONDARY per-IP rate limit (slower, DB-based, longer 1-hour window).
  // Catches distributed attacks that fit under the per-minute edge limit
  // but still hammer over the course of an hour.
  const ipDecision = await checkVerifyOtpRateLimit(c.env, ip);
  if (!ipDecision.ok) {
    return c.json(
      { error: 'rate_limited', retryAfter: ipDecision.retryAfterSeconds },
      429,
    );
  }

  let body: { email?: string; phone?: string; otp?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const rawEmail = (body.email || '').trim().toLowerCase();
  const rawPhone = (body.phone || '').trim();
  const phoneDigits = rawPhone ? normalizePhone(rawPhone) : '';
  const otp = (body.otp || '').trim();

  if (otp.length < 4) return c.json({ error: 'invalid_input' }, 400);
  if (!rawEmail && !phoneDigits) return c.json({ error: 'invalid_input' }, 400);

  // Resolve to the user, which gives us the canonical identifier the OTP was
  // logged under. Without this, an email-issued OTP wouldn't be findable when
  // verifying via phone (and vice versa). Multi-shop: no shop_code filter on
  // either path — the matched user's own shop_code is what's minted into the JWT.
  let user: DbUser | null = null;
  if (phoneDigits) {
    const res = await findUserByPhone(c.env, phoneDigits);
    user = res?.user ?? null;
  } else if (rawEmail) {
    user = await findUserByIdentifier(c.env, rawEmail);
  }
  if (!user) {
    // Same generic error — don't reveal whether the address is registered.
    return c.json({ error: 'invalid_otp' }, 401);
  }

  const pending = await findPendingOtp(c.env, user.identifier);
  if (!pending) return c.json({ error: 'invalid_otp' }, 401);

  const maxAttempts = num(c.env.RATE_LIMIT_VERIFY_ATTEMPTS, 5);
  if (pending.attempts >= maxAttempts) {
    await markOtpUsed(c.env, pending.id);
    return c.json({ error: 'too_many_attempts' }, 401);
  }

  await incrementOtpAttempts(c.env, pending.id, pending.attempts + 1);

  const ok = await verifyOtp(otp, c.env.OTP_PEPPER, pending.otp_hash);
  if (!ok) return c.json({ error: 'invalid_otp' }, 401);

  await markOtpUsed(c.env, pending.id);

  // Re-fetch in case state changed between OTP request + verify
  const fresh = await findUserById(c.env, user.id);
  if (!fresh || !fresh.active) return c.json({ error: 'user_inactive' }, 401);

  const jti = crypto.randomUUID();
  // Role-aware session TTL. Clients get a long-lived token so non-tech-savvy
  // customers don't have to re-login frequently; admins keep a short one
  // because admin sessions are higher-risk.
  // Defaults: client = 30 days, admin = 12 hours. Override via env if needed.
  const ttlMin = fresh.role === 'admin'
    ? num(c.env.JWT_TTL_MINUTES, 720)
    : num(c.env.JWT_TTL_CLIENT_MINUTES, 43_200);
  const expiresAt = new Date(Date.now() + ttlMin * 60_000).toISOString();

  await insertSession(c.env, {
    user_id: fresh.id,
    token_jti: jti,
    expires_at: expiresAt,
    user_agent: c.req.header('User-Agent') || null,
    ip_address: clientIp(c),
  });

  const token = await signSession(
    c.env,
    {
      sub: fresh.id,
      jti,
      role: fresh.role,
      shop: fresh.shop_code,
      cust: fresh.customer_id,
      cls: fresh.class,
    },
    ttlMin,
  );

  await updateUserLastLogin(c.env, fresh.id);

  return c.json({
    ok: true,
    token,
    expires_at: expiresAt,
    user: {
      id: fresh.id,
      name: fresh.name,
      identifier: fresh.identifier,
      role: fresh.role,
      shop_code: fresh.shop_code,
      customer_id: fresh.customer_id,
      class: fresh.class,
    },
  });
});

// ----------------------------------------------------------------------------
// GET /auth/me — returns the authed user (validates session as a side-effect).
// ----------------------------------------------------------------------------
app.get('/me', requireAuth, async c => {
  const user = c.get('user');
  return c.json({
    user: {
      id: user.id,
      name: user.name,
      identifier: user.identifier,
      role: user.role,
      shop_code: user.shop_code,
      customer_id: user.customer_id,
      class: user.class,
    },
  });
});

// ----------------------------------------------------------------------------
// POST /auth/logout — revokes the current session.
// ----------------------------------------------------------------------------
app.post('/logout', requireAuth, async c => {
  const claims = c.get('claims');
  await revokeSession(c.env, claims.jti);
  return c.json({ ok: true });
});


// Phase B mobile endpoints (/realtime-token + /sync/trigger) live in
// routes/mobile.ts so the OTP-auth flows in this file stay isolated.

export default app;
