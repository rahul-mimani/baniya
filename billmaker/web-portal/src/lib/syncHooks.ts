// React hooks built on top of firestoreSync's status callbacks.
//
// `useCollectionLoaded(name)` returns true once a given Firestore collection
// subscription has fired its first snapshot this session. Use this to gate
// skeleton vs. real-row rendering in admin views — store.bills is hydrated
// from localStorage so it's never "empty during boot", but cached data is
// stale and can be misleading; we'd rather show skeletons until the live
// snapshot lands.

import { useSyncExternalStore } from 'react';
import { getSyncStatus, onSyncStatusChange } from './firestoreSync';

// Module-level cache of the loaded state per collection. useSyncExternalStore
// requires a STABLE reference per snapshot — re-computing an object each call
// would trigger an infinite render loop. We store the value as a plain bool
// per name and recompute only when status actually changes.
const loadedCache = new Map<string, boolean>();

const recomputeLoaded = (collection: string): boolean => {
  const state = getSyncStatus().collections[collection];
  return state === 'received' || state === 'error';
};

// Refresh cache on every status change so subsequent reads return the latest.
onSyncStatusChange(() => {
  for (const name of loadedCache.keys()) {
    loadedCache.set(name, recomputeLoaded(name));
  }
});

const getLoaded = (collection: string): boolean => {
  if (!loadedCache.has(collection)) {
    loadedCache.set(collection, recomputeLoaded(collection));
  }
  return loadedCache.get(collection)!;
};

const subscribe = (cb: () => void): (() => void) => onSyncStatusChange(() => cb());

/**
 * True once the named collection has received its first snapshot (or errored
 * out — we don't want to wait forever on a broken subscription). False while
 * still in 'idle' or 'subscribed' state.
 */
export const useCollectionLoaded = (collection: string): boolean => {
  return useSyncExternalStore(
    subscribe,
    () => getLoaded(collection),
    () => getLoaded(collection),
  );
};
