// /admin/usage — aggregate usage stats across all external services.
//
// Aggregates:
//   - Brevo   — email plan + credits (uses existing BREVO_API_KEY)
//   - Firestore — our app's sync read count (from sync_state.total_upserts)
//   - Supabase — DB row counts on each table (gives a feel for storage growth)
//   - Cloudflare — Workers requests last 24h (OPTIONAL, needs analytics token)
//   - Cloudinary — storage / bandwidth / transformations (OPTIONAL, needs key+secret)
//
// Cached for 5 minutes per Worker isolate to avoid hammering external APIs
// every time the admin opens the page.

import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { requireAuth, requireAdmin } from '../lib/middleware';
import { fetchFirestoreTimeSeries, type Range } from '../lib/firestoreMonitoring';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth, requireAdmin);

interface ServiceResult {
  available: boolean;
  reason?: string;
  setupHint?: string;
  [k: string]: unknown;
}

interface UsageResponse {
  fetchedAt: string;
  cached: boolean;
  brevo: ServiceResult;
  firestore: ServiceResult;
  supabase: ServiceResult;
  cloudflare: ServiceResult;
  cloudinary: ServiceResult;
}

// In-memory cache (per Worker isolate). 5-minute TTL. Refresh endpoint busts it.
let cached: { data: UsageResponse; at: number } | null = null;
const CACHE_TTL_MS = 5 * 60_000;


app.get('/', async c => {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return c.json({ ...cached.data, cached: true });
  }
  cached = { data: await collectUsage(c.env), at: Date.now() };
  return c.json(cached.data);
});

// POST /admin/usage/refresh — bust cache + fetch fresh.
app.post('/refresh', async c => {
  cached = { data: await collectUsage(c.env), at: Date.now() };
  return c.json(cached.data);
});

// GET /admin/usage/firestore-timeseries?range=1h|24h|today
// Returns bucketed reads/writes/deletes from Cloud Monitoring API. Cached
// separately from the main usage payload because charts often refresh
// independently of the summary cards.
const tsCache: Record<string, { data: unknown; at: number }> = {};
const TS_CACHE_TTL_MS = 60_000; // monitoring data lags ~5min anyway, 1-min cache is fine

app.get('/firestore-timeseries', async c => {
  const range = (c.req.query('range') || '24h') as Range;
  if (!['1h', '24h', 'today'].includes(range)) {
    return c.json({ error: 'invalid_range' }, 400);
  }
  const cacheKey = range;
  const hit = tsCache[cacheKey];
  if (hit && Date.now() - hit.at < TS_CACHE_TTL_MS) {
    return c.json({ ...(hit.data as object), cached: true });
  }
  try {
    const data = await fetchFirestoreTimeSeries(c.env, range);
    tsCache[cacheKey] = { data, at: Date.now() };
    return c.json({ ...data, cached: false });
  } catch (e: any) {
    const msg = String(e?.message || e);
    // 403 typically means Cloud Monitoring API isn't enabled OR the service
    // account lacks the Monitoring Viewer role. Surface a friendly hint.
    if (msg.includes('403') || msg.includes('PERMISSION_DENIED')) {
      return c.json({
        error: 'not_configured',
        reason: msg,
        setupHint: 'Enable the Cloud Monitoring API in your GCP project AND grant the Firebase service account the "Monitoring Viewer" IAM role. See firestoreMonitoring.ts for full steps.',
      }, 200);
    }
    return c.json({ error: 'fetch_failed', reason: msg }, 200);
  }
});


async function collectUsage(env: Env): Promise<UsageResponse> {
  const [brevo, firestore, supabase, cloudflare, cloudinary] = await Promise.all([
    fetchBrevo(env).catch(e => ({ available: false, reason: errMsg(e) })),
    fetchFirestore(env).catch(e => ({ available: false, reason: errMsg(e) })),
    fetchSupabase(env).catch(e => ({ available: false, reason: errMsg(e) })),
    fetchCloudflare(env).catch(e => ({ available: false, reason: errMsg(e) })),
    fetchCloudinary(env).catch(e => ({ available: false, reason: errMsg(e) })),
  ]);
  return {
    fetchedAt: new Date().toISOString(),
    cached: false,
    brevo, firestore, supabase, cloudflare, cloudinary,
  };
}

const errMsg = (e: any): string => String(e?.message || e || 'error').slice(0, 200);


// ---------------------------------------------------------------------------
// Brevo — plan + email credits via /v3/account
// ---------------------------------------------------------------------------
async function fetchBrevo(env: Env): Promise<ServiceResult> {
  if (!env.BREVO_API_KEY) return { available: false, reason: 'no_api_key' };
  const r = await fetch('https://api.brevo.com/v3/account', {
    headers: { 'api-key': env.BREVO_API_KEY, Accept: 'application/json' },
  });
  if (!r.ok) return { available: false, reason: `status_${r.status}` };
  const body = await r.json() as any;
  // The plans array contains entries by credit type. We surface the "email" one if present.
  const emailPlan = (body.plan || []).find((p: any) => p.creditsType === 'sendLimit')
    || (body.plan || [])[0]
    || {};
  return {
    available: true,
    accountEmail: body.email,
    companyName: body.companyName,
    planType: emailPlan.type || 'unknown',
    creditsRemaining: typeof emailPlan.credits === 'number' ? emailPlan.credits : null,
    // Free tier limit (not returned by the API explicitly — documented).
    dailyEmailLimit: 300,
    // Brevo's API doesn't expose today's send count. Without local tracking,
    // we can only show the documented limit + credits remaining.
    note: "Brevo doesn't return today's send count via API; only credits + plan.",
  };
}


// ---------------------------------------------------------------------------
// Firestore — our app's read footprint (from sync_state.total_upserts).
// This is NOT the actual Firestore project read count (would need Cloud
// Monitoring API). It's how much this sync engine has read cumulatively.
// ---------------------------------------------------------------------------
async function fetchFirestore(env: Env): Promise<ServiceResult> {
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/sync_state` +
    `?shop_code=eq.${encodeURIComponent(env.SHOP_CODE)}` +
    `&select=collection,total_upserts,last_run_doc_count,last_success_at`,
    { headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` } },
  );
  if (!r.ok) return { available: false, reason: `status_${r.status}` };
  const rows = await r.json() as Array<{
    collection: string;
    total_upserts: number;
    last_run_doc_count: number;
    last_success_at: string | null;
  }>;
  const totalLifetimeReads = rows.reduce((s, r) => s + (r.total_upserts || 0), 0);
  return {
    available: true,
    perCollection: rows,
    totalLifetimeReads,
    note: 'Counts only what THIS app has synced. Direct mobile/portal Firestore activity not included.',
    dailyReadLimit: 50_000,
    dailyWriteLimit: 20_000,
  };
}


// ---------------------------------------------------------------------------
// Supabase — row counts on the main tables (proxy for storage growth).
// Full DB size needs a Postgres RPC which we haven't installed; this gives
// the next best signal.
// ---------------------------------------------------------------------------
async function fetchSupabase(env: Env): Promise<ServiceResult> {
  const tables = [
    'replica_documents',
    'otp_requests',
    'sessions',
    'users',
    'quote_requests',
    'reprint_requests',
    'sync_state',
  ];
  const counts: Record<string, number> = {};
  await Promise.all(tables.map(async t => {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${t}?select=id`, {
      method: 'HEAD',
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        Prefer: 'count=exact',
      },
    });
    if (r.ok) {
      const range = r.headers.get('content-range') || '';
      const m = range.match(/\/(\d+|\*)$/);
      counts[t] = m && m[1] !== '*' ? parseInt(m[1], 10) : 0;
    }
  }));
  return {
    available: true,
    rowCounts: counts,
    totalRows: Object.values(counts).reduce((a, b) => a + b, 0),
    storageLimitMb: 500,
    bandwidthLimitGb: 5,
    note: 'Free plan: 500MB DB, 5GB bandwidth/month, unlimited API calls.',
  };
}


// ---------------------------------------------------------------------------
// Cloudflare — Worker invocations last 24h via Analytics GraphQL.
// Optional. Requires:
//   CLOUDFLARE_ACCOUNT_ID
//   CLOUDFLARE_ANALYTICS_TOKEN (API token with Account.Analytics:Read scope)
// ---------------------------------------------------------------------------
async function fetchCloudflare(env: Env): Promise<ServiceResult> {
  const accountId = (env as any).CLOUDFLARE_ACCOUNT_ID as string | undefined;
  const token = (env as any).CLOUDFLARE_ANALYTICS_TOKEN as string | undefined;
  if (!accountId || !token) {
    return {
      available: false,
      reason: 'not_configured',
      setupHint: 'Add CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ANALYTICS_TOKEN to .env. Create the token at dash.cloudflare.com/profile/api-tokens with "Account → Analytics → Read" scope.',
      dailyRequestLimit: 100_000,
    };
  }

  const sinceIso = new Date(Date.now() - 24 * 3600_000).toISOString();
  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
        workersInvocationsAdaptive(
          filter: { datetime_geq: "${sinceIso}" }
          limit: 100
        ) {
          sum { requests errors subrequests }
          quantiles { cpuTimeP50 cpuTimeP99 }
        }
      }
    }
  }`;

  const r = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) return { available: false, reason: `status_${r.status}` };
  const body = await r.json() as any;
  if (body.errors?.length) {
    return { available: false, reason: String(body.errors[0]?.message || 'graphql_error') };
  }
  const node = body?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive?.[0];
  const sum = node?.sum || {};
  const q = node?.quantiles || {};
  return {
    available: true,
    last24h: {
      requests: sum.requests || 0,
      errors: sum.errors || 0,
      subrequests: sum.subrequests || 0,
      cpuTimeP50ms: q.cpuTimeP50,
      cpuTimeP99ms: q.cpuTimeP99,
    },
    dailyRequestLimit: 100_000,
  };
}


// ---------------------------------------------------------------------------
// Cloudinary — usage stats via Admin API.
// Optional. Requires:
//   CLOUDINARY_API_KEY
//   CLOUDINARY_API_SECRET
//   (cloud name read from the existing CLOUDINARY_CLOUD_NAME if present, or
//    via admin-shop settings; if not configured we report not_configured)
// ---------------------------------------------------------------------------
async function fetchCloudinary(env: Env): Promise<ServiceResult> {
  const cloud = (env as any).CLOUDINARY_CLOUD_NAME as string | undefined;
  const key = (env as any).CLOUDINARY_API_KEY as string | undefined;
  const secret = (env as any).CLOUDINARY_API_SECRET as string | undefined;
  if (!cloud || !key || !secret) {
    return {
      available: false,
      reason: 'not_configured',
      setupHint: 'Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET to .env. Get all three at cloudinary.com → Console → Account Details.',
    };
  }
  const auth = btoa(`${key}:${secret}`);
  const r = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/usage`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!r.ok) return { available: false, reason: `status_${r.status}` };
  const body = await r.json() as any;
  return {
    available: true,
    plan: body.plan,
    bandwidth: { usage: body.bandwidth?.usage || 0, limit: body.bandwidth?.limit ?? null },
    storage: { usage: body.storage?.usage || 0, limit: body.storage?.limit ?? null },
    transformations: { usage: body.transformations?.usage || 0, limit: body.transformations?.limit ?? null },
    creditsUsed: body.credits?.usage,
    creditsLimit: body.credits?.limit,
  };
}

export default app;
