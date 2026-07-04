/**
 * Direct Firestore counts for bills — replaces the cron-derived
 * `pendingCount` / `totalBillCount` fields from admin_aggregates.
 *
 * Why direct:
 *   - Cron-based aggregate had 5-min lag → portal showed stale numbers
 *   - SQL function pulled from Supabase replica which itself lagged Firestore
 *   - Single source of truth (Firestore) eliminates these races
 *
 * Cost: 2 reads per refresh (one for total, one for acked). Both use
 * Firestore's getCountFromServer which is O(1)-ish.
 *
 * The actual Firestore queries live in firestoreSync.ts (fetchBillCounts),
 * which has access to the named Firebase app's Firestore instance. This
 * module just maintains the in-memory cache + React hook on top.
 */

import { useEffect, useState } from 'react';
import { fetchBillCounts as fetchFromFirestore } from './firestoreSync';

interface BillCounts {
  // counts
  total: number | null;
  acked: number | null;
  pending: number | null;
  // sums (from Firestore aggregations — replace cron-derived aggregate doc)
  totalBilled: number | null;
  totalRevenue: number | null;
  outstanding: number | null;  // totalBilled - totalRevenue
  loaded: boolean;
}

let totalCount: number | null = null;
let ackedCount: number | null = null;
let totalBilledSum: number | null = null;
let totalRevenueSum: number | null = null;
let optimisticAckedDelta = 0;
let optimisticTotalBilledDelta = 0;
let optimisticTotalRevenueDelta = 0;
let loaded = false;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

const notify = () => {
  for (const cb of listeners) {
    try { cb(); } catch { /* ignore */ }
  }
};

/**
 * Refetch from Firestore. Idempotent — if a fetch is already in-flight,
 * returns the same promise.
 */
export const refreshBillCounts = async (): Promise<void> => {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const { total, acked, totalBilled, totalRevenue } = await fetchFromFirestore();
      if (total !== null) totalCount = total;
      if (acked !== null) ackedCount = acked;
      if (totalBilled !== null) totalBilledSum = totalBilled;
      if (totalRevenue !== null) totalRevenueSum = totalRevenue;
      if (total !== null && acked !== null) {
        optimisticAckedDelta = 0;
        optimisticTotalBilledDelta = 0;
        optimisticTotalRevenueDelta = 0;
        loaded = true;
      }
      notify();
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
};

/** Optimistic delta for the acked count. Survives until next refresh. */
export const patchAckedDelta = (delta: number): void => {
  optimisticAckedDelta += delta;
  notify();
};

/** Optimistic delta for the total count (new mobile bill arrives, etc.). */
export const patchTotalDelta = (delta: number): void => {
  if (totalCount !== null) {
    totalCount = Math.max(0, totalCount + delta);
    notify();
  }
};

/** Optimistic delta for totalBilled (new bill added or deleted). */
export const patchTotalBilledDelta = (delta: number): void => {
  optimisticTotalBilledDelta += delta;
  notify();
};

/** Optimistic delta for totalRevenue (payment recorded or removed). */
export const patchTotalRevenueDelta = (delta: number): void => {
  optimisticTotalRevenueDelta += delta;
  notify();
};

export const getBillCounts = (): BillCounts => {
  if (totalCount === null || ackedCount === null) {
    return {
      total: null, acked: null, pending: null,
      totalBilled: null, totalRevenue: null, outstanding: null,
      loaded,
    };
  }
  const acked = Math.max(0, Math.min(totalCount, ackedCount + optimisticAckedDelta));
  const billed = (totalBilledSum ?? 0) + optimisticTotalBilledDelta;
  const revenue = (totalRevenueSum ?? 0) + optimisticTotalRevenueDelta;
  return {
    total: totalCount,
    acked,
    pending: Math.max(0, totalCount - acked),
    totalBilled: totalBilledSum !== null ? billed : null,
    totalRevenue: totalRevenueSum !== null ? revenue : null,
    outstanding: (totalBilledSum !== null && totalRevenueSum !== null)
      ? Math.max(0, billed - revenue)
      : null,
    loaded,
  };
};

/**
 * React hook — auto-refetches on mount, re-renders on any change.
 * Retries refresh every time it's called and counts aren't loaded yet,
 * so that if the FIRST mount fired before sync was ready, a later mount
 * will catch up.
 */
export const useBillCounts = (): BillCounts => {
  const [, force] = useState(0);
  useEffect(() => {
    const cb = () => force(n => n + 1);
    listeners.add(cb);
    // Always refresh on mount — even when already loaded — so navigating
    // between pages always lands on the latest Firestore count, not the
    // cached state from a previous mount. Cost is 2 Firestore reads.
    void refreshBillCounts();
    // If sync wasn't initialized yet (Firestore SDK not ready), keep
    // retrying every 1.5s until first successful load.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const attempt = () => {
      if (loaded || inFlight) return;
      void refreshBillCounts().then(() => {
        if (!loaded) timer = setTimeout(attempt, 1500);
      });
    };
    if (!loaded) timer = setTimeout(attempt, 1500);
    return () => {
      listeners.delete(cb);
      if (timer) clearTimeout(timer);
    };
  }, []);
  return getBillCounts();
};

/** Clear cached counts. Called on logout. */
export const clearBillCounts = (): void => {
  totalCount = null;
  ackedCount = null;
  totalBilledSum = null;
  totalRevenueSum = null;
  optimisticAckedDelta = 0;
  optimisticTotalBilledDelta = 0;
  optimisticTotalRevenueDelta = 0;
  loaded = false;
  notify();
};

if (typeof window !== 'undefined') {
  (window as any).__billmakerBillCounts = {
    get: getBillCounts,
    refresh: refreshBillCounts,
    clear: clearBillCounts,
  };
}
