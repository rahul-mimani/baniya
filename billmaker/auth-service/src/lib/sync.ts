// Replica sync engine.
//
// Two modes — both fed by Cloudflare cron triggers (see wrangler.toml):
//
//   1. INCREMENTAL  (every 5 min): queries `where lastModified > cursor` for
//      each collection. Only changed docs are returned, so a quiet 5-min
//      window costs ~0 Firestore reads. Cursor advances to max lastModified
//      seen. This is the hot path.
//
//   2. RECONCILE  (once daily, see cron schedule): lists every doc in every
//      collection, upserts all, deletes replica rows that weren't touched
//      this run. Catches:
//        - documents deleted in Firestore (incremental can't see them)
//        - documents written before the lastModified wrappers were added
//        - any drift between Firestore and replica caused by a missed event
//      Cost is the full doc count once per day, well within free tier.
//
// First-ever sync (cursor null in incremental): falls through to reconcile
// for that collection only. From then on the cursor is anchored to NOW() and
// incremental queries work.

import type { Env } from '../types';
import { listAllDocuments, queryDocsModifiedSince } from './firestore';
import { upsertShop } from './db';
import {
  recomputeAggregatesFromSupabase,
  computeBillDelta,
  applyBillDeltasToAggregates,
  type BillAggregateDelta,
} from './aggregates';
import { deriveFromBills, applyCustomerOutstandingDeltas } from './derive';

export const SYNCED_COLLECTIONS = [
  'bills',
  // 'payments' RETIRED (Deploy 5) — payments now live in bills.payments[].
  // The auth-service replica reads payment data from bills.data->'payments'.
  'profiles',
  '_meta',
  // Mobile-canonical name registries. Synced so mobile clients receive
  // Realtime events when admin (or other mobiles via worker-derive) adds a
  // new customer or product name. Cursor uses `updatedAt` (ISO string)
  // because legacy docs predate the `lastModified` auto-stamping path.
  'customers',
  'products',
  'portal_customers',
  'portal_products',
  'portal_labels',
  'portal_classes',
  'portal_deals',
] as const;
export type SyncedCollection = (typeof SYNCED_COLLECTIONS)[number];

// Per-collection cursor configuration.
//
// The default cursor field is `lastModified` (a Firestore Timestamp written by
// the portal via serverTimestamp() and by mobile's storage wrappers — see
// withLastModified in /storage/sync.ts).
//
// Mobile-canonical docs that don't carry `lastModified` but DO carry their own
// ISO-string `updatedAt` field are listed here. The cursor query orders by and
// filters on this field instead, giving us 5-minute incremental sync where we
// otherwise had to wait for nightly reconcile.
//
// Important: ISO 8601 strings (e.g. `2026-05-20T08:30:45.123Z`) sort
// lexicographically the same as chronologically, so a plain string compare in
// Firestore's structuredQuery yields correct ordering.
type CursorConfig = { field: string; valueType: 'timestamp' | 'string' };

const COLLECTION_CURSOR: Record<string, CursorConfig> = {
  // Bills use `lastModified` (Firestore Timestamp), not `updatedAt` (ISO
  // string from mobile). Rationale: `updatedAt` is the user-facing "when did
  // the bill change" timestamp from mobile — admin actions like Release or
  // customer link DON'T bump updatedAt. They DO bump lastModified (because
  // pushPortalDoc auto-stamps it on every write). Using lastModified as the
  // cursor ensures portal-only edits (ack, customer link) propagate to the
  // Supabase replica on the next incremental sync.
  //
  // Mobile-side writes also stamp lastModified (see /storage/sync.ts
  // pushDocMerge), so this captures both portal and mobile changes.
  //
  // (Payments collection retired in Deploy 5 — no cursor entry needed.)

  // Legacy mobile-canonical name registries. Three writers — mobile
  // `pushDocMerge`, admin `syncCustomerNameToMobile`/`syncProductNameToMobile`,
  // and worker derive — all stamp `updatedAt` as an ISO string. Old docs
  // from earlier eras may lack `lastModified` entirely, so `updatedAt` is
  // the only field we can rely on across the full corpus. The /admin/backfill
  // endpoint stamps updatedAt on any doc still missing it.
  customers: { field: 'updatedAt', valueType: 'string' },
  products:  { field: 'updatedAt', valueType: 'string' },
};

const cursorConfigFor = (collection: string): CursorConfig =>
  COLLECTION_CURSOR[collection] ?? { field: 'lastModified', valueType: 'timestamp' };

export type SyncMode = 'incremental' | 'reconcile';

export interface SyncCollectionResult {
  collection: string;
  mode: SyncMode;
  docCount: number;        // docs upserted this run
  deletedCount?: number;   // only set in reconcile
  durationMs: number;
  error?: string;
}

export interface SyncRunResult {
  shopCode: string;
  mode: SyncMode;
  startedAt: string;
  finishedAt: string;
  totalDurationMs: number;
  collections: SyncCollectionResult[];
  errorCount: number;
}


// ===========================================================================
// Public entry points.
// ===========================================================================

/** Fast: only fetch docs changed since last cursor per collection. */
export const runIncrementalSync = async (
  env: Env,
  opts?: {
    forceAggregateRecompute?: boolean;
    /** Subset of SYNCED_COLLECTIONS to sync this run. Defaults to ALL. Used
     *  to split the cron into two invocations so each stays under Cloudflare
     *  Workers' free-tier subrequest cap (50/invocation). */
    onlyCollections?: readonly string[];
  },
): Promise<SyncRunResult> => {
  return runSyncInternal(env, 'incremental', opts);
};

/** Slow: full list + delete-stale per collection. Also forces aggregate
 *  recompute since reconcile implies "rebuild ground truth". */
export const runReconcileSync = async (env: Env): Promise<SyncRunResult> => {
  return runSyncInternal(env, 'reconcile', { forceAggregateRecompute: true });
};

/** Backward-compat — old admin trigger calls this. Defaults to incremental. */
export const runSync = runIncrementalSync;


// ===========================================================================
// Cleanup job — weekly maintenance.
//
// Prunes:
//   - otp_requests where expires_at < now() - 7 days
//   - sessions where (expires_at < now() OR revoked) AND created_at < now() - 7 days
//
// Used to keep the auth DB lean. Both tables otherwise grow unbounded.
// ===========================================================================
export interface CleanupResult {
  otpDeleted: number;
  sessionsDeleted: number;
  workerEventsDeleted: number;
  durationMs: number;
  error?: string;
}

export const runWeeklyCleanup = async (env: Env): Promise<CleanupResult> => {
  const start = Date.now();
  // OTPs + sessions: 7-day cutoff (matches their natural lifecycle).
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  // Worker events: 10-day cutoff. Keeps history visible for two cron-week
  // boundaries while staying well under Supabase free-tier storage.
  const workerEventsCutoff = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const [otpDeleted, sessionsDeleted, workerEventsDeleted] = await Promise.all([
      sbDeleteCount(env, `otp_requests?expires_at=lt.${encodeURIComponent(cutoff)}`),
      // Sessions: delete anything older than 7 days that is either expired or revoked.
      // Two queries (REST doesn't support OR on different columns cleanly via path).
      Promise.all([
        sbDeleteCount(env, `sessions?expires_at=lt.${encodeURIComponent(cutoff)}`),
        sbDeleteCount(env, `sessions?revoked=eq.true&created_at=lt.${encodeURIComponent(cutoff)}`),
      ]).then(([a, b]) => a + b),
      // Worker events: prune rows older than 10 days.
      sbDeleteCount(env, `worker_events?ts=lt.${encodeURIComponent(workerEventsCutoff)}`),
    ]);

    return {
      otpDeleted,
      sessionsDeleted,
      workerEventsDeleted,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      otpDeleted: 0,
      sessionsDeleted: 0,
      workerEventsDeleted: 0,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

const sbDeleteCount = async (env: Env, pathWithFilter: string): Promise<number> => {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${pathWithFilter}&select=id`, {
    method: 'DELETE',
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Cleanup delete failed (${r.status}): ${detail}`);
  }
  const rows = await r.json().catch(() => []) as Array<unknown>;
  return Array.isArray(rows) ? rows.length : 0;
};


const runSyncInternal = async (
  env: Env,
  mode: SyncMode,
  opts?: {
    forceAggregateRecompute?: boolean;
    onlyCollections?: readonly string[];
  },
): Promise<SyncRunResult> => {
  const shopCode = env.SHOP_CODE;
  if (!shopCode) throw new Error('SHOP_CODE missing in env');

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  await upsertShop(env, shopCode, shopCode);

  // Determine which collections to sync this run. Defaults to all when
  // unspecified (e.g. manual /admin/sync/trigger). The scheduled cron passes
  // a subset to stay under Cloudflare's free-tier subrequest cap.
  const collectionsToSync = (opts?.onlyCollections && opts.onlyCollections.length > 0)
    ? opts.onlyCollections
    : SYNCED_COLLECTIONS;

  const collections: SyncCollectionResult[] = [];
  for (const col of collectionsToSync) {
    collections.push(await syncOneCollection(env, shopCode, col, mode));
  }

  // Phase B incremental: admin_aggregates is now maintained by atomic
  // increment() calls inside syncOneCollection for each changed bill —
  // matching the portal's patchAdminAggregates pattern (and conflict-free
  // with portal's optimistic patches). The full SQL-driven recompute is
  // reserved for the emergency-rebuild path: admin clicks /admin/sync/
  // reconcile?force_aggregates=true, which runs the SQL function and
  // overwrites the doc with the authoritative result.
  //
  // Quiet ticks skip entirely — no Firestore reads, no SQL query.
  if (opts?.forceAggregateRecompute) {
    try {
      await recomputeAggregatesFromSupabase(env, shopCode);
    } catch (err) {
      console.error('aggregate_recompute_failed', {
        shopCode,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const finishedAtMs = Date.now();
  return {
    shopCode,
    mode,
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    totalDurationMs: finishedAtMs - startedAtMs,
    collections,
    errorCount: collections.filter(c => c.error).length,
  };
};


/** Sync a single collection in the requested mode. Exposed for admin endpoints. */
export const syncOneCollection = async (
  env: Env,
  shopCode: string,
  collection: string,
  mode: SyncMode,
): Promise<SyncCollectionResult> => {
  const startMs = Date.now();
  const startIso = new Date(startMs).toISOString();

  try {
    await sbSyncStateStart(env, shopCode, collection, startIso);

    // For incremental: pull the current cursor. If null, this is the first
    // run for this collection — fall through to reconcile so we get a baseline.
    let effectiveMode = mode;
    let cursor: string | null = null;
    if (mode === 'incremental') {
      cursor = await sbGetCursor(env, shopCode, collection);
      if (cursor === null) effectiveMode = 'reconcile';
    }

    const { field: cursorField, valueType: cursorType } = cursorConfigFor(collection);

    let docs: { id: string; data: any; updateTime: string }[];
    let deletedCount: number | undefined;

    if (effectiveMode === 'reconcile') {
      docs = await listAllDocuments(env, `shops/${shopCode}/${collection}`);
    } else {
      // Incremental — cursor is guaranteed non-null here.
      docs = await queryDocsModifiedSince(
        env,
        `shops/${shopCode}`,
        collection,
        cursor!,
        cursorField,
        cursorType,
      );
    }

    // Phase B optimization: skip the admin_aggregates doc when syncing _meta.
    // The doc IS atomically maintained by portal + worker, but nobody reads
    // it from the Supabase replica — admin portal subscribes directly to
    // Firestore. Including it in cron sync = 1 wasted Firestore read per
    // active tick. The business doc IS used by client portal, so we keep
    // it. Filtering at this layer (post-query, pre-upsert) is the cleanest
    // place — keeps Firestore SDK calls untouched.
    if (collection === '_meta') {
      docs = docs.filter(d => d.id !== 'admin_aggregates');
    }

    // Phase B incremental aggregates: before upserting bills, fetch each
    // bill's OLD state from the replica. We use the old vs new diff to
    // produce per-bill aggregate deltas (totalBilledDelta, totalRevenueDelta,
    // pendingCountDelta, billCountDelta, plus per-customer outstanding delta).
    // Mirrors the portal's patchAdminAggregates pattern — the worker is now
    // doing the same atomic increments mobile/portal used to do, but
    // server-side from the synced bill data.
    let billDeltas: BillAggregateDelta[] = [];
    let oldStatesBeforeUpsert: Map<string, any> = new Map();
    if (collection === 'bills' && docs.length > 0) {
      oldStatesBeforeUpsert = await sbFetchReplicaByIds(
        env,
        shopCode,
        'bills',
        docs.map(d => d.id),
      );
    }

    if (docs.length > 0) {
      const CHUNK = 200;
      for (let i = 0; i < docs.length; i += CHUNK) {
        const batch = docs.slice(i, i + CHUNK).map(d => ({
          shop_code: shopCode,
          collection,
          firestore_id: d.id,
          data: d.data,
          source_updated_at: d.updateTime,
          last_synced_at: startIso,
        }));
        await sbUpsertReplica(env, batch);
      }
    }

    // Compute bill deltas now that we have old + new — emits one delta per
    // changed bill. customerName changes (rare) emit two deltas: one removing
    // the old contribution, one adding the new.
    if (collection === 'bills' && docs.length > 0) {
      for (const d of docs) {
        const oldData = oldStatesBeforeUpsert.get(d.id) ?? null;
        const newData = d.data;
        const oldName = (oldData?.customerName ?? '').trim().toLowerCase();
        const newName = (newData?.customerName ?? '').trim().toLowerCase();
        if (oldData && oldName && newName && oldName !== newName) {
          // Customer renamed/relinked: remove from old, add to new.
          billDeltas.push(computeBillDelta(oldData, null));     // -oldContribution to old customer
          billDeltas.push(computeBillDelta(null, newData));     // +newContribution to new customer (and +1 billCount, etc.)
          // The +1 billCount from the second push is wrong (same bill, not new).
          // Fix by cancelling: subtract a synthetic +1 billCount delta.
          billDeltas.push({
            totalBilledDelta: 0,
            totalRevenueDelta: 0,
            totalBillCountDelta: -1,  // cancel the synthetic +1 from above
            pendingCountDelta: 0,
            customerNameDelta: null,
          });
        } else {
          billDeltas.push(computeBillDelta(oldData, newData));
        }
      }
    }

    if (effectiveMode === 'reconcile') {
      // Drop replica rows for docs that disappeared from Firestore.
      const deletedRows = await sbDeleteStale(env, shopCode, collection, startIso);
      deletedCount = deletedRows.length;
      // For deleted bills: emit negative deltas so admin_aggregates
      // + portal_customer.outstanding stay accurate.
      if (collection === 'bills' && deletedRows.length > 0) {
        for (const row of deletedRows) {
          billDeltas.push(computeBillDelta(row.data, null));
        }
      }
    }

    // Phase B: after bills sync, derive customers/products from the
    // synced bill docs. Mobile no longer writes those — worker does.
    // Idempotent (existence-checked against the replica we just upserted
    // to), so safe even on reconcile re-runs.
    if (collection === 'bills' && docs.length > 0) {
      try {
        const derived = await deriveFromBills(env, shopCode, docs);
        if (derived.customersCreated || derived.productsLegacyCreated || derived.productsPortalCreated) {
          console.log('derive_from_bills', { shopCode, ...derived });
        }
      } catch (err) {
        console.error('derive_from_bills_failed', {
          shopCode,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Apply the aggregated bill deltas via atomic increment() on
    // admin_aggregates AND atomic increment() on each affected
    // portal_customer.outstanding. Both are no-op if billDeltas is empty.
    if (billDeltas.length > 0) {
      // admin_aggregates: ONE write with summed transforms.
      await applyBillDeltasToAggregates(env, shopCode, billDeltas);

      // portal_customers.outstanding: group customerNameDelta by name and
      // apply per-customer.
      const byName = new Map<string, number>();
      for (const d of billDeltas) {
        if (!d.customerNameDelta) continue;
        const key = d.customerNameDelta.name.toLowerCase();
        byName.set(key, (byName.get(key) || 0) + d.customerNameDelta.delta);
      }
      if (byName.size > 0) {
        try {
          await applyCustomerOutstandingDeltas(env, shopCode, byName);
        } catch (err) {
          console.error('apply_customer_outstanding_failed', {
            shopCode,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Cursor advancement.
    //   incremental: max(cursorField) of returned docs, or keep old cursor
    //                if no new docs.
    //   reconcile:   max(cursorField) of any returned doc, or NOW() if no doc
    //                carries the field (legacy data).
    const maxSeen = docs.reduce<string | null>((acc, d) => {
      const v = d.data?.[cursorField];
      if (typeof v !== 'string') return acc;
      if (acc === null || v > acc) return v;
      return acc;
    }, null);

    const newCursor =
      maxSeen
        ?? (effectiveMode === 'reconcile' ? startIso : cursor);

    await sbSyncStateSuccess(env, shopCode, collection, {
      finishedAt: new Date().toISOString(),
      cursor: newCursor,
      docCount: docs.length,
    });

    return {
      collection,
      mode: effectiveMode,
      docCount: docs.length,
      ...(deletedCount !== undefined ? { deletedCount } : {}),
      durationMs: Date.now() - startMs,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sbSyncStateError(env, shopCode, collection, msg).catch(() => {});
    return {
      collection,
      mode,
      docCount: 0,
      durationMs: Date.now() - startMs,
      error: msg,
    };
  }
};


// ===========================================================================
// Supabase REST helpers.
// ===========================================================================

const sbHeaders = (env: Env, extra: Record<string, string> = {}): HeadersInit => ({
  apikey: env.SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
  ...extra,
});

const sbUrl = (env: Env, path: string) => `${env.SUPABASE_URL}/rest/v1/${path}`;

const sbCheck = async (r: Response, where: string): Promise<void> => {
  if (r.ok) return;
  const detail = await r.text().catch(() => '');
  throw new Error(`Supabase ${where} failed (${r.status}): ${detail}`);
};

interface ReplicaRow {
  shop_code: string;
  collection: string;
  firestore_id: string;
  data: Record<string, any>;
  source_updated_at: string;
  last_synced_at: string;
}

const sbUpsertReplica = async (env: Env, rows: ReplicaRow[]): Promise<void> => {
  const r = await fetch(
    sbUrl(env, 'replica_documents?on_conflict=shop_code,collection,firestore_id'),
    {
      method: 'POST',
      headers: sbHeaders(env, {
        Prefer: 'resolution=merge-duplicates,return=minimal',
      }),
      body: JSON.stringify(rows),
    },
  );
  await sbCheck(r, 'upsert replica_documents');
};

/** Delete replica rows whose last_synced_at < beforeIso. Returns the deleted
 *  rows (firestore_id + data) so callers — like the bills incremental
 *  aggregate path — can compute negative deltas for the disappeared docs. */
const sbDeleteStale = async (
  env: Env,
  shopCode: string,
  collection: string,
  beforeIso: string,
): Promise<Array<{ firestore_id: string; data: any }>> => {
  const filter = `shop_code=eq.${encodeURIComponent(shopCode)}` +
    `&collection=eq.${encodeURIComponent(collection)}` +
    `&last_synced_at=lt.${encodeURIComponent(beforeIso)}`;
  const r = await fetch(sbUrl(env, `replica_documents?${filter}&select=firestore_id,data`), {
    method: 'DELETE',
    headers: sbHeaders(env, { Prefer: 'return=representation' }),
  });
  await sbCheck(r, 'delete stale replica_documents');
  const rows = await r.json().catch(() => []) as Array<{ firestore_id: string; data: any }>;
  return Array.isArray(rows) ? rows : [];
};

/** Fetch existing replica rows by firestore_id. Used by the incremental
 *  aggregate path BEFORE upsert to know each bill's old state. */
const sbFetchReplicaByIds = async (
  env: Env,
  shopCode: string,
  collection: string,
  ids: string[],
): Promise<Map<string, any>> => {
  if (ids.length === 0) return new Map();
  const quoted = ids.map(id => `"${id.replace(/"/g, '\\"')}"`).join(',');
  const url = sbUrl(env,
    `replica_documents?shop_code=eq.${encodeURIComponent(shopCode)}` +
    `&collection=eq.${encodeURIComponent(collection)}` +
    `&firestore_id=in.(${encodeURIComponent(quoted)})` +
    `&select=firestore_id,data`);
  const r = await fetch(url, { headers: sbHeaders(env) });
  if (!r.ok) {
    console.warn('sb_fetch_replica_failed', { status: r.status });
    return new Map();
  }
  const rows = await r.json().catch(() => []) as Array<{ firestore_id: string; data: any }>;
  const map = new Map<string, any>();
  for (const row of rows) map.set(row.firestore_id, row.data);
  return map;
};

const sbGetCursor = async (
  env: Env,
  shopCode: string,
  collection: string,
): Promise<string | null> => {
  const r = await fetch(
    sbUrl(env,
      `sync_state?shop_code=eq.${encodeURIComponent(shopCode)}` +
      `&collection=eq.${encodeURIComponent(collection)}&select=cursor_updated_at`),
    { headers: sbHeaders(env) },
  );
  await sbCheck(r, 'sync_state read cursor');
  const rows = await r.json() as Array<{ cursor_updated_at: string | null }>;
  const raw = rows[0]?.cursor_updated_at ?? null;
  if (!raw) return null;
  // PostgREST returns timestamps as `2026-05-20T15:51:17.573+00:00` whereas
  // mobile writes ISO strings as `2026-05-20T15:51:17.573Z`. When Firestore
  // does a string-comparison query against the cursor, those two formats
  // don't compare correctly (`'Z'` > `'+'` at position 23). Re-format via
  // `new Date().toISOString()` so the cursor matches mobile's format exactly.
  try {
    return new Date(raw).toISOString();
  } catch {
    return raw;
  }
};

const sbSyncStateStart = async (
  env: Env,
  shopCode: string,
  collection: string,
  startIso: string,
): Promise<void> => {
  const r = await fetch(
    sbUrl(env, 'sync_state?on_conflict=shop_code,collection'),
    {
      method: 'POST',
      headers: sbHeaders(env, {
        Prefer: 'resolution=merge-duplicates,return=minimal',
      }),
      body: JSON.stringify([{
        shop_code: shopCode,
        collection,
        last_run_started_at: startIso,
      }]),
    },
  );
  await sbCheck(r, 'sync_state start');
};

const sbSyncStateSuccess = async (
  env: Env,
  shopCode: string,
  collection: string,
  args: { finishedAt: string; cursor: string | null; docCount: number },
): Promise<void> => {
  const cur = await fetch(
    sbUrl(env,
      `sync_state?shop_code=eq.${encodeURIComponent(shopCode)}` +
      `&collection=eq.${encodeURIComponent(collection)}&select=total_upserts`,
    ),
    { headers: sbHeaders(env) },
  );
  await sbCheck(cur, 'sync_state read total');
  const existing = (await cur.json()) as Array<{ total_upserts: number }>;
  const newTotal = (existing[0]?.total_upserts || 0) + args.docCount;

  const filter = `shop_code=eq.${encodeURIComponent(shopCode)}&collection=eq.${encodeURIComponent(collection)}`;
  const r = await fetch(sbUrl(env, `sync_state?${filter}`), {
    method: 'PATCH',
    headers: sbHeaders(env, { Prefer: 'return=minimal' }),
    body: JSON.stringify({
      last_run_finished_at: args.finishedAt,
      last_success_at: args.finishedAt,
      cursor_updated_at: args.cursor,
      last_run_doc_count: args.docCount,
      total_upserts: newTotal,
      last_error: null,
    }),
  });
  await sbCheck(r, 'sync_state success');
};

const sbSyncStateError = async (
  env: Env,
  shopCode: string,
  collection: string,
  errorMsg: string,
): Promise<void> => {
  const filter = `shop_code=eq.${encodeURIComponent(shopCode)}&collection=eq.${encodeURIComponent(collection)}`;
  const truncated = errorMsg.slice(0, 2000);
  const r = await fetch(sbUrl(env, `sync_state?${filter}`), {
    method: 'PATCH',
    headers: sbHeaders(env, { Prefer: 'return=minimal' }),
    body: JSON.stringify({
      last_run_finished_at: new Date().toISOString(),
      last_error: truncated,
    }),
  });
  await sbCheck(r, 'sync_state error');
};
