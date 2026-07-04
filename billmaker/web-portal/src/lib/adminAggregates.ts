// Admin aggregates — single-doc subscription, replaces inline reduces over
// store.bills in the admin dashboards.
//
// The source doc is shops/<shop>/_meta/admin_aggregates and is maintained by
// the auth-service Worker (see auth-service/src/lib/aggregates.ts). The portal
// subscribes to it via Firestore onSnapshot in firestoreSync.ts and pipes the
// raw doc into `applyAdminAggregatesSnapshot` here.
//
// Why a separate state slice (not part of the main `store`):
//   - Doesn't need localStorage persistence — the doc is the source of truth.
//   - Has its own loading semantics ("waiting for first snapshot" vs "loaded").
//   - Keeps the main store free of derived/server-computed values.

import { useSyncExternalStore } from 'react';

// ---------------------------------------------------------------------------
// Doc shape — mirrors auth-service/src/lib/aggregates.ts AdminAggregates.
// ---------------------------------------------------------------------------
export interface CustomerOutstandingEntry {
  /** Display name (canonical from portal_customers, or raw mobile name). */
  name: string;
  outstanding: number;
  /** true → key is portal_customers.id. false → key is raw customerName. */
  hasId: boolean;
}

export interface AdminAggregates {
  totalBilled: number;
  totalRevenue: number;
  outstanding: number;
  totalBillCount: number;
  pendingCount: number;
  /**
   * Authoritative total of portal_products in Firestore. Set by the worker's
   * aggregate recompute, optimistically patched locally via productCountDelta
   * on add/delete. Powers the Overview "Products" stat without depending on
   * the windowed live subscription.
   */
  productCount: number;
  /**
   * Authoritative total of portal_customers in Firestore. Atomic-incremented
   * on portal addCustomer / archiveCustomer. Powers Overview "Customers" tile
   * without waiting for portal_customers subscription to load.
   */
  customerCount: number;
  /**
   * Authoritative total of portal_deals in Firestore. Atomic-incremented on
   * portal addDeal / deleteDeal. Powers Overview "Active deals" tile.
   */
  dealCount: number;
  perCustomerOutstanding: Record<string, CustomerOutstandingEntry>;
  lastRecomputedAt: string;
  shopCode: string;
}


// ---------------------------------------------------------------------------
// Subscription store.
// ---------------------------------------------------------------------------
let current: AdminAggregates | null = null;
let loaded = false;
// Bumped on every mutation (snapshot apply or optimistic patch). The stable
// snapshot uses this as the cache-invalidation key so React re-renders even
// when patches don't change `lastRecomputedAt`.
let version = 0;
const listeners = new Set<() => void>();

const emit = () => {
  for (const fn of listeners) {
    try { fn(); } catch {}
  }
};

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

const snapshot = (): AdminAggregates | null => current;
const getLoaded = (): boolean => loaded;


// ---------------------------------------------------------------------------
// Optimistic local patch — apply a delta to the current aggregate without
// waiting for the server. Used after admin actions in the portal (ack, bulk
// release, settle outstanding) so the dashboard numbers update INSTANTLY.
//
// The authoritative aggregate refresh from the Worker arrives a few seconds
// later via the existing onSnapshot — that overwrites this optimistic state
// with the correct values. If the patch was off (e.g. concurrent ack from
// another device), the next snapshot corrects it.
//
// Safe to call when `current` is null (no doc yet) — the patch is dropped
// and the next snapshot will populate fresh values.
// ---------------------------------------------------------------------------
export interface AdminAggregatesPatch {
  pendingCountDelta?: number;
  totalBilledDelta?: number;
  totalRevenueDelta?: number;
  totalBillCountDelta?: number;
  /**
   * Increment/decrement the total product count. +1 when admin adds a
   * product, -N when bulk-deleting phantoms. The next worker recompute
   * overwrites with the true count, so optimistic drift self-corrects.
   */
  productCountDelta?: number;
  /**
   * Customer count. +1 when admin creates a portal_customer, -1 on archive.
   * Read by the Overview "Customers" tile to avoid a separate count query.
   */
  customerCountDelta?: number;
  /**
   * Deal count. +1 when admin creates a deal, -1 on delete.
   * Read by the Overview "Active deals" tile.
   */
  dealCountDelta?: number;
  /**
   * Per-customer outstanding deltas, keyed by customer id (or raw name —
   * mirrors the lookup in AdminCustomers). Positive = outstanding grew.
   */
  perCustomerOutstandingDelta?: Record<string, number>;
}

/**
 * Persist a delta to the Firestore admin_aggregates doc using atomic
 * increment(). Fire-and-forget — failure doesn't undo the in-memory patch.
 *
 * After this write succeeds, the subscription's next snapshot will deliver
 * the updated values. applyAdminAggregatesSnapshot then replaces `current`
 * with the same values — no snap-back.
 */
const persistAggregateDelta = async (delta: AdminAggregatesPatch): Promise<void> => {
  try {
    const { getSyncState } = await import('./firestoreSync');
    const { db, shopCode } = getSyncState();
    if (!db || !shopCode) return;
    const { doc, updateDoc, increment, serverTimestamp } = await import('firebase/firestore');
    const ref = doc(db, `shops/${shopCode}/_meta/admin_aggregates`);
    const update: Record<string, any> = {};
    if (delta.pendingCountDelta)   update.pendingCount   = increment(delta.pendingCountDelta);
    if (delta.totalBilledDelta)    update.totalBilled    = increment(delta.totalBilledDelta);
    if (delta.totalRevenueDelta)   update.totalRevenue   = increment(delta.totalRevenueDelta);
    if (delta.totalBillCountDelta) update.totalBillCount = increment(delta.totalBillCountDelta);
    if (delta.productCountDelta)   update.productCount   = increment(delta.productCountDelta);
    if (delta.customerCountDelta)  update.customerCount  = increment(delta.customerCountDelta);
    if (delta.dealCountDelta)      update.dealCount      = increment(delta.dealCountDelta);
    // Outstanding is derived (billed − revenue). Increment together so the
    // doc stays internally consistent.
    const outstandingDelta = (delta.totalBilledDelta || 0) - (delta.totalRevenueDelta || 0);
    if (outstandingDelta) update.outstanding = increment(outstandingDelta);
    if (Object.keys(update).length === 0) return;
    update.lastRecomputedAt = new Date().toISOString();
    update.lastModified = serverTimestamp();
    await updateDoc(ref, update);
  } catch (err) {
    console.warn('[adminAggregates] persistAggregateDelta failed', err);
  }
};

export const patchAdminAggregates = (delta: AdminAggregatesPatch): void => {
  if (!current) return;
  // Persist the same delta to Firestore atomically so other devices see it
  // immediately AND the subscription replay reapplies these exact values.
  void persistAggregateDelta(delta);
  const next: AdminAggregates = {
    ...current,
    pendingCount: Math.max(0, current.pendingCount + (delta.pendingCountDelta || 0)),
    totalBilled: current.totalBilled + (delta.totalBilledDelta || 0),
    totalRevenue: current.totalRevenue + (delta.totalRevenueDelta || 0),
    totalBillCount: Math.max(0, current.totalBillCount + (delta.totalBillCountDelta || 0)),
    productCount: Math.max(0, current.productCount + (delta.productCountDelta || 0)),
    customerCount: Math.max(0, (current.customerCount ?? 0) + (delta.customerCountDelta || 0)),
    dealCount: Math.max(0, (current.dealCount ?? 0) + (delta.dealCountDelta || 0)),
    outstanding: current.outstanding + ((delta.totalBilledDelta || 0) - (delta.totalRevenueDelta || 0)),
    perCustomerOutstanding: { ...current.perCustomerOutstanding },
  };
  if (delta.perCustomerOutstandingDelta) {
    for (const [key, amt] of Object.entries(delta.perCustomerOutstandingDelta)) {
      const cur = next.perCustomerOutstanding[key];
      const updated = (cur?.outstanding ?? 0) + amt;
      if (updated <= 0) {
        delete next.perCustomerOutstanding[key];
      } else {
        next.perCustomerOutstanding[key] = {
          name: cur?.name ?? key,
          outstanding: updated,
          hasId: cur?.hasId ?? false,
        };
      }
    }
  }
  current = next;
  version++;
  emit();
};


// ---------------------------------------------------------------------------
// Called by firestoreSync.ts when the _meta/admin_aggregates doc fires.
// Pass `null` when the doc doesn't exist (fresh shop) — UI falls back to zeros.
// ---------------------------------------------------------------------------
export const applyAdminAggregatesSnapshot = (raw: any | null): void => {
  loaded = true;
  if (!raw || typeof raw !== 'object') {
    current = null;
    version++;
    emit();
    return;
  }
  const perCust: Record<string, CustomerOutstandingEntry> = {};
  const rawCust = raw.perCustomerOutstanding;
  if (rawCust && typeof rawCust === 'object') {
    for (const [k, v] of Object.entries(rawCust as Record<string, any>)) {
      if (v && typeof v === 'object') {
        perCust[k] = {
          name: typeof v.name === 'string' ? v.name : k,
          outstanding: num(v.outstanding),
          hasId: !!v.hasId,
        };
      }
    }
  }
  current = {
    totalBilled: num(raw.totalBilled),
    totalRevenue: num(raw.totalRevenue),
    outstanding: num(raw.outstanding),
    totalBillCount: int(raw.totalBillCount),
    pendingCount: int(raw.pendingCount),
    productCount: int(raw.productCount),
    customerCount: int(raw.customerCount),
    dealCount: int(raw.dealCount),
    perCustomerOutstanding: perCust,
    lastRecomputedAt: typeof raw.lastRecomputedAt === 'string' ? raw.lastRecomputedAt : '',
    shopCode: typeof raw.shopCode === 'string' ? raw.shopCode : '',
  };
  version++;
  emit();
};


// ---------------------------------------------------------------------------
// React hook — returns { value, loaded }.
//   value:  the aggregates, or null if the doc hasn't loaded / doesn't exist
//   loaded: true once the first snapshot has fired (so UI can distinguish
//           "loading…" from "loaded but doc is empty")
// ---------------------------------------------------------------------------
export interface AdminAggregatesState {
  value: AdminAggregates | null;
  loaded: boolean;
}

const stateSnapshot = (): AdminAggregatesState => ({
  value: snapshot(),
  loaded: getLoaded(),
});

// Cache the stateSnapshot result so useSyncExternalStore doesn't see a new
// object reference every render — would trigger an infinite update loop.
// Key bumps on every mutation via `version`, including optimistic patches.
let cachedState: AdminAggregatesState = stateSnapshot();
let cachedVersion = -1;
const stableSnapshot = (): AdminAggregatesState => {
  if (cachedVersion !== version) {
    cachedVersion = version;
    cachedState = stateSnapshot();
  }
  return cachedState;
};

export const useAdminAggregates = (): AdminAggregatesState =>
  useSyncExternalStore(subscribe, stableSnapshot, stableSnapshot);


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
const int = (v: any): number => Math.floor(num(v));
