/**
 * Product cache — explicit, IndexedDB-backed cache for portal_products.
 *
 * Lifecycle:
 *   - Init: open the DB, load all rows into in-memory Map
 *   - Put/Delete: update the Map AND IndexedDB
 *   - Clear: wipe both (called on logout)
 *
 * The in-memory Map is the hot read path — AdminProducts reads from it
 * synchronously. IndexedDB is just persistence so a page reload doesn't
 * require re-fetching from Firestore.
 *
 * Why NOT use Firestore SDK's native cache:
 *   - The SDK's cache is tied to live subscriptions; we want to drop live
 *     subscriptions entirely (per the user's architecture spec)
 *   - We need explicit "clear on logout" semantics, which the SDK's cache
 *     doesn't give us (it persists across logouts to save reads)
 *
 * Keyed by productKey() (SHA-256 hex of normalized name). Same key as the
 * Firestore doc id — direct lookup, no translation.
 */

import type { Product } from '../types';

const DB_NAME = 'billmaker-portal-cache';
const DB_VERSION = 1;
const STORE_PRODUCTS = 'products';

// TTL controls when the in-memory snapshot is considered "fresh enough" to
// skip a Firestore refetch on AdminProducts mount. 30 min is the chosen
// default — long enough that back-and-forth navigation within a session is
// free, short enough that a worker-auto-created product (from mobile bill
// activity) shows up reasonably soon.
const TTL_MS = 30 * 60 * 1000;

// Persisted timestamp key in localStorage. We keep TTL state on the local
// browser only — not inside IndexedDB — because IDB is per-origin and we
// want one TTL clock per browser tab/session.
const TTL_STORAGE_KEY = 'billmaker-portal-cache-updatedAt';

let dbInstance: IDBDatabase | null = null;
let inMemory = new Map<string, Product>();
let initPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

const setLastUpdated = (when: number): void => {
  try { localStorage.setItem(TTL_STORAGE_KEY, String(when)); } catch { /* private mode */ }
};
const getLastUpdated = (): number => {
  try {
    const raw = localStorage.getItem(TTL_STORAGE_KEY);
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
};

/** True if the cache was populated within the TTL window. */
export const isCacheFresh = (): boolean => {
  if (inMemory.size === 0) return false;
  const since = Date.now() - getLastUpdated();
  return since < TTL_MS;
};

/**
 * Invalidate the freshness timestamp without clearing the cache itself. Next
 * mount will refetch. Called explicitly when admin edits a product locally
 * to ensure subsequent visits revalidate (in case other devices saw the
 * change via worker derive).
 */
export const invalidateFreshness = (): void => {
  setLastUpdated(0);
};

const notify = () => {
  for (const cb of listeners) {
    try { cb(); } catch { /* ignore listener errors */ }
  }
};

/** Open the IndexedDB connection, creating the schema on first run. */
const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PRODUCTS)) {
        db.createObjectStore(STORE_PRODUCTS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/**
 * Initialize: open DB, load all rows into the in-memory Map.
 * Safe to call multiple times — only opens once.
 */
export const initProductCache = async (): Promise<void> => {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (typeof indexedDB === 'undefined') {
      // SSR / Node — cache is in-memory only.
      return;
    }
    try {
      dbInstance = await openDb();
      // Load everything into the Map for fast sync reads.
      await new Promise<void>((resolve, reject) => {
        const tx = dbInstance!.transaction(STORE_PRODUCTS, 'readonly');
        const store = tx.objectStore(STORE_PRODUCTS);
        const req = store.getAll();
        req.onsuccess = () => {
          inMemory.clear();
          for (const row of req.result as Product[]) {
            if (row?.id) inMemory.set(row.id, row);
          }
          resolve();
        };
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.warn('[productCache] init failed', err);
      // Continue with empty Map — cache becomes effectively in-memory-only.
    }
  })();
  return initPromise;
};

/** Insert / update one product in cache. Idempotent. */
export const cachePut = async (product: Product): Promise<void> => {
  if (!product?.id) return;
  inMemory.set(product.id, product);
  notify();
  if (!dbInstance) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = dbInstance!.transaction(STORE_PRODUCTS, 'readwrite');
      tx.objectStore(STORE_PRODUCTS).put(product);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[productCache] put failed', err);
  }
};

/** Batch insert / update. Single transaction. Stamps the cache-fresh TTL. */
export const cachePutMany = async (products: Product[]): Promise<void> => {
  if (products.length === 0) return;
  for (const p of products) {
    if (p?.id) inMemory.set(p.id, p);
  }
  // Stamp ONLY on the bulk-load path (from fetchPortalProductsPage). Single
  // cachePut() doesn't stamp because that fires from local admin edits and
  // we WANT the next mount to revalidate other-device changes.
  setLastUpdated(Date.now());
  notify();
  if (!dbInstance) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = dbInstance!.transaction(STORE_PRODUCTS, 'readwrite');
      const store = tx.objectStore(STORE_PRODUCTS);
      for (const p of products) {
        if (p?.id) store.put(p);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[productCache] putMany failed', err);
  }
};

/** Remove one product from cache. */
export const cacheDelete = async (id: string): Promise<void> => {
  inMemory.delete(id);
  notify();
  if (!dbInstance) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = dbInstance!.transaction(STORE_PRODUCTS, 'readwrite');
      tx.objectStore(STORE_PRODUCTS).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[productCache] delete failed', err);
  }
};

/**
 * Wipe all products. Called on logout.
 *
 * Aggressive: closes the open IDB connection and DELETES the entire database.
 * Reasons:
 *   - A simple object-store clear is async and gets aborted if the page
 *     navigates (e.g., logout redirects to /login). Old data lingers.
 *   - deleteDatabase is atomic — once it returns, the DB is gone, no race.
 *   - initPromise reset → next initProductCache opens a fresh (empty) DB.
 */
export const cacheClear = async (): Promise<void> => {
  const hadInMemory = inMemory.size;
  inMemory.clear();
  // Also clear the freshness timestamp so a re-login starts fresh.
  try { localStorage.removeItem(TTL_STORAGE_KEY); } catch { /* private mode */ }
  notify();
  console.info('[productCache] cleared in-memory', { inMemoryCount: hadInMemory });

  if (typeof indexedDB === 'undefined') return;

  // Use objectStore.clear() inside a transaction — works reliably even when
  // another browser tab still has the DB open, or when our own connection
  // is leaked from a previous session. Previously we used
  // indexedDB.deleteDatabase() which fires `onblocked` (not error) if any
  // connection holds the DB open; the promise resolved but data persisted.
  // This caused cache from a prior session to "survive" logout.
  try {
    if (!dbInstance) {
      // Open the DB if we don't already have it. We need a connection to
      // run the clear transaction.
      try {
        dbInstance = await openDb();
      } catch (err) {
        console.warn('[productCache] open during clear failed', err);
        return;
      }
    }
    await new Promise<void>((resolve, reject) => {
      const tx = dbInstance!.transaction(STORE_PRODUCTS, 'readwrite');
      tx.objectStore(STORE_PRODUCTS).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(new Error('clear transaction aborted'));
    });
    console.info('[productCache] IndexedDB store cleared');
  } catch (err) {
    console.warn('[productCache] clear failed', err);
  }
};

/** Sync read of one product by id. */
export const cacheGet = (id: string): Product | undefined => inMemory.get(id);

/** Sync read of all products. */
export const cacheGetAll = (): Product[] => Array.from(inMemory.values());

/** Sync read of count. */
export const cacheSize = (): number => inMemory.size;

/** Subscribe to any cache change (put/delete/clear). Returns unsubscribe fn. */
export const onCacheChange = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
};

/** For debugging: expose to window so user can inspect via DevTools. */
if (typeof window !== 'undefined') {
  (window as any).__billmakerProductCache = {
    init: initProductCache,
    put: cachePut,
    delete: cacheDelete,
    clear: cacheClear,
    get: cacheGet,
    getAll: cacheGetAll,
    size: cacheSize,
  };
}
