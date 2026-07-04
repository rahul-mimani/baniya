// src/storage/syncState.ts
//
// Persists the "what was in remote last time?" tracking sets across app
// restarts. Without this, mobile's reconcile logic resets on every launch and
// can't distinguish "deleted on another device" from "local-only pending push"
// — so admin-side deletions don't propagate after a fresh app start, and worse,
// the bill-replay loop re-creates customer/product names that admin had just
// deleted (resurrection bug).
//
// The file lives in APP_DIR (app-private internal storage) and contains a
// single JSON object with one array of IDs/names per tracked collection.
import { Filesystem, Encoding } from '@capacitor/filesystem';
import { APP_DIR, initFile } from './paths';

const FILE_NAME = 'sync_state.json';

export interface SyncState {
  /** Bill IDs that were in the most recent remote `bills` snapshot. */
  bills?: string[];
  /** Payment IDs that were in the most recent remote `payments` snapshot. */
  payments?: string[];
  /** Profile IDs from the most recent `profiles` snapshot. */
  profiles?: string[];
  /** Lowercased customer names from the most recent `customers` snapshot. */
  customers?: string[];
  /** Lowercased product names from the most recent `products` snapshot. */
  products?: string[];
  /** Tombstone IDs we've already applied — used to make portal_deletions
   *  processing idempotent across snapshot fires and app restarts. */
  processedDeletions?: string[];
  /**
   * Customer names that admin has explicitly deleted. Bills referencing these
   * names AND any addCustomer call with these names are blocked indefinitely
   * — this is what stops the bill-replay loop from resurrecting a deleted
   * customer back into the canonical `customers/<slug>` Firestore collection.
   * Lowercased + slug-form variants are both stored.
   */
  blockedCustomerNames?: string[];
  /** Same for product names. */
  blockedProductNames?: string[];
  /** Bill IDs that admin has explicitly deleted. Even if mobile's reconcile
   *  fails to detect the removal, these IDs are dropped from local bills.json
   *  on every sync. */
  blockedBillIds?: string[];
  /**
   * Realtime catchup cursor — the highest `last_synced_at` timestamp this
   * device has observed via Supabase Realtime per collection (ISO 8601).
   * On reconnect (after background → foreground or network drop), we REST-
   * fetch any rows with `last_synced_at > cursor` BEFORE re-subscribing so
   * we don't miss events that arrived while we were disconnected.
   *
   * Per-collection so each catchup query is small (only what changed in
   * that table). Keys: 'bills' | 'profiles' | '_meta' | 'customers' |
   * 'products' | 'portal_deletions'.
   */
  realtimeCursors?: Record<string, string>;
}

export const initSyncState = async () => {
  await initFile(FILE_NAME, '{}');
};

export const getSyncState = async (): Promise<SyncState> => {
  try {
    const result = await Filesystem.readFile({
      path: FILE_NAME,
      directory: APP_DIR,
      encoding: Encoding.UTF8,
    });
    const data = typeof result.data === 'string' ? result.data : await result.data.text();
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as SyncState;
  } catch {
    return {};
  }
};

/** Merge-write — only the keys in `patch` are updated. */
export const updateSyncState = async (patch: Partial<SyncState>): Promise<void> => {
  const current = await getSyncState();
  const next: SyncState = { ...current, ...patch };
  await Filesystem.writeFile({
    path: FILE_NAME,
    data: JSON.stringify(next),
    directory: APP_DIR,
    encoding: Encoding.UTF8,
  });
};

/**
 * Lazy-cached read of the block lists. Cleared whenever the lists are
 * updated — call invalidateBlockCache() after any updateSyncState that
 * touches the blocked* keys.
 */
let blockCache: {
  customerNames: Set<string>;
  productNames: Set<string>;
  billIds: Set<string>;
} | null = null;

export const invalidateBlockCache = (): void => { blockCache = null; };

export const getBlockLists = async () => {
  if (blockCache) return blockCache;
  const s = await getSyncState();
  blockCache = {
    customerNames: new Set((s.blockedCustomerNames || []).map(n => n.toLowerCase())),
    productNames: new Set((s.blockedProductNames || []).map(n => n.toLowerCase())),
    billIds: new Set(s.blockedBillIds || []),
  };
  return blockCache;
};
