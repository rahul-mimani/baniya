// /admin/worker-events — paginated read of the worker_events table that
// the cron handlers and other admin actions write to via createEventLogger.
//
// Filters (all optional, AND-combined):
//   ?range=1h|24h|7d|30d   (default: 24h)
//   ?level=info|warn|error (default: all)
//   ?event=sync_completed  (exact match)
//   ?q=foo                 (substring search on the JSON payload)
//   ?limit=N               (default 200, max 1000)
//
// Returns most-recent-first. The shop is implicit (current admin's shop).

import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { requireAuth, requireAdmin } from '../lib/middleware';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', requireAuth, requireAdmin);

type Range = '1h' | '24h' | '7d' | '30d';
const RANGE_MS: Record<Range, number> = {
  '1h': 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
};

app.get('/', async c => {
  if (!c.env.SUPABASE_URL || !c.env.SUPABASE_SERVICE_KEY) {
    return c.json(
      {
        error: 'not_configured',
        reason: 'SUPABASE_URL or SUPABASE_SERVICE_KEY missing in worker env',
      },
      503,
    );
  }

  const range = (c.req.query('range') as Range | undefined) ?? '24h';
  const level = c.req.query('level');
  const event = c.req.query('event');
  const search = c.req.query('q');
  const limitRaw = Number(c.req.query('limit') ?? '200');
  const limit = Math.max(1, Math.min(1000, isFinite(limitRaw) ? limitRaw : 200));

  const sinceMs = RANGE_MS[range] ?? RANGE_MS['24h'];
  const sinceIso = new Date(Date.now() - sinceMs).toISOString();

  // Build PostgREST query
  const params = new URLSearchParams();
  params.append('select', 'id,ts,level,event,payload');
  params.append('shop_code', `eq.${c.env.SHOP_CODE}`);
  params.append('ts', `gte.${sinceIso}`);
  if (level && ['info', 'warn', 'error'].includes(level)) {
    params.append('level', `eq.${level}`);
  }
  if (event) {
    params.append('event', `eq.${event}`);
  }
  if (search) {
    // Search the JSON payload as text. PostgREST: payload::text=ilike.*foo*
    // PostgREST doesn't expose cast directly; use payload->>'_' won't work
    // for an unknown key. Cleanest is to filter client-side after a wider
    // fetch — but for now we use the JSONB containment operator with a
    // simple substring on payload text via a function. Skipping server-side
    // for now; client handles substring filtering on the returned rows.
    // (kept here as a placeholder so the param round-trips)
  }
  params.append('order', 'ts.desc');
  params.append('limit', String(limit));

  const url = `${c.env.SUPABASE_URL}/rest/v1/worker_events?${params.toString()}`;

  try {
    const r = await fetch(url, {
      headers: {
        apikey: c.env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${c.env.SUPABASE_SERVICE_KEY}`,
      },
    });
    if (!r.ok) {
      const body = await r.text();
      return c.json({ error: 'supabase_fetch_failed', status: r.status, body }, 502);
    }
    let rows = (await r.json()) as Array<{
      id: number;
      ts: string;
      level: string;
      event: string;
      payload: unknown;
    }>;

    // Optional client-side substring filter on stringified payload.
    if (search) {
      const needle = search.toLowerCase();
      rows = rows.filter(row =>
        JSON.stringify(row.payload || {}).toLowerCase().includes(needle) ||
        row.event.toLowerCase().includes(needle),
      );
    }

    return c.json({
      range,
      level: level ?? null,
      event: event ?? null,
      q: search ?? null,
      count: rows.length,
      events: rows,
    });
  } catch (err) {
    return c.json({ error: 'supabase_unreachable', detail: String(err) }, 502);
  }
});

// Returns distinct event names seen in the last 30 days — fuel for the
// filter dropdown in the admin UI so the user doesn't have to type from memory.
app.get('/event-types', async c => {
  if (!c.env.SUPABASE_URL || !c.env.SUPABASE_SERVICE_KEY) {
    return c.json({ events: [] });
  }
  const sinceIso = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
  // PostgREST doesn't do DISTINCT directly without an RPC. Cheap workaround:
  // fetch the last 500 events and dedupe client-side. For most admins the
  // event vocabulary is <10 names so this is more than enough.
  const params = new URLSearchParams({
    select: 'event',
    shop_code: `eq.${c.env.SHOP_CODE}`,
    ts: `gte.${sinceIso}`,
    order: 'ts.desc',
    limit: '500',
  });
  const r = await fetch(`${c.env.SUPABASE_URL}/rest/v1/worker_events?${params.toString()}`, {
    headers: {
      apikey: c.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${c.env.SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!r.ok) return c.json({ events: [] });
  const rows = (await r.json()) as Array<{ event: string }>;
  const unique = Array.from(new Set(rows.map(x => x.event))).sort();
  return c.json({ events: unique });
});

export default app;
