// Admin aggregates — kept in Firestore as a single doc at
//   shops/<shop>/_meta/admin_aggregates
//
// Update strategy: full recompute via Supabase SQL function. Triggered by the
// 5-min cron whenever bills/payments actually changed in the just-completed
// sync cycle. Skipped entirely on quiet cycles.
//
// Why always-recompute instead of deltas:
//   - The aggregate SQL runs on indexed JSONB and returns in ~50ms even at
//     200k+ rows. Cost is dominated by the Firestore write, not the SQL.
//   - Always-accurate: no drift, no edge cases (customer renames, edits,
//     deletes-then-re-creates, etc.).
//   - Uses portal_customer.id as the per-customer key (resolved in SQL via
//     name/alias lookup) — single source of truth.
//
// The doc is never served by an API route — the portal subscribes directly
// to the Firestore doc. Keeps admin numbers off the public-ish API.

import type { Env } from '../types';
import { setDocument, incrementDocumentFields } from './firestore';

const AGG_DOC_PATH = (shop: string) => `shops/${shop}/_meta/admin_aggregates`;

// ---------------------------------------------------------------------------
// Aggregate doc shape (mirrors what the SQL function returns + audit fields).
// ---------------------------------------------------------------------------
export interface CustomerOutstandingEntry {
  /** portal_customer name (or raw mobile customerName for unmatched). */
  name: string;
  /** Outstanding amount: bill total minus paid. */
  outstanding: number;
  /** True if `key` is a real portal_customer.id; false if it's a raw name fallback. */
  hasId: boolean;
}

export interface AdminAggregates {
  totalBilled: number;
  totalRevenue: number;
  outstanding: number;
  totalBillCount: number;
  pendingCount: number;
  /**
   * Total portal_products in Firestore (authoritative — covers ALL products,
   * not just what the windowed live subscription has delivered). Powers the
   * Overview "Products" stat. Recomputed via a count query against the
   * Supabase replica (which mirrors portal_products one-to-one). Falls back
   * to 0 if the count query fails.
   */
  productCount: number;
  /**
   * Total portal_customers + total portal_deals. Set by the SQL function on
   * emergency reconcile; routine maintenance happens via atomic increment
   * from the portal (addCustomer/addDeal/archive/restore/deleteDeal).
   */
  customerCount: number;
  dealCount: number;
  /**
   * Keyed by portal_customer.id when matched, falls back to raw customerName
   * when no portal_customer exists. Matches the `b.customerId || b.customerName`
   * pattern admin uses on the client (AdminCustomers.tsx).
   */
  perCustomerOutstanding: Record<string, CustomerOutstandingEntry>;
  lastRecomputedAt: string;
  shopCode: string;
}


// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Force-recompute. Used by the manual reconcile button (sync.ts reconcile path)
 * and on first-ever run (when aggregate doc doesn't exist yet).
 */
export const recomputeAggregatesFromSupabase = async (
  env: Env,
  shopCode: string,
): Promise<AdminAggregates> => {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_aggregates_recompute`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_shop: shopCode }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`admin_aggregates_recompute failed (${r.status}): ${detail}`);
  }

  // After Phase 5 cleanup, the SQL function only returns perCustomerOutstanding.
  // Other fields (totalBilled, totalRevenue, totalBillCount, pendingCount,
  // outstanding) are maintained by portal+mobile atomic increment, not here.
  const data = await r.json() as {
    totalBilled?: number | string;
    totalRevenue?: number | string;
    outstanding?: number | string;
    totalBillCount?: number;
    pendingCount?: number;
    customerCount?: number;
    dealCount?: number;
    perCustomerOutstanding: Record<string, {
      name: string;
      outstanding: number | string;
      hasId: boolean;
    }>;
  };

  const perCust: Record<string, CustomerOutstandingEntry> = {};
  for (const [key, val] of Object.entries(data.perCustomerOutstanding || {})) {
    perCust[key] = {
      name: typeof val?.name === 'string' ? val.name : key,
      outstanding: num(val?.outstanding),
      hasId: !!val?.hasId,
    };
  }

  // Product count — separate Supabase HEAD-with-count query. Doesn't fail
  // the whole recompute if it errors (productCount falls back to 0).
  const productCount = await fetchProductCount(env, shopCode);

  const now = new Date().toISOString();
  const agg: AdminAggregates = {
    totalBilled: num(data.totalBilled),
    totalRevenue: num(data.totalRevenue),
    outstanding: num(data.outstanding),
    totalBillCount: data.totalBillCount || 0,
    pendingCount: data.pendingCount || 0,
    productCount,
    customerCount: data.customerCount || 0,
    dealCount: data.dealCount || 0,
    perCustomerOutstanding: perCust,
    lastRecomputedAt: now,
    shopCode,
  };

  // Phase B: Mobile no longer maintains admin_aggregates incrementally
  // (it writes only to bills/<id>, server derives the rest). After bills
  // sync runs, the worker calls this function and writes the resulting
  // doc to Firestore so the admin dashboard sees fresh numbers within
  // the cron cadence (2 min) or sub-2s via write-trigger.
  //
  // Portal still maintains admin_aggregates via atomic increment for its
  // own admin actions (ack, settleBills, archiveCustomer) — those writes
  // race with this one but Firestore merges fields independently. Worst
  // case after a race: portal's optimistic patch is replaced 2 min later
  // by the worker's authoritative recompute. Acceptable.
  //
  // customer.outstanding (per portal_customer doc) is still maintained
  // by portal+mobile atomic increment via incrementCustomerByName. The
  // worker doesn't touch it.
  await writeAdminAggregatesDoc(env, shopCode, agg);

  return agg;
};

/**
 * Write the admin_aggregates doc to Firestore — full replace. Used by the
 * emergency-reconcile path only (admin clicks "Recompute aggregates"). Routine
 * updates go through applyBillDeltasToAggregates() below for atomic increments.
 */
const writeAdminAggregatesDoc = async (
  env: Env,
  shopCode: string,
  agg: AdminAggregates,
): Promise<void> => {
  try {
    await setDocument(env, AGG_DOC_PATH(shopCode), {
      totalBilled: agg.totalBilled,
      totalRevenue: agg.totalRevenue,
      outstanding: agg.outstanding,
      totalBillCount: agg.totalBillCount,
      pendingCount: agg.pendingCount,
      productCount: agg.productCount,
      customerCount: agg.customerCount,
      dealCount: agg.dealCount,
      perCustomerOutstanding: agg.perCustomerOutstanding,
      lastRecomputedAt: agg.lastRecomputedAt,
      shopCode: agg.shopCode,
    });
  } catch (err) {
    console.error('admin_aggregates_write_failed', {
      shopCode,
      err: err instanceof Error ? err.message : String(err),
    });
  }
};


// ===========================================================================
// Phase B: incremental aggregate maintenance.
//
// Replaces the full SQL recompute on every bills sync. After the worker
// upserts changed bills to the Supabase replica, it computes per-bill deltas
// (new state vs old state) and applies atomic increment() to the
// admin_aggregates Firestore doc. Mirrors exactly what the portal's
// patchAdminAggregates → persistAggregateDelta does for portal-driven actions.
//
// This is the path mobile-originated changes flow through. Portal actions
// continue to call patchAdminAggregates directly for instant optimistic UI;
// after worker sync that delta is applied AGAIN (idempotent on increment, but
// to avoid double-counting we should NOT race — see comment in sync.ts where
// we gate by docCount).
// ===========================================================================

/** Per-bill delta computed from old replica state vs new Firestore state. */
export interface BillAggregateDelta {
  totalBilledDelta:    number;  // change in bill.total
  totalRevenueDelta:   number;  // change in sum(bill.payments[].amount)
  totalBillCountDelta: number;  // +1 if new, -1 if deleted, 0 if update
  pendingCountDelta:   number;  // -1 when becoming acked, +1 when becoming unacked or newly created unacked
  /** Customer name (lowercased + trimmed) and per-customer outstanding delta.
   *  Used by the worker to also atomic-increment portal_customers.outstanding. */
  customerNameDelta:   { name: string; delta: number } | null;
}

const sumEmbeddedPayments = (data: any): number => {
  if (!data || !Array.isArray(data.payments)) return 0;
  let sum = 0;
  for (const p of data.payments) {
    if (p && typeof p === 'object') {
      const v = Number(p.amount);
      if (isFinite(v)) sum += v;
    }
  }
  return sum;
};

/**
 * Compute the per-bill aggregate delta from old vs new doc state. Either side
 * being null means insert (old=null) or delete (new=null).
 */
export const computeBillDelta = (
  oldData: any | null,
  newData: any | null,
): BillAggregateDelta => {
  const oldTotal = oldData ? Number(oldData.total) || 0 : 0;
  const newTotal = newData ? Number(newData.total) || 0 : 0;
  const oldPaid  = sumEmbeddedPayments(oldData);
  const newPaid  = sumEmbeddedPayments(newData);
  const oldAck   = oldData?.acknowledged === true;
  const newAck   = newData?.acknowledged === true;

  // Bill count: +1 on insert, -1 on delete, 0 on update.
  let billCountDelta = 0;
  if (!oldData && newData)  billCountDelta = 1;
  if (oldData && !newData)  billCountDelta = -1;

  // Pending contribution: 1 if the bill exists and is unacked, else 0.
  // The delta is new_contribution − old_contribution. This naturally handles:
  //   - new unacked bill:    0 → 1 = +1
  //   - new acked bill:      0 → 0 = 0
  //   - toggle ack:          1 → 0 = -1   (un-toggle: 0 → 1 = +1)
  //   - delete unacked bill: 1 → 0 = -1
  //   - delete acked bill:   0 → 0 = 0
  const oldPendingContrib = (oldData && !oldAck) ? 1 : 0;
  const newPendingContrib = (newData && !newAck) ? 1 : 0;
  const pendingCountDelta = newPendingContrib - oldPendingContrib;

  // Per-customer outstanding delta. Customer name should usually be the same
  // in old + new; if it changed, the bill effectively moved between
  // customers — caller handles that case by emitting two deltas. We return
  // ONE entry here for the new customer (or old if delete).
  const customerName = (newData?.customerName ?? oldData?.customerName ?? '').trim();
  const oldOutstanding = oldTotal - oldPaid;
  const newOutstanding = newTotal - newPaid;
  const customerNameDelta = customerName
    ? { name: customerName, delta: newOutstanding - oldOutstanding }
    : null;

  return {
    totalBilledDelta:    newTotal - oldTotal,
    totalRevenueDelta:   newPaid - oldPaid,
    totalBillCountDelta: billCountDelta,
    pendingCountDelta,
    customerNameDelta,
  };
};

/**
 * Aggregate per-bill deltas into ONE atomic increment write against the
 * admin_aggregates Firestore doc. Fires only when at least one numeric delta
 * is non-zero. Best-effort: logs + swallows errors so a hiccup doesn't fail
 * the calling sync job (cron will retry naturally).
 */
export const applyBillDeltasToAggregates = async (
  env: Env,
  shopCode: string,
  deltas: BillAggregateDelta[],
): Promise<void> => {
  if (deltas.length === 0) return;
  const summed = deltas.reduce(
    (acc, d) => {
      acc.totalBilledDelta    += d.totalBilledDelta;
      acc.totalRevenueDelta   += d.totalRevenueDelta;
      acc.totalBillCountDelta += d.totalBillCountDelta;
      acc.pendingCountDelta   += d.pendingCountDelta;
      return acc;
    },
    { totalBilledDelta: 0, totalRevenueDelta: 0, totalBillCountDelta: 0, pendingCountDelta: 0 },
  );
  // outstanding is derived from billed - revenue.
  const outstandingDelta = summed.totalBilledDelta - summed.totalRevenueDelta;
  try {
    await incrementDocumentFields(
      env,
      AGG_DOC_PATH(shopCode),
      {
        totalBilled:    summed.totalBilledDelta,
        totalRevenue:   summed.totalRevenueDelta,
        outstanding:    outstandingDelta,
        totalBillCount: summed.totalBillCountDelta,
        pendingCount:   summed.pendingCountDelta,
      },
      // Stamp lastRecomputedAt so AdminCustomers' "trust customer.outstanding
      // only when fresh" check works correctly downstream.
      {
        lastRecomputedAt: new Date().toISOString(),
        shopCode,
      },
    );
  } catch (err) {
    console.error('apply_bill_deltas_failed', {
      shopCode,
      err: err instanceof Error ? err.message : String(err),
    });
  }
};

// Supabase exposes COUNT via PostgREST's `Prefer: count=exact` header on a
// HEAD/GET — returns the count in the `Content-Range` header without
// shipping any rows. Cheap (one DB roundtrip). Falls back to 0 on any
// error so a flaky count doesn't fail the entire aggregate recompute.
const fetchProductCount = async (env: Env, shopCode: string): Promise<number> => {
  try {
    const r = await fetch(
      `${env.SUPABASE_URL}/rest/v1/portal_products?shop_code=eq.${encodeURIComponent(shopCode)}&select=id`,
      {
        method: 'HEAD',
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          Prefer: 'count=exact',
          'Range-Unit': 'items',
        },
      },
    );
    if (!r.ok) return 0;
    // Content-Range header looks like: "0-9/418" or "*/418"
    const range = r.headers.get('content-range') || '';
    const total = range.split('/')[1];
    const n = parseInt(total, 10);
    return isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
};


// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const num = (v: any): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }
  return 0;
};
