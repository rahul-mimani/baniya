// /admin/sync/* — visibility + manual control over the replica sync job.
//
// In normal operation the cron in wrangler.toml fires every 5 minutes and you
// don't touch these endpoints. They exist for:
//   - GET  /admin/sync/status      — what each collection's state is
//   - POST /admin/sync/trigger     — kick a full sync NOW (useful during dev,
//                                    after seeding new data in Firestore, or
//                                    if you suspect the cron stopped firing)
//   - POST /admin/sync/trigger/:collection — sync just one collection
//
// All routes are admin-only. They are scoped to the admin's own shop_code.

import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { requireAuth, requireAdmin } from '../lib/middleware';
import { select } from '../lib/db';
import { runIncrementalSync, runReconcileSync, runWeeklyCleanup, syncOneCollection, SYNCED_COLLECTIONS } from '../lib/sync';
// recomputeAggregatesFromSupabase no longer used here — admin_aggregates is
// maintained incrementally inside syncOneCollection (Phase B incremental).
import { getDocument, listAllDocuments, incrementDocumentFields } from '../lib/firestore';

// AGGREGATE_TRACKED removed in Phase B incremental refactor —
// admin_aggregates is maintained inside syncOneCollection now, no separate
// post-trigger refresh needed at this layer.

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('*', requireAuth, requireAdmin);

interface DbSyncState {
  shop_code: string;
  collection: string;
  last_run_started_at: string | null;
  last_run_finished_at: string | null;
  last_success_at: string | null;
  cursor_updated_at: string | null;
  last_error: string | null;
  total_upserts: number;
  last_run_doc_count: number;
}

// GET /admin/sync/status — one row per known collection, with a derived
// `status` field ('ok' / 'pending' / 'running' / 'error') for the UI.
app.get('/status', async c => {
  const admin = c.get('user');
  const rows = await select<DbSyncState>(
    c.env,
    'sync_state',
    `shop_code=eq.${encodeURIComponent(admin.shop_code)}&order=collection.asc`,
  );

  // Build a complete list — include collections that have never synced yet
  // (no row in sync_state) so the UI can show them as 'pending'.
  const byName = new Map(rows.map(r => [r.collection, r]));
  const collections = SYNCED_COLLECTIONS.map(name => {
    const r = byName.get(name);
    if (!r) {
      return {
        collection: name,
        status: 'pending' as const,
        last_run_started_at: null,
        last_run_finished_at: null,
        last_success_at: null,
        last_error: null,
        total_upserts: 0,
        last_run_doc_count: 0,
      };
    }
    let status: 'ok' | 'pending' | 'running' | 'error' = 'ok';
    if (r.last_error) status = 'error';
    else if (!r.last_success_at) status = 'pending';
    else if (r.last_run_started_at && (!r.last_run_finished_at ||
             r.last_run_started_at > r.last_run_finished_at)) status = 'running';
    return {
      collection: r.collection,
      status,
      last_run_started_at: r.last_run_started_at,
      last_run_finished_at: r.last_run_finished_at,
      last_success_at: r.last_success_at,
      last_error: r.last_error,
      total_upserts: r.total_upserts,
      last_run_doc_count: r.last_run_doc_count,
    };
  });

  return c.json({
    shop_code: admin.shop_code,
    collections,
    has_errors: collections.some(c => c.status === 'error'),
  });
});

// POST /admin/sync/trigger — INCREMENTAL sync NOW (default mode). Cheap.
// Returns per-collection results once finished. Optional query param:
//   ?force_aggregates=true  — recompute aggregate doc regardless of whether
//   any bills/payments changed this cycle (useful for debugging or right
//   after a schema/SQL function change).
app.post('/trigger', async c => {
  if (c.env.SHOP_CODE !== c.get('user').shop_code) {
    // Defensive: this Worker is single-tenant. The admin's shop must match
    // the configured SHOP_CODE or sync would write to the wrong slot.
    return c.json({ error: 'shop_mismatch' }, 403);
  }
  const forceAgg = c.req.query('force_aggregates') === 'true';
  try {
    const result = await runIncrementalSync(c.env, {
      forceAggregateRecompute: forceAgg,
    });
    return c.json({ ok: true, result });
  } catch (e: any) {
    return c.json({ error: 'sync_failed', detail: String(e?.message || e) }, 500);
  }
});

// POST /admin/sync/reconcile — FULL list + delete-stale per collection.
// Expensive (reads every doc once). Run sparingly: after seeding new data,
// after restoring a backup, or if you suspect drift. The daily cron does this
// automatically at 00:00 UTC.
app.post('/reconcile', async c => {
  if (c.env.SHOP_CODE !== c.get('user').shop_code) {
    return c.json({ error: 'shop_mismatch' }, 403);
  }
  try {
    const result = await runReconcileSync(c.env);
    return c.json({ ok: true, result });
  } catch (e: any) {
    return c.json({ error: 'sync_failed', detail: String(e?.message || e) }, 500);
  }
});

// POST /admin/sync/upsert/:collection/:id
//
// Fetches a SINGLE document from Firestore by its known id and upserts it
// into the replica. Used by the portal after admin actions where we know
// the exact doc that needs to be present in the replica (e.g.
// acknowledging a bill — we need the underlying bill to be in replica for
// the client view to render).
//
// Cost: 1 Firestore read + 1 Supabase upsert. ~100× cheaper than a full
// `reconcile` of the collection, and much more targeted than incremental
// (which can't find the doc when it lacks `lastModified`).
//
// Returns:
//   { ok: true } — doc found in Firestore + upserted to replica
//   { ok: false, reason: 'not_found_in_firestore' } — Firestore has no such doc
app.post('/upsert/:collection/:id', async c => {
  const admin = c.get('user');
  const collection = c.req.param('collection');
  const id = c.req.param('id');

  if (!(SYNCED_COLLECTIONS as readonly string[]).includes(collection)) {
    return c.json({ error: 'unknown_collection' }, 400);
  }
  if (c.env.SHOP_CODE !== admin.shop_code) {
    return c.json({ error: 'shop_mismatch' }, 403);
  }

  const docPath = `shops/${admin.shop_code}/${collection}/${id}`;
  const doc = await getDocument(c.env, docPath);
  if (!doc) {
    return c.json({ ok: false, reason: 'not_found_in_firestore' });
  }

  // Build the upsert batch — bills carry their payments inline in
  // `bills/<id>.payments[]` (Deploy 5), so no separate payments fetch needed.
  const now = new Date().toISOString();
  const rows = [{
    shop_code: admin.shop_code,
    collection,
    firestore_id: id,
    data: doc.data,
    source_updated_at: doc.updateTime,
    last_synced_at: now,
  }];

  const r = await fetch(
    `${c.env.SUPABASE_URL}/rest/v1/replica_documents?on_conflict=shop_code,collection,firestore_id`,
    {
      method: 'POST',
      headers: {
        apikey: c.env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${c.env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
    },
  );
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    return c.json({ ok: false, reason: `supabase ${r.status}: ${detail.slice(0, 200)}` }, 500);
  }
  return c.json({ ok: true });
});

// POST /admin/sync/cleanup — manually run the weekly cleanup job.
// (Cron also fires this at 03:00 UTC every Sunday.)
app.post('/cleanup', async c => {
  if (c.env.SHOP_CODE !== c.get('user').shop_code) {
    return c.json({ error: 'shop_mismatch' }, 403);
  }
  const result = await runWeeklyCleanup(c.env);
  return c.json({ ok: !result.error, result });
});

// POST /admin/sync/trigger/:collection — incremental sync of one collection.
// ?mode=reconcile to force reconcile for that collection.
//
// After the per-collection sync, if it's one of the aggregate-tracked
// collections AND it actually moved data this run, we refresh the admin
// aggregate doc so dashboard numbers stay current. Best-effort — if the
// refresh fails, the next full sync (or daily safety recompute) heals it.
app.post('/trigger/:collection', async c => {
  const admin = c.get('user');
  const collection = c.req.param('collection');
  const mode = c.req.query('mode') === 'reconcile' ? 'reconcile' : 'incremental';
  if (!(SYNCED_COLLECTIONS as readonly string[]).includes(collection)) {
    return c.json({ error: 'unknown_collection' }, 400);
  }
  if (c.env.SHOP_CODE !== admin.shop_code) {
    return c.json({ error: 'shop_mismatch' }, 403);
  }
  const result = await syncOneCollection(c.env, admin.shop_code, collection, mode);

  // Phase B incremental: admin_aggregates was already atomically updated
  // inside syncOneCollection (computeBillDelta + applyBillDeltasToAggregates).
  // No separate full recompute needed here. Use /admin/sync/reconcile?force_aggregates=true
  // for the emergency-rebuild path.

  return c.json({ ok: !result.error, result });
});

// POST /admin/sync/backfill-legacy-updatedat
//
// One-shot ops button. The legacy `customers/<slug>` and `products/<slug>`
// name-registry collections are synced via the `updatedAt` cursor (an ISO
// string stamped by every writer). Docs created before the auto-stamping
// path landed may lack `updatedAt` entirely — those are invisible to the
// incremental cron and never make it to the Supabase replica, which is why
// mobile autocomplete doesn't see them via Realtime.
//
// What this does, scoped to the admin's own shop:
//   1. Lists every doc in `customers` and `products`.
//   2. For any doc missing or carrying a non-string `updatedAt`, stamps it
//      via :commit + updateMask=updatedAt — other fields are untouched.
//   3. Returns counts so the UI can tell you what got fixed.
//
// Idempotent: re-running stamps nothing because the second pass sees the
// field already populated. Safe to expose as a Settings button.
app.post('/backfill-legacy-updatedat', async c => {
  const admin = c.get('user');
  if (c.env.SHOP_CODE !== admin.shop_code) {
    return c.json({ error: 'shop_mismatch' }, 403);
  }

  const start = Date.now();
  const result: Record<string, { scanned: number; stamped: number; errors: number }> = {
    customers: { scanned: 0, stamped: 0, errors: 0 },
    products:  { scanned: 0, stamped: 0, errors: 0 },
  };

  for (const collection of ['customers', 'products'] as const) {
    let docs;
    try {
      docs = await listAllDocuments(c.env, `shops/${admin.shop_code}/${collection}`);
    } catch (err) {
      console.error('backfill_list_failed', { collection, err: String(err) });
      return c.json({ ok: false, error: `list_${collection}_failed`, detail: String(err) }, 500);
    }
    result[collection].scanned = docs.length;

    const now = new Date().toISOString();
    const needsStamp = docs.filter(d =>
      !d.data || typeof d.data.updatedAt !== 'string' || !d.data.updatedAt
    );

    // Stamp in parallel — name registries are small, this finishes quickly.
    await Promise.all(needsStamp.map(d =>
      incrementDocumentFields(
        c.env,
        `shops/${admin.shop_code}/${collection}/${d.id}`,
        {},                     // no numeric deltas
        { updatedAt: now },     // only the updatedAt field is set
      ).then(
        () => { result[collection].stamped++; },
        err => {
          result[collection].errors++;
          console.warn('backfill_stamp_failed', { collection, id: d.id, err: String(err) });
        },
      ),
    ));
  }

  const durationMs = Date.now() - start;
  return c.json({ ok: true, result, durationMs });
});

export default app;
