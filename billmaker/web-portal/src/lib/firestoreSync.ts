/**
 * Web-portal Firestore sync — connects to the same Firestore that the Baniya
 * mobile app writes to. Mobile's collections (per shopCode):
 *   - bills        (canonical — products + customers are embedded here)
 *   - payments     (per-bill payment events)
 *   - profiles     (mobile-side seller profiles)
 *   - _meta/business  (shop name, phone, address, GST)
 *
 * Mobile does NOT maintain separate customers/products collections — those
 * live as strings inside bills. So the portal:
 *   - subscribes to `bills` + `payments` + `_meta`
 *   - derives unique customer names → ensures a portal Customer record exists
 *     for each one (admin enriches with class/GST later in the portal UI)
 *   - derives unique product names → ensures a portal Product draft exists
 *     for each one, source='billmaker' (admin enriches with prices/images later)
 *
 * Admin-only enrichments (descriptions, prices, images, labels, deals, customer
 * class assignments) live in the portal's localStorage store — they don't get
 * pushed back to mobile's Firestore to avoid schema collisions.
 */
import { initializeApp, getApps, FirebaseApp, deleteApp } from 'firebase/app';
import { getAuth, signInAnonymously, Auth, onAuthStateChanged } from 'firebase/auth';
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  Firestore,
  onSnapshot,
  collection as fsCollection,
  doc as fsDoc,
  setDoc,
  deleteDoc as fsDeleteDoc,
  serverTimestamp,
  Unsubscribe,
  query as fsQuery,
  where,
  Query,
  CollectionReference,
  limit as fsLimit,
  orderBy,
  startAfter,
  getDoc,
  getDocs,
  QueryDocumentSnapshot,
  DocumentData,
} from 'firebase/firestore';
import { PortalConfig } from '../data/portalConfig';
import { log } from './logger';
import { authedFetch, currentUser } from './authClient';
import {
  notify,
  applyBillsSnapshot,
  mergeBillsSnapshot,
  applyPaymentsSnapshot,
  applyBusinessInfo,
  applyProductsSnapshot,
  applyPortalLabelsSnapshot,
  applyPortalClassesSnapshot,
  applyPortalDealsSnapshot,
  applyPortalCustomersSnapshot,
  applyPortalProductsSnapshot,
  mergePortalProductsSnapshot,
  applyPortalBillsMetaSnapshot,
  store,
} from '../data/dummyData';
import { applyAdminAggregatesSnapshot, patchAdminAggregates } from './adminAggregates';

const APP_NAME = 'billmaker-portal-firestore';

// Page size for the products live subscription + cursor-paginated loader.
// Tuned for browsing UX: ~3 rows of cards × ~3 cards per row visible at once
// plus headroom for "load more" infinite scroll. Bumping this is fine; each
// bump just adds reads to the initial portal session.
const PRODUCTS_PAGE_SIZE = 50;

export interface SyncStatus {
  configured: boolean;
  initialized: boolean;
  authReady: boolean;
  shopCode: string | null;
  projectId: string | null;
  lastError: string | null;
  /** Per-collection state: 'idle' | 'subscribed' | 'received' | 'error' */
  collections: Record<string, 'idle' | 'subscribed' | 'received' | 'error'>;
}

const state = {
  app: null as FirebaseApp | null,
  auth: null as Auth | null,
  db: null as Firestore | null,
  shopCode: null as string | null,
  projectId: null as string | null,
  authReady: false,
  lastError: null as string | null,
  listeners: [] as Unsubscribe[],
  collections: {
    bills: 'idle',
    payments: 'idle',
    products: 'idle',
    _meta: 'idle',
    portal_labels: 'idle',
    portal_classes: 'idle',
    portal_deals: 'idle',
    portal_customers: 'idle',
    portal_products: 'idle',
  } as SyncStatus['collections'],
  /**
   * Incremented on every initSync/teardown call. Pending async callbacks
   * (signInAnonymously, deleteApp) capture the generation at start and bail
   * silently when it no longer matches — prevents React Strict Mode double-
   * mount from triggering "app/app-deleted" errors.
   */
  generation: 0,
};

const statusListeners = new Set<(s: SyncStatus) => void>();
export const onSyncStatusChange = (fn: (s: SyncStatus) => void) => {
  statusListeners.add(fn);
  return () => { statusListeners.delete(fn); };
};

export const getSyncStatus = (): SyncStatus => ({
  configured: !!state.app,
  initialized: !!state.db,
  authReady: state.authReady,
  shopCode: state.shopCode,
  projectId: state.projectId,
  lastError: state.lastError,
  collections: { ...state.collections },
});

const notifyStatus = () => {
  const s = getSyncStatus();
  statusListeners.forEach(fn => { try { fn(s); } catch {} });
};

const stopAllListeners = () => {
  for (const unsub of state.listeners) {
    try { unsub(); } catch {}
  }
  state.listeners.length = 0;
  resetProductLoaders();
  state.collections = {
    bills: 'idle',
    payments: 'idle',
    products: 'idle',
    _meta: 'idle',
    portal_labels: 'idle',
    portal_classes: 'idle',
    portal_deals: 'idle',
    portal_customers: 'idle',
    portal_products: 'idle',
  };
};

const sameConfig = (a: PortalConfig, b: { projectId?: string; apiKey?: string; appId?: string; shopCode?: string }) =>
  a.projectId === b.projectId && a.apiKey === b.apiKey && a.appId === b.appId && a.shopCode === b.shopCode;

const lastInitFingerprint = { projectId: '', apiKey: '', appId: '', shopCode: '' };

/**
 * (Re)initializes Firestore for the current config. Idempotent — calling with
 * the same config is a no-op. Calling with a changed config tears down + re-inits.
 */
export const initSync = async (cfg: PortalConfig): Promise<boolean> => {
  if (!cfg.apiKey?.trim() || !cfg.projectId?.trim() || !cfg.appId?.trim() || !cfg.shopCode?.trim()) {
    log('warn', 'config', 'Sync skipped — config incomplete', {
      apiKey: !!cfg.apiKey,
      projectId: !!cfg.projectId,
      appId: !!cfg.appId,
      shopCode: !!cfg.shopCode,
    });
    await teardown();
    return false;
  }

  if (sameConfig(cfg, lastInitFingerprint) && state.db) {
    log('debug', 'sync', 'initSync no-op — same config already initialized');
    return true;
  }

  await teardown();
  const myGen = ++state.generation;

  Object.assign(lastInitFingerprint, {
    projectId: cfg.projectId,
    apiKey: cfg.apiKey,
    appId: cfg.appId,
    shopCode: cfg.shopCode,
  });

  try {
    // Reuse existing app if present
    const existing = getApps().find(a => a.name === APP_NAME);
    if (existing) {
      try { await deleteApp(existing); } catch {}
    }
    // If teardown bumped the generation while we awaited deleteApp, abort.
    if (myGen !== state.generation) return false;

    state.app = initializeApp(
      {
        apiKey: cfg.apiKey,
        projectId: cfg.projectId,
        appId: cfg.appId,
        authDomain: cfg.authDomain || `${cfg.projectId}.firebaseapp.com`,
        messagingSenderId: cfg.messagingSenderId || undefined,
      },
      APP_NAME,
    );
    state.auth = getAuth(state.app);
    // initializeFirestore (not getFirestore) so we can attach a persistent
    // IndexedDB cache. With this, reload from a warm browser fetches deltas
    // only — ~10–50 reads vs. ~2k reads for a cold reload. persistentMultiple
    // TabManager lets multiple portal tabs share the same IndexedDB connection
    // (without it the second tab errors out trying to take an exclusive lock).
    //
    // Wrapped in try/catch because initializeFirestore can throw if it's
    // already been called for this app (e.g. on hot-reload during dev or if
    // some other code path called getFirestore first). On the fallback we
    // still get a working Firestore — just without persistent caching.
    try {
      state.db = initializeFirestore(state.app, {
        localCache: persistentLocalCache({
          tabManager: persistentMultipleTabManager(),
        }),
      });
    } catch (e) {
      log('warn', 'config', 'initializeFirestore with persistent cache failed; falling back to in-memory cache', e);
      state.db = getFirestore(state.app);
    }
    state.shopCode = cfg.shopCode;
    state.projectId = cfg.projectId;
    state.lastError = null;

    log('info', 'config', `Initialized Firebase app for project "${cfg.projectId}", shop "${cfg.shopCode}"`);

    // Watch auth state so the UI can show "authenticated as X". Guard against
    // stale generations so callbacks from a torn-down app are ignored.
    onAuthStateChanged(state.auth, u => {
      if (myGen !== state.generation) return;
      state.authReady = !!u;
      if (u) log('info', 'auth', `Signed in (uid=${u.uid.slice(0, 8)}…, anonymous=${u.isAnonymous})`);
      else log('warn', 'auth', 'Not signed in');
      notifyStatus();
    });

    if (!state.auth.currentUser) {
      log('info', 'auth', 'Attempting anonymous sign-in…');
      try {
        await signInAnonymously(state.auth);
      } catch (e: any) {
        // If our generation is stale, the auth call raced with a teardown —
        // swallow silently (this happens in React Strict Mode dev double-mount).
        if (myGen !== state.generation || e?.code === 'auth/app-deleted') {
          log('debug', 'auth', 'signInAnonymously raced with teardown — ignored');
        } else {
          throw e;
        }
      }
    }

    // Final generation check before wiring listeners
    if (myGen !== state.generation) return false;

    subscribeAll();
    notifyStatus();
    return true;
  } catch (e: any) {
    // Don't surface errors from a stale init call
    if (myGen !== state.generation) {
      log('debug', 'config', 'initSync aborted (stale generation)');
      return false;
    }
    state.lastError = e?.message || String(e);
    log('error', 'config', 'initSync failed', e);
    notifyStatus();
    return false;
  }
};

export const teardown = async () => {
  state.generation++;
  stopAllListeners();
  const appToDelete = state.app;
  state.app = null;
  state.auth = null;
  state.db = null;
  state.shopCode = null;
  state.projectId = null;
  state.authReady = false;
  Object.assign(lastInitFingerprint, { projectId: '', apiKey: '', appId: '', shopCode: '' });
  notifyStatus();
  if (appToDelete) {
    try { await deleteApp(appToDelete); } catch {}
  }
};

// ---------------------------------------------------------------------------
// Portal-side writes — fire-and-forget. The mutation in dummyData.ts updates
// the local store first (for instant UI), then calls these to propagate to
// Firestore so other devices receive the change.
// ---------------------------------------------------------------------------

/**
 * Recursively strip `undefined` values from an object before writing to
 * Firestore — the SDK rejects undefined with a hard error. Optional fields
 * (like `gstNumber`) are commonly undefined when blank; this turns them into
 * "field omitted" which Firestore happily accepts.
 */
const stripUndefined = (value: any): any => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(stripUndefined).filter(v => v !== undefined);
  if (typeof value === 'object' && value.constructor === Object) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      const cleaned = stripUndefined(v);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }
  return value;
};

// ---------------------------------------------------------------------------
// Debounced per-collection sync trigger.
//
// Two modes:
//   - 'incremental' (default): fast, used after every push. Server fetches
//     only docs with lastModified > cursor (cheap — one query per collection).
//   - 'reconcile': full list + delete-stale. Used after every delete because
//     incremental can't see removed docs (no lastModified to trigger on).
//
// In `wrangler dev` the cron doesn't fire, so without these auto-triggers
// the client portal would only reflect admin changes after manual sync.
//
// Debounce: 2-second window per (mode, collection). If admin batch-edits
// the same collection rapidly, exactly ONE sync fires 2 seconds after the
// last change. Saves redundant Firestore reads.
// ---------------------------------------------------------------------------
const SYNC_DEBOUNCE_MS = 2000;
const pendingSyncs = new Map<string, ReturnType<typeof setTimeout>>();

type SyncMode = 'incremental' | 'reconcile';

// Collections the auth-service worker accepts at /admin/sync/trigger/<col>.
// Must mirror auth-service/src/lib/sync.ts SYNCED_COLLECTIONS exactly.
// Writes to OTHER collections (legacy `customers`, `products`, etc., which
// the worker no longer syncs) skip the trigger to avoid the 400 warning
// noise — the writes themselves still land in Firestore, they're just not
// mirrored to the Supabase replica anymore.
const WORKER_SYNCABLE = new Set<string>([
  'bills',
  'profiles',
  '_meta',
  'portal_customers',
  'portal_products',
  'portal_labels',
  'portal_classes',
  'portal_deals',
]);

const scheduleSync = (collection: string, mode: SyncMode = 'incremental'): void => {
  if (currentUser()?.role !== 'admin') return;
  if (!WORKER_SYNCABLE.has(collection)) return;  // skip legacy collections — worker would 400
  const key = `${mode}:${collection}`;
  const existing = pendingSyncs.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingSyncs.delete(key);
    const qs = mode === 'reconcile' ? '?mode=reconcile' : '';
    authedFetch(`/admin/sync/trigger/${encodeURIComponent(collection)}${qs}`, {
      method: 'POST',
    }).then(r => {
      if (!r.ok) log('warn', 'sync', `Sync ${mode} ${collection} → ${r.status}`);
      else log('debug', 'sync', `Synced (${mode}) ${collection}`);
    }).catch(err => {
      log('warn', 'sync', `Sync trigger network error`, err);
    });
  }, SYNC_DEBOUNCE_MS);
  pendingSyncs.set(key, timer);
};


/** Set (merge) a doc under `shops/<shopCode>/<collection>/<id>`. No-op if sync isn't active.
 *  After a successful write, debounced-schedules an INCREMENTAL sync of this
 *  collection so the Supabase replica picks up the change within ~2s
 *  (otherwise it would wait for the next 5-min cron, which doesn't even fire
 *  in `wrangler dev`). */
export const pushPortalDoc = (collection: string, id: string, data: any): Promise<void> => {
  if (!state.db || !state.shopCode) {
    log('debug', 'firestore', `Skipped push ${collection}/${id} — sync not active`);
    return Promise.resolve();
  }
  const ref = fsDoc(state.db, `shops/${state.shopCode}/${collection}/${id}`);
  const cleaned = stripUndefined(data) ?? {};
  // Stamp lastModified on every write so the auth-service replica can do
  // incremental sync (fetch only changed docs). Mobile does the same — see
  // /storage/sync.ts withLastModified().
  const stamped: Record<string, any> = { ...cleaned, lastModified: serverTimestamp() };
  // For products: maintain a lowercase-trimmed `nameLower` field that backs
  // Firestore prefix search (where('nameLower', '>=', q)). Cheap — we have
  // the name in hand at write time. Lets us scale catalog browsing to many
  // thousands of products without loading the whole list.
  if ((collection === 'portal_products' || collection === 'products') && typeof cleaned.name === 'string') {
    stamped.nameLower = cleaned.name.trim().toLowerCase();
  }
  return setDoc(ref, stamped, { merge: true })
    .then(() => {
      log('debug', 'firestore', `Pushed ${collection}/${id}`);
      scheduleSync(collection, 'incremental');
    })
    .catch(err => {
      log('warn', 'firestore', `Push ${collection}/${id} failed: ${err.message}`, err);
    });
};

/** Delete a doc under `shops/<shopCode>/<collection>/<id>`. No-op if sync isn't active.
 *  After a successful delete, debounced-schedules a RECONCILE of this collection
 *  on the auth-service so the Supabase replica drops the row within ~2s instead
 *  of waiting for the daily 00:00 UTC reconcile. */
export const deletePortalDoc = (collection: string, id: string): Promise<void> => {
  if (!state.db || !state.shopCode) {
    log('debug', 'firestore', `Skipped delete ${collection}/${id} — sync not active`);
    return Promise.resolve();
  }
  const ref = fsDoc(state.db, `shops/${state.shopCode}/${collection}/${id}`);
  return fsDeleteDoc(ref)
    .then(() => {
      log('debug', 'firestore', `Deleted ${collection}/${id}`);
      scheduleSync(collection, 'reconcile');
    })
    .catch(err => {
      log('warn', 'firestore', `Delete ${collection}/${id} failed: ${err.message}`, err);
    });
};


/** Shape stored inside `bills/<id>.payments[]` — must match exactly what
 *  mobile's paymentStorage.toEmbeddedPayment writes, or arrayUnion's deep-
 *  equality dedup fails and we get duplicates. */
export interface EmbeddedPaymentShape {
  id: string;
  amount: number;
  receivedAt: string;
  method: string | null;
  note: string | null;
  createdByProfileId: string | null;
  createdByProfileName: string | null;
}

/**
 * Append a payment to `bills/<billId>.payments[]` via arrayUnion. Idempotent
 * (deep-equality dedup). Bumps `lastModified` so the worker's incremental
 * sync picks the bill up on the next cron tick.
 *
 * Use this anywhere the portal creates a payment server-side (e.g. bulk
 * settle, restore customer). Mirror of mobile's appendPaymentToBill in
 * /storage/sync.ts so both code paths produce identical embedded shapes.
 */
export const appendPaymentToBill = async (
  billId: string,
  payment: EmbeddedPaymentShape,
): Promise<void> => {
  if (!state.db || !state.shopCode) return;
  try {
    const { doc, updateDoc, arrayUnion, serverTimestamp } = await import('firebase/firestore');
    const ref = doc(state.db, `shops/${state.shopCode}/bills/${billId}`);
    await updateDoc(ref, {
      payments: arrayUnion(payment),
      lastModified: serverTimestamp(),
    });
    log('debug', 'firestore', `Appended payment ${payment.id} to bill ${billId}`);
    scheduleSync('bills', 'incremental');
  } catch (err: any) {
    log('warn', 'firestore', `appendPaymentToBill failed for ${billId}: ${err?.message || err}`, err);
  }
};

/**
 * Atomically update a portal_customer's running totals via Firestore
 * `increment()`. Looks up the doc by `id` when provided (cheaper); falls
 * back to a name-equality query (single-doc limit). No-op when the customer
 * isn't found (e.g. an unlinked mobile-created bill whose customer hasn't
 * been promoted to portal_customers yet — that's fine, mobile owns that
 * record). Mirrors mobile's incrementCustomerByName in /storage/sync.ts.
 */
export const incrementPortalCustomer = async (
  key: { id?: string | null; name?: string | null },
  deltas: { totalDelta?: number; paidDelta?: number },
): Promise<void> => {
  if (!state.db || !state.shopCode) return;
  const totalDelta = deltas.totalDelta || 0;
  const paidDelta = deltas.paidDelta || 0;
  const outstandingDelta = totalDelta - paidDelta;
  if (!totalDelta && !paidDelta) return;
  try {
    const {
      doc, updateDoc, increment, serverTimestamp,
      collection, query, where, limit, getDocs,
    } = await import('firebase/firestore');
    let ref: any = null;
    if (key.id) {
      ref = doc(state.db, `shops/${state.shopCode}/portal_customers/${key.id}`);
    } else if (key.name) {
      const colRef = collection(state.db, `shops/${state.shopCode}/portal_customers`);
      const q = query(colRef, where('name', '==', key.name), limit(1));
      const snap = await getDocs(q);
      if (snap.empty) {
        log('debug', 'firestore', `incrementPortalCustomer skipped — no customer with name "${key.name}"`);
        return;
      }
      ref = snap.docs[0].ref;
    } else {
      return;
    }
    const update: Record<string, any> = {
      lastModified: serverTimestamp(),
      lastOutstandingUpdate: new Date().toISOString(),
    };
    if (totalDelta) update.total = increment(totalDelta);
    if (paidDelta) update.paid = increment(paidDelta);
    if (outstandingDelta) update.outstanding = increment(outstandingDelta);
    await updateDoc(ref, update);
    log('debug', 'firestore', `Incremented portal_customer (totalΔ=${totalDelta}, paidΔ=${paidDelta})`);
    scheduleSync('portal_customers', 'incremental');
  } catch (err: any) {
    log('warn', 'firestore', `incrementPortalCustomer failed: ${err?.message || err}`, err);
  }
};

// ---------------------------------------------------------------------------
// Products — on-demand loaders (load-more cursor + prefix search).
//
// The live subscription only carries the top PRODUCTS_PAGE_SIZE products. To
// browse older catalog or search by name without loading the whole list, the
// portal calls these helpers. Each is a one-time Firestore query (getDocs);
// they don't subscribe, just return a snapshot and push the docs into the
// store via applyPortalProductsSnapshot.
// ---------------------------------------------------------------------------

/**
 * Cursor for the "load older products" infinite-scroll. Captures the last
 * doc returned so subsequent calls can `startAfter` it. Module-scoped because
 * the loader is fire-and-forget from the UI.
 */
let productsCursor: QueryDocumentSnapshot<DocumentData> | null = null;
let productsLoadMoreInFlight = false;
let productsExhausted = false;
// Captured from the live portal_products subscription's most-recent snapshot
// (the last doc in the top-50 window). Used as the starting cursor for the
// FIRST "Load older" click so we don't pay 100 reads (50 of which overlap
// the subscription's existing window). Subsequent clicks advance via
// `productsCursor`. See bind('portal_products', ...) for where it's set.
let portalProductsSubscriptionCursor: QueryDocumentSnapshot<DocumentData> | null = null;

/**
 * Internal helper — called by the bind handler so loadMorePortalProducts
 * can pick up where the subscription's window ends.
 */
export const setPortalProductsSubscriptionCursor = (
  cursor: QueryDocumentSnapshot<DocumentData> | null,
): void => {
  portalProductsSubscriptionCursor = cursor;
};

/**
 * Reset on every sync (re)init so a fresh session starts at the top of the
 * collection. Otherwise stale cursors from a prior session would skip the
 * recent docs the live subscription is already showing.
 */
const resetProductLoaders = () => {
  productsCursor = null;
  productsLoadMoreInFlight = false;
  productsExhausted = false;
  portalProductsSubscriptionCursor = null;
};

/**
 * Fetch the next PRODUCTS_PAGE_SIZE products older than what's currently in
 * the store. Idempotent if a previous call is still in flight. Returns the
 * number of new docs fetched (0 when exhausted).
 *
 * Cursor priority:
 *   1. productsCursor       — set after each Load More call (paginates this session)
 *   2. subscriptionCursor   — captured from the live subscription's last doc
 *                             (used for the FIRST Load More click to avoid
 *                             re-fetching the top-50 we already have)
 *   3. no cursor + 2x limit — fallback only if subscription never delivered
 *                             docs (e.g. fresh shop with 0 products)
 */
export const loadMorePortalProducts = async (): Promise<number> => {
  if (!state.db || !state.shopCode) return 0;
  if (productsLoadMoreInFlight || productsExhausted) return 0;
  productsLoadMoreInFlight = true;
  try {
    const baseRef = fsCollection(state.db, `shops/${state.shopCode}/portal_products`);
    const startCursor = productsCursor || portalProductsSubscriptionCursor;
    const q: Query = startCursor
      ? fsQuery(
          baseRef,
          orderBy('lastModified', 'desc'),
          startAfter(startCursor),
          fsLimit(PRODUCTS_PAGE_SIZE),
        )
      : fsQuery(
          baseRef,
          orderBy('lastModified', 'desc'),
          fsLimit(PRODUCTS_PAGE_SIZE * 2),
        );
    const snap = await getDocs(q);
    if (snap.docs.length === 0) {
      productsExhausted = true;
      return 0;
    }
    productsCursor = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < (startCursor ? PRODUCTS_PAGE_SIZE : PRODUCTS_PAGE_SIZE * 2)) {
      productsExhausted = true;
    }
    const docs = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    // Additive merge — these are out-of-window products that the live
    // subscription will never see. applyPortalProductsSnapshot would treat
    // them as cross-device deletes on the next subscription fire.
    mergePortalProductsSnapshot(docs);
    notify();
    return docs.length;
  } catch (err: any) {
    log('warn', 'firestore', `loadMorePortalProducts failed: ${err?.message}`, err);
    return 0;
  } finally {
    productsLoadMoreInFlight = false;
  }
};

export const areMorePortalProductsAvailable = (): boolean => !productsExhausted;


/**
 * One-time query for bills whose `updatedAt` falls in [fromISO, toISO). Used
 * by AdminBills' auto-lookback when a filter (e.g. "Released") shows fewer
 * results than expected in the default 30-day window — we extend the window
 * 30 days at a time until enough rows fill the page or we run out.
 *
 * Returns the number of bills fetched in this range. Merged additively (no
 * subscription reconcile drops on next live fire).
 */
export const loadBillsForDateRange = async (
  fromISO: string,
  toISO: string,
): Promise<number> => {
  if (!state.db || !state.shopCode) return 0;
  try {
    const q = fsQuery(
      fsCollection(state.db, `shops/${state.shopCode}/bills`),
      where('updatedAt', '>=', fromISO),
      where('updatedAt', '<', toISO),
    );
    const snap = await getDocs(q);
    const docs = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
    if (docs.length > 0) {
      mergeBillsSnapshot(docs);
      notify();
    }
    log('info', 'firestore', `loadBillsForDateRange [${fromISO}..${toISO}): ${docs.length} bill(s)`);
    return docs.length;
  } catch (err: any) {
    log('warn', 'firestore', `loadBillsForDateRange failed: ${err?.message}`, err);
    return 0;
  }
};

/**
 * Prefix-search products by name. Uses Firestore's range query against the
 * `nameLower` field — same field maintained by `pushPortalDoc` (see top of
 * file). Returns up to PRODUCTS_PAGE_SIZE matches; merges them into the
 * store so existing render code keeps working.
 *
 * Costs ~N Firestore reads where N = matching docs (capped at page size).
 * Empty `q` is a no-op (use the live subscription instead).
 */
// Cursor state for paginated search. Reset whenever the search string
// changes (e.g. user types more / clears). `searchExhausted` short-circuits
// further "load more" calls once Firestore returns less than a full page.
let searchCursor: QueryDocumentSnapshot<DocumentData> | null = null;
let searchExhausted = false;
let lastSearchLower = '';

export const searchPortalProducts = async (
  q: string,
  loadMore: boolean = false,
): Promise<number> => {
  if (!state.db || !state.shopCode) return 0;
  const lower = q.trim().toLowerCase();
  if (!lower) return 0;

  // New search OR query changed → reset cursor. Without this, a "load more"
  // after the user retyped a different prefix would page through the wrong
  // range.
  if (!loadMore || lower !== lastSearchLower) {
    searchCursor = null;
    searchExhausted = false;
    lastSearchLower = lower;
  }
  if (loadMore && searchExhausted) return 0;

  try {
    const baseRef = fsCollection(state.db, `shops/${state.shopCode}/portal_products`);
    // Prefix-range pattern + explicit orderBy for cursor pagination.
    // The upper bound uses U+F8FF (a high private-use codepoint) so the
    // range captures every string starting with `lower`.
    const constraints: any[] = [
      where('nameLower', '>=', lower),
      where('nameLower', '<', lower + ''),
      orderBy('nameLower'),
    ];
    if (searchCursor) constraints.push(startAfter(searchCursor));
    constraints.push(fsLimit(PRODUCTS_PAGE_SIZE));

    const searchQuery = fsQuery(baseRef, ...constraints);
    const snap = await getDocs(searchQuery);

    if (snap.docs.length > 0) {
      searchCursor = snap.docs[snap.docs.length - 1];
      const docs = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
      // Additive merge — see comment in loadMorePortalProducts.
      mergePortalProductsSnapshot(docs);
      notify();
    }
    if (snap.docs.length < PRODUCTS_PAGE_SIZE) {
      searchExhausted = true;
    }
    return snap.docs.length;
  } catch (err: any) {
    log('warn', 'firestore', `searchPortalProducts(${lower}) failed: ${err?.message}`, err);
    return 0;
  }
};

/** True if there might be another page of results for the current search. */
export const areMoreSearchResultsAvailable = (): boolean => !searchExhausted;

/** Clear cursor state — call when the search box becomes empty. */
export const resetSearchCursor = (): void => {
  searchCursor = null;
  searchExhausted = false;
  lastSearchLower = '';
};

/**
 * Backfill the `nameLower` field for every portal_product missing it. Used
 * once after deploying Option E so existing products become searchable. The
 * portal writes nameLower on every save going forward, so this is a one-shot.
 * Cost: 1 read per product + 1 write per product that needed backfilling.
 */
// Exposed at module load so admin can run it once from DevTools console:
//    await window.__billmakerBackfillProductSearch()
// One-shot maintenance task — fills `nameLower` on any portal_product missing
// it. Safe to run multiple times (idempotent — skips docs already correct).
if (typeof window !== 'undefined') {
  (window as any).__billmakerBackfillProductSearch = () => backfillProductsNameLower();
  (window as any).__billmakerBackfillProductsLastModified = () => backfillProductsLastModified();
  (window as any).__billmakerMigrateBillsAckMeta = () => migrateBillsAckMetaToBillDocs();
  (window as any).__billmakerAuditSchemas = () => auditFirestoreSchemas();
  (window as any).__billmakerNormalizeSchemas = () => normalizeFirestoreSchemas();
  (window as any).__billmakerFindGhostBills = () => findGhostBills();
  (window as any).__billmakerPurgeGhostBills = (ids: string[]) => purgeGhostBills(ids);
  (window as any).__billmakerPurgePortalBillsMeta = () => purgePortalBillsMeta();
  (window as any).__billmakerProductsAudit = () => auditProductsConsistency();
  (window as any).__billmakerConsolidateProductsToSlugs = () => consolidateProductsToSlugs();
  (window as any).__billmakerAuditReleasedBills = () => auditReleasedBills();
}

/**
 * Accessor for the active Firestore instance + shop code. Used by sibling
 * modules (e.g. adminAggregates) that need to write directly to Firestore
 * but shouldn't import the module-private `state` object.
 */
export const getSyncState = (): { db: Firestore | null; shopCode: string | null } => ({
  db: state.db,
  shopCode: state.shopCode,
});

// ---------------------------------------------------------------------------
// Schema audit + normalization (see web-portal/docs/firestore-schema.md)
//
// These two functions are the production safety net against the schema drift
// problem: docs written by older versions of mobile/portal/worker may lack
// fields that current code expects. The audit reports which fields are
// missing where. The normalizer backfills missing fields with canonical
// defaults.
// ---------------------------------------------------------------------------

export interface SchemaAuditReport {
  bills: {
    total: number;
    missing: Record<string, number>;     // field name → count of docs missing it
    samples: Record<string, string[]>;    // field name → up to 5 doc ids that are missing it
  };
  customers: {
    total: number;
    missing: Record<string, number>;
    samples: Record<string, string[]>;
  };
}

const BILLS_REQUIRED_FIELDS = [
  'id', 'billNumber', 'createdAt', 'updatedAt', 'customerName', 'customerId',
  'products', 'acknowledged', 'acknowledgedAt', 'lastModified',
];
const CUSTOMERS_REQUIRED_FIELDS = [
  'id', 'name', 'email', 'phone', 'class', 'createdAt',
  'outstanding', 'lastModified',
];

/**
 * Scan every doc in bills, portal_customers, payments and report which
 * canonical fields are missing where. Read-only — does NOT modify anything.
 * Cost: 1 read per doc across all three collections.
 */
export const auditFirestoreSchemas = async (): Promise<SchemaAuditReport> => {
  if (!state.db || !state.shopCode) {
    return {
      bills: { total: 0, missing: {}, samples: {} },
      customers: { total: 0, missing: {}, samples: {} },
    };
  }
  const out: SchemaAuditReport = {
    bills: { total: 0, missing: {}, samples: {} },
    customers: { total: 0, missing: {}, samples: {} },
  };

  const audit = async (
    coll: 'bills' | 'portal_customers',
    required: string[],
    target: SchemaAuditReport['bills'],
  ) => {
    const baseRef = fsCollection(state.db!, `shops/${state.shopCode}/${coll}`);
    let cursor: QueryDocumentSnapshot<DocumentData> | null = null;
    const BATCH = 500;
    for (let page = 0; page < 100; page++) {
      const q: Query = cursor
        ? fsQuery(baseRef, orderBy('__name__'), startAfter(cursor), fsLimit(BATCH))
        : fsQuery(baseRef, orderBy('__name__'), fsLimit(BATCH));
      const snap = await getDocs(q);
      if (snap.docs.length === 0) break;
      // Fields where null is a legitimate value (not "missing").
      const NULL_OK = new Set(['acknowledgedAt', 'method', 'note']);
      // Fields where empty string is a legitimate value (not "missing").
      const EMPTY_OK = new Set(['email', 'phone', 'customerId']);
      // Fields that are optionally absent (mobile doesn't write them; portal
      // sets them when relevant). Audit doesn't flag these as drift.
      const ABSENT_OK = new Set(['customerId']);
      for (const d of snap.docs) {
        target.total++;
        const data = d.data() as Record<string, unknown>;
        for (const field of required) {
          const value = data[field];
          const isMissing =
            (value === undefined && !ABSENT_OK.has(field)) ||
            (value === null && !NULL_OK.has(field)) ||
            (typeof value === 'string' && value.length === 0 && !EMPTY_OK.has(field));
          if (isMissing) {
            target.missing[field] = (target.missing[field] || 0) + 1;
            const samples = target.samples[field] || (target.samples[field] = []);
            if (samples.length < 5) samples.push(d.id);
          }
        }
      }
      cursor = snap.docs[snap.docs.length - 1];
      if (snap.docs.length < BATCH) break;
    }
  };

  await audit('bills', BILLS_REQUIRED_FIELDS, out.bills);
  await audit('portal_customers', CUSTOMERS_REQUIRED_FIELDS, out.customers);

  log('info', 'sync', 'Schema audit complete', out);
  return out;
};

/**
 * For every doc that's missing required fields, merge-write canonical
 * defaults. Idempotent. Mobile-authored fields (customerName, products, etc.)
 * are NOT overwritten — only missing fields are added.
 *
 * Cost: 1 read per doc + 1 write per doc that needed normalization.
 */
export interface SchemaNormalizeResult {
  bills:     { scanned: number; normalized: number; errors: number };
  customers: { scanned: number; normalized: number; errors: number };
}

export const normalizeFirestoreSchemas = async (): Promise<SchemaNormalizeResult> => {
  if (!state.db || !state.shopCode) {
    return {
      bills:     { scanned: 0, normalized: 0, errors: 0 },
      customers: { scanned: 0, normalized: 0, errors: 0 },
    };
  }

  const result: SchemaNormalizeResult = {
    bills:     { scanned: 0, normalized: 0, errors: 0 },
    customers: { scanned: 0, normalized: 0, errors: 0 },
  };

  // ---- BILLS ----
  await normalizeOne(
    `shops/${state.shopCode}/bills`,
    result.bills,
    (data, _id) => {
      // Skip ghost bills: docs missing all critical structural fields are stubs
      // (typically created by the ack migration when the source bill no longer
      // exists on mobile). Adding defaults would dress them up while keeping
      // them useless. Use purgeGhostBills() to delete them instead.
      if (isGhostBill(data)) return null;
      const patch: Record<string, any> = {};
      if (typeof data.acknowledged !== 'boolean') {
        patch.acknowledged = false;
      }
      if (data.acknowledgedAt === undefined) {
        patch.acknowledgedAt = null;
      }
      if (typeof data.updatedAt !== 'string' || !data.updatedAt) {
        patch.updatedAt = typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString();
      }
      if (!data.lastModified) {
        patch.lastModified = serverTimestamp();
      }
      if (data.customerId === undefined) {
        patch.customerId = '';
      }
      return Object.keys(patch).length > 0 ? patch : null;
    },
  );

  // ---- CUSTOMERS (portal_customers) ----
  await normalizeOne(
    `shops/${state.shopCode}/portal_customers`,
    result.customers,
    (data) => {
      const patch: Record<string, any> = {};
      if (typeof data.email !== 'string') patch.email = '';
      if (typeof data.phone !== 'string') patch.phone = '';
      if (!data.lastModified) patch.lastModified = serverTimestamp();
      // outstanding defaults — only set if completely absent (worker will
      // overwrite on next aggregate recompute anyway).
      if (data.outstanding === undefined) patch.outstanding = 0;
      return Object.keys(patch).length > 0 ? patch : null;
    },
  );

  log('info', 'sync', 'Schema normalize complete', result);
  return result;
};

/**
 * Generic pager + patcher used by normalizeFirestoreSchemas. Iterates a
 * collection in 200-doc pages, invokes the per-doc patch builder, and writes
 * the patch with merge:true if non-empty.
 */
const normalizeOne = async (
  collectionPath: string,
  counters: { scanned: number; normalized: number; errors: number },
  buildPatch: (data: Record<string, any>, id: string) => Record<string, any> | null,
): Promise<void> => {
  if (!state.db) return;
  const baseRef = fsCollection(state.db, collectionPath);
  let cursor: QueryDocumentSnapshot<DocumentData> | null = null;
  const BATCH = 200;
  for (let page = 0; page < 1000; page++) {
    const q: Query = cursor
      ? fsQuery(baseRef, orderBy('__name__'), startAfter(cursor), fsLimit(BATCH))
      : fsQuery(baseRef, orderBy('__name__'), fsLimit(BATCH));
    const snap = await getDocs(q);
    if (snap.docs.length === 0) break;
    for (const d of snap.docs) {
      counters.scanned++;
      const data = d.data() as Record<string, any>;
      const patch = buildPatch(data, d.id);
      if (patch) {
        try {
          await setDoc(d.ref, patch, { merge: true });
          counters.normalized++;
        } catch (err) {
          counters.errors++;
          log('warn', 'firestore', `Normalize ${d.ref.path} failed: ${(err as Error)?.message}`);
        }
      }
    }
    cursor = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < BATCH) break;
  }
};

/**
 * A "ghost bill" is a bills/<id> doc that has ack metadata but no actual bill
 * content (no id, billNumber, createdAt, customerName, or products). These
 * typically come from the portal_bills_meta → bills migration when the source
 * bill no longer exists on mobile. They serve no purpose and should be purged.
 */
const isGhostBill = (data: Record<string, any>): boolean => {
  const hasId =           typeof data.id === 'string' && data.id.length > 0;
  const hasBillNumber =   typeof data.billNumber === 'string' && data.billNumber.length > 0;
  const hasCreatedAt =    typeof data.createdAt === 'string' && data.createdAt.length > 0;
  const hasCustomerName = typeof data.customerName === 'string' && data.customerName.length > 0;
  const hasProducts =     Array.isArray(data.products) && data.products.length > 0;
  // Missing ALL five → ghost. (Missing some but not all → legitimate drift,
  // worth normalizing.)
  return !hasId && !hasBillNumber && !hasCreatedAt && !hasCustomerName && !hasProducts;
};

export interface GhostBillScanResult {
  total: number;       // total bill docs scanned
  ghosts: string[];    // doc IDs of ghosts (capped at 1000 to keep memory sane)
  capped: boolean;     // true if we stopped at the cap
}

/**
 * Scans bills collection and returns IDs of ghost docs.
 * Read-only — does not delete anything. Pass the IDs to purgeGhostBills.
 * Cost: 1 read per bill doc.
 */
export const findGhostBills = async (): Promise<GhostBillScanResult> => {
  if (!state.db || !state.shopCode) {
    return { total: 0, ghosts: [], capped: false };
  }
  const baseRef = fsCollection(state.db, `shops/${state.shopCode}/bills`);
  let cursor: QueryDocumentSnapshot<DocumentData> | null = null;
  const BATCH = 500;
  const CAP = 1000;
  const ghosts: string[] = [];
  let total = 0;
  let capped = false;
  for (let page = 0; page < 100; page++) {
    const q: Query = cursor
      ? fsQuery(baseRef, orderBy('__name__'), startAfter(cursor), fsLimit(BATCH))
      : fsQuery(baseRef, orderBy('__name__'), fsLimit(BATCH));
    const snap = await getDocs(q);
    if (snap.docs.length === 0) break;
    for (const d of snap.docs) {
      total++;
      const data = d.data() as Record<string, any>;
      if (isGhostBill(data)) {
        if (ghosts.length < CAP) {
          ghosts.push(d.id);
        } else {
          capped = true;
        }
      }
    }
    cursor = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < BATCH) break;
  }
  log('info', 'sync', `Ghost-bill scan: ${ghosts.length} of ${total} bills are ghosts${capped ? ' (capped)' : ''}`);
  return { total, ghosts, capped };
};

/**
 * Deletes the given bill doc IDs. Caller is responsible for confirming
 * destruction with the user (these are permanent deletes).
 * Cost: 1 write per ID.
 */
export const purgeGhostBills = async (ids: string[]): Promise<{ deleted: number; errors: number }> => {
  if (!state.db || !state.shopCode) return { deleted: 0, errors: 0 };
  let deleted = 0;
  let errors = 0;
  for (const id of ids) {
    try {
      await fsDeleteDoc(fsDoc(state.db, `shops/${state.shopCode}/bills/${id}`));
      deleted++;
    } catch (err) {
      errors++;
      log('warn', 'firestore', `Purge bills/${id} failed: ${(err as Error)?.message}`);
    }
  }
  log('info', 'sync', `Ghost-bill purge: ${deleted} deleted, ${errors} errors`);
  return { deleted, errors };
};

/**
 * Diagnostic: counts how many bills have acknowledged:true in Firestore vs
 * how many appear in the local store. Helps debug the "released badge says
 * N but tab is empty" symptom.
 */
export const auditReleasedBills = async (): Promise<{
  firestoreReleasedCount: number;
  localReleasedCount: number;
  firestoreReleasedBills: Array<{ id: string; updatedAt: string | null; acknowledgedAt: string | null; customerName: string | null }>;
  localTotalBills: number;
}> => {
  if (!state.db || !state.shopCode) {
    return { firestoreReleasedCount: 0, localReleasedCount: 0, firestoreReleasedBills: [], localTotalBills: 0 };
  }
  const baseRef = fsCollection(state.db, `shops/${state.shopCode}/bills`);
  const q = fsQuery(baseRef, where('acknowledged', '==', true));
  const snap = await getDocs(q);
  const firestoreReleasedBills = snap.docs.map(d => {
    const data = d.data() as any;
    return {
      id: d.id,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
      acknowledgedAt: typeof data.acknowledgedAt === 'string' ? data.acknowledgedAt : null,
      customerName: typeof data.customerName === 'string' ? data.customerName : null,
    };
  });
  const localReleasedCount = store.bills.filter(b => b.acknowledged).length;
  return {
    firestoreReleasedCount: snap.size,
    localReleasedCount,
    firestoreReleasedBills,
    localTotalBills: store.bills.length,
  };
};

/**
 * Diagnostic: counts how many products live in each of the three sources
 * (portal_products, mobile name-index `products`, and unique names in bills),
 * and reports the gap. Helps figure out whether the "70 visible / expected
 * more" complaint is a subscription window bug, an import bug, or just an
 * accurate count.
 *
 * Cost: 1 Firestore read per portal_products doc + 1 per mobile products doc.
 * For small shops (<1000 products) that's totally fine for a one-off.
 */
export const auditProductsConsistency = async (): Promise<{
  portal_products_in_firestore: number;
  mobile_products_in_firestore: number;
  unique_names_in_bills: number;
  portal_products_loaded_locally: number;
  bill_names_NOT_in_catalog: number;
  sample_missing: string[];
  portal_products_NOT_in_mobile: number;
  sample_orphans: string[];
}> => {
  if (!state.db || !state.shopCode) {
    return {
      portal_products_in_firestore: 0, mobile_products_in_firestore: 0,
      unique_names_in_bills: 0, portal_products_loaded_locally: 0,
      bill_names_NOT_in_catalog: 0, sample_missing: [],
      portal_products_NOT_in_mobile: 0, sample_orphans: [],
    };
  }
  const ppSnap = await getDocs(fsCollection(state.db, `shops/${state.shopCode}/portal_products`));
  const mpSnap = await getDocs(fsCollection(state.db, `shops/${state.shopCode}/products`));

  const norm = (s: string) => s.trim().toLowerCase();
  const ppNames = new Set<string>();
  for (const d of ppSnap.docs) {
    const n = (d.data() as any)?.name;
    if (typeof n === 'string') ppNames.add(norm(n));
  }
  const mpNames = new Set<string>();
  for (const d of mpSnap.docs) {
    const n = (d.data() as any)?.name;
    if (typeof n === 'string') mpNames.add(norm(n));
  }
  const billNames = new Set<string>();
  for (const b of store.bills) {
    for (const it of b.items || []) {
      if (it.productName) billNames.add(norm(it.productName));
    }
  }

  const missingFromCatalog = [...billNames].filter(n => n && !ppNames.has(n));
  // Portal products without a corresponding mobile-canonical name index doc —
  // candidates for phantom drafts that mobile never created.
  const orphans = [...ppNames].filter(n => n && !mpNames.has(n));

  return {
    portal_products_in_firestore: ppSnap.size,
    mobile_products_in_firestore: mpSnap.size,
    unique_names_in_bills: billNames.size,
    portal_products_loaded_locally: store.products.length,
    bill_names_NOT_in_catalog: missingFromCatalog.length,
    sample_missing: missingFromCatalog.slice(0, 20),
    portal_products_NOT_in_mobile: orphans.length,
    sample_orphans: orphans.slice(0, 20),
  };
};

/**
 * Score a portal_products doc by how enriched it is. Used by the slug
 * consolidation migration to pick the "best" doc when multiple share the
 * same name slug. Higher = more enriched, wins.
 */
const productEnrichmentScore = (data: Record<string, any>): number => {
  let s = 0;
  if (typeof data.description === 'string' && data.description.trim()) s += 5;
  if (Array.isArray(data.labelIds) && data.labelIds.length > 0) s += 3;
  if (Array.isArray(data.images) && data.images.length > 0) s += 4;
  if (data.prices && typeof data.prices === 'object') {
    const nonZero = Object.values(data.prices).filter((v: any) => typeof v === 'number' && v > 0);
    s += nonZero.length * 2;
  }
  if (data.enabledClasses && typeof data.enabledClasses === 'object') {
    const enabled = Object.values(data.enabledClasses).filter(Boolean);
    s += enabled.length;
  }
  if (data.visibleToClient === true) s += 2;
  if (data.source === 'manual') s += 1;  // manually added beats auto-import draft
  return s;
};

/**
 * Consolidation migration — fixes the phantom-products problem at its root by
 * collapsing every group of duplicate portal_products (same normalized name)
 * down to ONE canonical doc whose id is productKey(name) (SHA-256 hex).
 *
 * Process:
 *   1. Scan all portal_products docs
 *   2. Group by slug(name)
 *   3. For each slug:
 *      - If only one doc and its id is already the slug → no-op
 *      - Otherwise: pick the most-enriched doc, write its contents to
 *        portal_products/<slug> (merging if a doc already exists there),
 *        then delete all other docs in the group
 *
 * After this runs, portal_products is canonical (one doc per name). Going
 * forward, writers must use slug as id (see ensureProductByName /
 * ProductModal updates). With slug-as-id enforced, phantoms are physically
 * impossible.
 *
 * Idempotent — safe to re-run.
 * Cost: 1 read per portal_products doc + 1 write per surviving slug +
 *       1 delete per duplicate doc.
 */
export interface ConsolidateResult {
  scanned: number;
  groupsConsolidated: number;
  docsWritten: number;
  docsDeleted: number;
  errors: number;
  examples: string[]; // first few "kept slug — deleted N old ids" lines
}

export const consolidateProductsToSlugs = async (
  onProgress?: (deleted: number, written: number, total: number) => void,
): Promise<ConsolidateResult> => {
  const result: ConsolidateResult = {
    scanned: 0, groupsConsolidated: 0, docsWritten: 0, docsDeleted: 0, errors: 0, examples: [],
  };
  if (!state.db || !state.shopCode) return result;
  const baseRef = fsCollection(state.db, `shops/${state.shopCode}/portal_products`);

  // 1. Read all docs (in pages by __name__ so we cover everything, regardless
  //    of whether lastModified is set).
  const allDocs: Array<{ id: string; data: Record<string, any> }> = [];
  let cursor: QueryDocumentSnapshot<DocumentData> | null = null;
  const BATCH = 200;
  for (let page = 0; page < 1000; page++) {
    const q: Query = cursor
      ? fsQuery(baseRef, orderBy('__name__'), startAfter(cursor), fsLimit(BATCH))
      : fsQuery(baseRef, orderBy('__name__'), fsLimit(BATCH));
    const snap = await getDocs(q);
    if (snap.docs.length === 0) break;
    for (const d of snap.docs) {
      allDocs.push({ id: d.id, data: d.data() as Record<string, any> });
      result.scanned++;
    }
    cursor = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < BATCH) break;
  }

  // 2. Group by productKey(name). Uses the single canonical key function.
  const { productKey } = await import('./productKey');
  const groups = new Map<string, typeof allDocs>();
  for (const doc of allDocs) {
    const name = typeof doc.data.name === 'string' ? doc.data.name : '';
    if (!name) continue; // skip docs missing a name
    const key = await productKey(name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(doc);
  }

  // 3. For each group, consolidate.
  for (const [key, group] of groups.entries()) {
    // Fast path: single doc already at the canonical key.
    if (group.length === 1 && group[0].id === key) continue;

    // Pick the most-enriched as the source of truth for content.
    group.sort((a, b) => productEnrichmentScore(b.data) - productEnrichmentScore(a.data));
    const best = group[0];

    // Strip the `id` field from data — the doc id IS the key.
    const { id: _ignoredId, ...content } = best.data;
    const newDoc = { ...content, id: key };

    // Write the canonical key doc (merge so we never lose enrichment if
    // a previous run already wrote to this key).
    const keyRef = fsDoc(state.db!, `shops/${state.shopCode}/portal_products/${key}`);
    try {
      await setDoc(keyRef, newDoc, { merge: true });
      result.docsWritten++;
    } catch (err) {
      result.errors++;
      log('warn', 'firestore', `Consolidate write key=${key} failed: ${(err as Error)?.message}`);
      continue;
    }

    // Delete every other doc in the group.
    const oldIds: string[] = [];
    for (const doc of group) {
      if (doc.id === key) continue;
      try {
        await fsDeleteDoc(fsDoc(state.db!, `shops/${state.shopCode}/portal_products/${doc.id}`));
        result.docsDeleted++;
        oldIds.push(doc.id);
      } catch (err) {
        result.errors++;
        log('warn', 'firestore', `Consolidate delete ${doc.id} failed: ${(err as Error)?.message}`);
      }
    }

    if (oldIds.length > 0) {
      result.groupsConsolidated++;
      if (result.examples.length < 10) {
        const name = typeof group[0].data.name === 'string' ? group[0].data.name : '?';
        result.examples.push(`"${name}" → ${key.slice(0, 8)}… (merged from ${oldIds.length} dup${oldIds.length === 1 ? '' : 's'})`);
      }
    }
    onProgress?.(result.docsDeleted, result.docsWritten, groups.size);
  }

  log('info', 'sync', 'consolidateProductsToSlugs complete', result);
  return result;
};

/**
 * Migration: backfill `bills/<id>.payments[]` from the separate `payments`
 * collection. Use after deploying the dual-write so existing payments live
 * in both places. After every bill has its payments[] array, the portal can
 * switch to reading from bills.payments[] (Deploy 5 Stage B).
 *
 * Process:
 *   1. Scan all payments docs
 *   2. Group by billId
 *   3. For each bill: arrayUnion every payment into bills/<billId>.payments[]
 *      (arrayUnion is deep-equality idempotent — re-running is safe)
 *   4. Skip payments whose billId doesn't match any bill (orphans logged)
 *
 * Cost: 1 read per payment + 1 write per bill (arrayUnion batched per bill).
 */
export interface MigratePaymentsResult {
  scannedPayments: number;
  billsTouched: number;
  paymentsBackfilled: number;
  orphans: number;          // payments whose billId has no bill doc
  errors: number;
  sampleOrphans: string[];
}

export const migratePaymentsIntoBills = async (
  onProgress?: (done: number, total: number) => void,
): Promise<MigratePaymentsResult> => {
  const result: MigratePaymentsResult = {
    scannedPayments: 0,
    billsTouched: 0,
    paymentsBackfilled: 0,
    orphans: 0,
    errors: 0,
    sampleOrphans: [],
  };
  if (!state.db || !state.shopCode) return result;

  // 1. Read all payments.
  const paymentsRef = fsCollection(state.db, `shops/${state.shopCode}/payments`);
  const payments: Array<{ id: string; data: Record<string, any> }> = [];
  let cursor: QueryDocumentSnapshot<DocumentData> | null = null;
  const BATCH = 200;
  for (let page = 0; page < 1000; page++) {
    const q: Query = cursor
      ? fsQuery(paymentsRef, orderBy('__name__'), startAfter(cursor), fsLimit(BATCH))
      : fsQuery(paymentsRef, orderBy('__name__'), fsLimit(BATCH));
    const snap = await getDocs(q);
    if (snap.docs.length === 0) break;
    for (const d of snap.docs) {
      payments.push({ id: d.id, data: d.data() as Record<string, any> });
      result.scannedPayments++;
    }
    cursor = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < BATCH) break;
  }

  // 2. Group by billId.
  const byBill = new Map<string, Array<Record<string, any>>>();
  for (const p of payments) {
    const billId = typeof p.data.billId === 'string' ? p.data.billId : '';
    if (!billId) continue;
    // Normalize the embedded shape — must match what mobile's
    // appendPaymentToBill / paymentStorage.toEmbeddedPayment produces, or
    // arrayUnion will create a duplicate if the user already dual-wrote.
    const embedded = {
      id: p.id,
      amount: typeof p.data.amount === 'number'
        ? p.data.amount
        : Number(p.data.amount) || 0,
      receivedAt: typeof p.data.receivedAt === 'string' ? p.data.receivedAt : '',
      method: p.data.method ?? null,
      note: p.data.note ?? null,
      createdByProfileId: p.data.createdByProfileId ?? null,
      createdByProfileName: p.data.createdByProfileName ?? null,
    };
    if (!byBill.has(billId)) byBill.set(billId, []);
    byBill.get(billId)!.push(embedded);
  }

  // 3. For each bill, arrayUnion all its payments. Verify bill exists first.
  const { doc: fsDocFn, updateDoc, getDoc, arrayUnion, serverTimestamp } = await import('firebase/firestore');
  let done = 0;
  const totalBills = byBill.size;
  for (const [billId, embeddedList] of byBill.entries()) {
    try {
      const billRef = fsDocFn(state.db!, `shops/${state.shopCode}/bills/${billId}`);
      const billSnap = await getDoc(billRef);
      if (!billSnap.exists()) {
        result.orphans += embeddedList.length;
        if (result.sampleOrphans.length < 10) result.sampleOrphans.push(billId);
        done++;
        onProgress?.(done, totalBills);
        continue;
      }
      // arrayUnion accepts multiple args — append all at once.
      await updateDoc(billRef, {
        payments: arrayUnion(...embeddedList),
        lastModified: serverTimestamp(),
      });
      result.billsTouched++;
      result.paymentsBackfilled += embeddedList.length;
    } catch (err) {
      result.errors++;
      log('warn', 'firestore', `migratePaymentsIntoBills failed for bill ${billId}: ${(err as Error)?.message}`);
    }
    done++;
    onProgress?.(done, totalBills);
  }

  log('info', 'sync', 'migratePaymentsIntoBills complete', result);
  return result;
};

/**
 * One-shot purge of the entire `portal_bills_meta` collection. Ack data now
 * lives on `bills/<id>.acknowledged` directly, so this collection is dead
 * weight. Safe to run only AFTER:
 *   - The worker has been redeployed to read ack from bills (not meta)
 *   - The portal no longer subscribes to portal_bills_meta (already true)
 * Cost: 1 read + 1 write per meta doc.
 */
export const purgePortalBillsMeta = async (): Promise<{ scanned: number; deleted: number; errors: number }> => {
  if (!state.db || !state.shopCode) return { scanned: 0, deleted: 0, errors: 0 };
  const baseRef = fsCollection(state.db, `shops/${state.shopCode}/portal_bills_meta`);
  let cursor: QueryDocumentSnapshot<DocumentData> | null = null;
  const BATCH = 200;
  let scanned = 0;
  let deleted = 0;
  let errors = 0;
  for (let page = 0; page < 1000; page++) {
    const q: Query = cursor
      ? fsQuery(baseRef, orderBy('__name__'), startAfter(cursor), fsLimit(BATCH))
      : fsQuery(baseRef, orderBy('__name__'), fsLimit(BATCH));
    const snap = await getDocs(q);
    if (snap.docs.length === 0) break;
    for (const d of snap.docs) {
      scanned++;
      try {
        await fsDeleteDoc(d.ref);
        deleted++;
      } catch (err) {
        errors++;
        log('warn', 'firestore', `Purge ${d.ref.path} failed: ${(err as Error)?.message}`);
      }
    }
    cursor = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < BATCH) break;
  }
  log('info', 'sync', `portal_bills_meta purge: scanned ${scanned}, deleted ${deleted}, errors ${errors}`);
  return { scanned, deleted, errors };
};

/**
 * One-shot migration: copies the `acknowledged` / `acknowledgedAt` fields
 * from the legacy `portal_bills_meta/<billId>` docs into the corresponding
 * `bills/<billId>` doc itself. After running this, every previously-acked
 * bill has the field on the bill doc, and the portal_bills_meta subscription
 * can safely be removed from the cold-load path.
 *
 * Idempotent — re-running is safe (just re-merges the same fields).
 * Cost: 1 Firestore read per meta doc + 1 Firestore write per meta doc
 *       (skipping bills where meta is already missing/empty).
 */
export const migrateBillsAckMetaToBillDocs = async (): Promise<{
  scanned: number;
  migrated: number;
  errors: number;
}> => {
  if (!state.db || !state.shopCode) return { scanned: 0, migrated: 0, errors: 0 };
  const metaRef = fsCollection(state.db, `shops/${state.shopCode}/portal_bills_meta`);
  let cursor: QueryDocumentSnapshot<DocumentData> | null = null;
  const BATCH = 200;
  let scanned = 0;
  let migrated = 0;
  let errors = 0;
  for (let page = 0; page < 1000; page++) {
    const q: Query = cursor
      ? fsQuery(metaRef, orderBy('__name__'), startAfter(cursor), fsLimit(BATCH))
      : fsQuery(metaRef, orderBy('__name__'), fsLimit(BATCH));
    const snap = await getDocs(q);
    if (snap.docs.length === 0) break;
    for (const d of snap.docs) {
      scanned++;
      const data = d.data() as any;
      const billId = d.id;
      // CRITICAL FIX: only restore ack when meta says TRUE. Writing
      // acknowledged:false from stale meta would overwrite admin's
      // direct-to-bills releases (data loss). If meta says false/missing,
      // skip the bill — let its current ack state stand.
      if (!data.acknowledged) {
        continue;
      }
      try {
        const billRef = fsDoc(state.db, `shops/${state.shopCode}/bills/${billId}`);
        await setDoc(billRef, {
          acknowledged: true,
          acknowledgedAt: data.acknowledgedAt || null,
          lastModified: serverTimestamp(),
        }, { merge: true });
        migrated++;
      } catch (err) {
        errors++;
        log('warn', 'firestore', `migrateBillsAckMeta: failed to merge bill ${billId}`, err);
      }
    }
    cursor = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < BATCH) break;
  }
  log('info', 'sync', `Migrated ${migrated}/${scanned} ack-meta docs to bills (${errors} errors)`);
  return { scanned, migrated, errors };
};

/**
 * Look up a single portal_product by its normalized name (`nameLower`).
 *
 * Used by ensureProductByName to verify a keeper doesn't already exist in
 * Firestore BEFORE creating a phantom. Catches the case where the keeper is
 * in Firestore but outside the live subscription's top-50 window (so it's
 * not in local store).
 *
 * Cost: 1 Firestore read per call. Only fires when the name is NOT in local
 * store (sync fast-path covers the common case). For a typical cold-load
 * with 50 slug docs and most keepers in the top-50, this fires for the
 * ~10-50 names whose keepers happen to be older — much cheaper than
 * pre-loading the full catalog.
 *
 * Returns the raw product doc data (with .id added) or null if no match.
 */
/**
 * Look up a portal_products doc by name. After the consolidation migration,
 * the doc id IS productKey(name) (SHA-256), so this is a single getDoc — no
 * query, no race, no possibility of missing an existing doc.
 *
 * The legacy where(nameLower) fallback covers any pre-consolidation docs
 * with random ids — drop the fallback once consolidation is verified done.
 */
export const lookupProductByName = async (
  normalizedName: string,
): Promise<any | null> => {
  if (!state.db || !state.shopCode) return null;
  if (!normalizedName) return null;
  try {
    const { productKey } = await import('./productKey');
    const key = await productKey(normalizedName);
    // Fast path: doc id = productKey. After consolidation this is the ONLY path used.
    const directRef = fsDoc(state.db, `shops/${state.shopCode}/portal_products/${key}`);
    const directSnap = await getDoc(directRef);
    if (directSnap.exists()) {
      return { id: directSnap.id, ...directSnap.data() };
    }
    // Legacy fallback: pre-consolidation random-id docs.
    const baseRef = fsCollection(state.db, `shops/${state.shopCode}/portal_products`);
    const q = fsQuery(baseRef, where('nameLower', '==', normalizedName), fsLimit(1));
    const snap = await getDocs(q);
    if (snap.docs.length > 0) {
      const d = snap.docs[0];
      return { id: d.id, ...d.data() };
    }
    return null;
  } catch (err: any) {
    log('warn', 'firestore', `lookupProductByName(${normalizedName}) failed: ${err?.message}`, err);
    return null;
  }
};

/**
 * Get the total count of portal_products in Firestore. Used by the Overview
 * page for the "Products" stat — replaces the unreliable store.products.length
 * which only reflects what the windowed subscription has delivered to local.
 *
 * Uses Firestore's count() aggregation — costs 1 read regardless of catalog
 * size. Falls back to null on error so the UI can show the local store size
 * instead.
 */
/**
 * Direct Firestore counts for bills. Returns total + acked.
 * 2 reads per refresh via getCountFromServer (no sum aggregations — they
 * required SDK features we couldn't rely on).
 *
 * totalBilled and totalRevenue are not fetched here — they remain on the
 * admin_aggregates doc (worker-maintained) until Deploy 5 lands.
 */
export const fetchBillCounts = async (): Promise<{
  total: number | null;
  acked: number | null;
  totalBilled: number | null;
  totalRevenue: number | null;
}> => {
  if (!state.db || !state.shopCode) {
    return { total: null, acked: null, totalBilled: null, totalRevenue: null };
  }
  try {
    const { getCountFromServer } = await import('firebase/firestore');
    const billsRef = fsCollection(state.db, `shops/${state.shopCode}/bills`);
    const ackedQuery = fsQuery(billsRef, where('acknowledged', '==', true));
    const [totalSnap, ackedSnap] = await Promise.all([
      getCountFromServer(billsRef),
      getCountFromServer(ackedQuery),
    ]);
    return {
      total: totalSnap.data().count,
      acked: ackedSnap.data().count,
      totalBilled: null,    // not fetched — UI falls back to admin_aggregates
      totalRevenue: null,
    };
  } catch (err: any) {
    log('warn', 'firestore', `fetchBillCounts failed: ${err?.message}`, err);
    return { total: null, acked: null, totalBilled: null, totalRevenue: null };
  }
};

export const fetchPortalProductsCount = async (): Promise<number | null> => {
  if (!state.db || !state.shopCode) return null;
  try {
    const baseRef = fsCollection(state.db, `shops/${state.shopCode}/portal_products`);
    const { getCountFromServer } = await import('firebase/firestore');
    const snap = await getCountFromServer(baseRef);
    return snap.data().count;
  } catch (err: any) {
    log('warn', 'firestore', `fetchPortalProductsCount failed: ${err?.message}`, err);
    return null;
  }
};

/**
 * Explicit one-shot fetch of a page of portal_products. Replaces the live
 * subscription that was bind('portal_products', ...) in initSync.
 *
 * Usage:
 *   - First page: pass `cursor=null`
 *   - Next page: pass the last doc returned from previous call
 *   - Returns docs + the cursor for the next call (or null if exhausted)
 *
 * Sorted by `lastModified` desc (newest first). Pre-consolidation docs
 * lacking lastModified are NOT returned — run "Backfill lastModified" if
 * you see those missing from the catalog.
 *
 * Cost: 1 read per doc returned (typically 50).
 */
export interface ProductsPage {
  products: Array<any>; // raw Firestore data { id, ...data }
  nextCursor: QueryDocumentSnapshot<DocumentData> | null;
  exhausted: boolean;
}

export const fetchPortalProductsPage = async (
  cursor: QueryDocumentSnapshot<DocumentData> | null,
  limit: number = 50,
): Promise<ProductsPage> => {
  if (!state.db || !state.shopCode) {
    return { products: [], nextCursor: null, exhausted: true };
  }
  const baseRef = fsCollection(state.db, `shops/${state.shopCode}/portal_products`);
  const q: Query = cursor
    ? fsQuery(baseRef, orderBy('lastModified', 'desc'), startAfter(cursor), fsLimit(limit))
    : fsQuery(baseRef, orderBy('lastModified', 'desc'), fsLimit(limit));
  const snap = await getDocs(q);
  const products = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const nextCursor = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null;
  const exhausted = snap.docs.length < limit;
  return { products, nextCursor, exhausted };
};

/**
 * Backfill `lastModified` on every portal_products doc that's missing it.
 *
 * Background: pushPortalDoc now auto-stamps lastModified, but legacy docs
 * written before that change have no value. The live products subscription
 * (orderBy lastModified desc, limit 50) and the loadMorePortalProducts
 * paginator (same orderBy) both EXCLUDE docs without that field — Firestore
 * orderBy requires the field to exist. So legacy docs are invisible to the
 * portal on any fresh device / cleared cache.
 *
 * That invisibility is a phantom-loop driver: when the products/<slug>
 * subscription delivers a slug doc whose name corresponds to a legacy
 * keeper, ensureProductByName can't find a normalized match (the keeper
 * isn't in the local store) → creates a phantom → loop repeats.
 *
 * Fix: stamp lastModified on every doc that lacks it. Uses orderBy(__name__)
 * for pagination so we can reach docs without lastModified (id ordering
 * doesn't filter them out).
 *
 * Idempotent — safe to run multiple times. Cost: 1 read per product +
 * 1 write per product needing the backfill.
 */
export const backfillProductsLastModified = async (): Promise<{ scanned: number; updated: number }> => {
  if (!state.db || !state.shopCode) return { scanned: 0, updated: 0 };
  const baseRef = fsCollection(state.db, `shops/${state.shopCode}/portal_products`);
  let cursor: QueryDocumentSnapshot<DocumentData> | null = null;
  const BATCH = 200;
  let scanned = 0;
  let updated = 0;
  // Same guard rail as backfillProductsNameLower — 1000 pages × 200 docs
  // = 200k cap. Way above any realistic catalog size.
  for (let page = 0; page < 1000; page++) {
    const q: Query = cursor
      ? fsQuery(baseRef, orderBy('__name__'), startAfter(cursor), fsLimit(BATCH))
      : fsQuery(baseRef, orderBy('__name__'), fsLimit(BATCH));
    const snap = await getDocs(q);
    if (snap.docs.length === 0) break;
    for (const d of snap.docs) {
      scanned++;
      const data = d.data() as any;
      if (!data?.lastModified) {
        await setDoc(d.ref, { lastModified: serverTimestamp() }, { merge: true });
        updated++;
      }
    }
    cursor = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < BATCH) break;
  }
  return { scanned, updated };
};

export const backfillProductsNameLower = async (): Promise<{ scanned: number; updated: number }> => {
  if (!state.db || !state.shopCode) return { scanned: 0, updated: 0 };
  const baseRef = fsCollection(state.db, `shops/${state.shopCode}/portal_products`);
  let updated = 0;
  let scanned = 0;
  let cursor: QueryDocumentSnapshot<DocumentData> | null = null;
  const BATCH = 200;
  // Guard rail — won't ever scan more than this. At 100k products and 200/
  // batch we'd page through 500 times; cap protects against runaway loops.
  for (let page = 0; page < 1000; page++) {
    const q: Query = cursor
      ? fsQuery(baseRef, orderBy('__name__'), startAfter(cursor), fsLimit(BATCH))
      : fsQuery(baseRef, orderBy('__name__'), fsLimit(BATCH));
    const snap = await getDocs(q);
    if (snap.docs.length === 0) break;
    for (const d of snap.docs) {
      scanned++;
      const data = d.data() as any;
      const name = typeof data?.name === 'string' ? data.name.trim() : '';
      const want = name.toLowerCase();
      const have = typeof data?.nameLower === 'string' ? data.nameLower : '';
      if (name && have !== want) {
        await setDoc(d.ref, { nameLower: want, lastModified: serverTimestamp() }, { merge: true });
        updated++;
      }
    }
    cursor = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < BATCH) break;
  }
  return { scanned, updated };
};

const subscribeAll = () => {
  if (!state.db || !state.shopCode) return;
  const shop = state.shopCode;
  const db = state.db;

  const bind = (
    name: keyof SyncStatus['collections'] | string,
    source: string | Query | CollectionReference,
    onDocs: (docs: any[], snap?: any) => void,
    label?: string,
  ) => {
    state.collections[name] = 'subscribed';
    const ref = typeof source === 'string' ? fsCollection(db, source) : source;
    log('info', 'firestore', `Subscribing to ${label ?? name}`);
    const unsub = onSnapshot(
      ref,
      snap => {
        const docs = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
        state.collections[name] = 'received';
        log('info', 'firestore', `${name}: ${docs.length} doc(s) received`, { sample: docs[0] });
        try {
          onDocs(docs, snap);
          notify();
        } catch (err) {
          log('error', 'firestore', `${name} handler threw`, err);
        }
        notifyStatus();
      },
      err => {
        state.collections[name] = 'error';
        state.lastError = err.message;
        log('error', 'firestore', `Snapshot error on ${name}`, err);
        notifyStatus();
      },
    );
    state.listeners.push(unsub);
  };

  // Optimistic-aggregate patching for mobile-originated changes.
  //
  // The live bills + payments subscriptions fire instantly when mobile
  // creates a doc — but those writes don't go through pushPortalDoc, so the
  // existing optimistic patches (in toggleBillAcknowledged etc.) don't run.
  // Without this, admin's overview cards stay stale until the 5-min cron
  // recomputes the aggregate.
  //
  // Logic: skip the initial snapshot (those docs were already counted in
  // the existing aggregate doc), then for each subsequent `added` doc patch
  // totalBilled / totalRevenue / counts. We deliberately DON'T handle
  // `modified` or `removed`: the server-side recompute (triggered by the
  // 5-min cron's incremental sync of bills/payments) corrects any drift
  // within 5 min. Edge case — a mobile edit on an OLD bill bumps its
  // updatedAt and the bill enters our window for the first time, looking
  // like 'added'. We may briefly double-count its total until the server
  // recompute lands; acceptable trade-off for instant new-bill UX.
  let firstBillsSnap = true;
  let firstPaymentsSnap = true;
  const seenBillIds = new Set<string>();
  const seenPaymentIds = new Set<string>();

  const computeBillTotalFromDoc = (d: any): number => {
    if (d.total !== undefined && d.total !== null) {
      const t = Number(d.total);
      if (!isNaN(t) && t > 0) return t;
    }
    const items = Array.isArray(d.products) ? d.products : Array.isArray(d.items) ? d.items : [];
    let sum = 0;
    for (const it of items) {
      const amt = Number(it?.amount);
      if (!isNaN(amt) && amt > 0) { sum += amt; continue; }
      const qty = Number(it?.quantity ?? it?.qty);
      const rate = Number(it?.price ?? it?.rate);
      if (!isNaN(qty) && !isNaN(rate)) sum += qty * rate;
    }
    return sum;
  };

  // Portal-managed collections — labels, classes, deals, and the portal-side
  // enrichments for customers + products. Mutations in dummyData.ts push to
  // these via `pushPortalDoc` / `deletePortalDoc`; subscriptions here replay
  // remote changes into the local store. On the very first fire (empty remote)
  // the apply handlers seed sensible defaults so a fresh shop has classes /
  // labels straight away.
  bind('portal_labels', `shops/${shop}/portal_labels`, docs => {
    applyPortalLabelsSnapshot(docs);
    log('info', 'sync', `portal_labels: applied ${docs.length} doc(s)`);
  });
  bind('portal_classes', `shops/${shop}/portal_classes`, docs => {
    applyPortalClassesSnapshot(docs);
    log('info', 'sync', `portal_classes: applied ${docs.length} doc(s)`);
  });
  bind('portal_deals', `shops/${shop}/portal_deals`, docs => {
    applyPortalDealsSnapshot(docs);
    log('info', 'sync', `portal_deals: applied ${docs.length} doc(s)`);
  });
  bind('portal_customers', `shops/${shop}/portal_customers`, docs => {
    applyPortalCustomersSnapshot(docs);
    log('info', 'sync', `portal_customers: applied ${docs.length} doc(s)`);
  });
  // Products: NO live subscription. AdminProducts uses explicit getDocs via
  // fetchPortalProductsPage on mount and Load more clicks. Cache is backed
  // by IndexedDB (productCache.ts), cleared on logout. This eliminates the
  // race condition where parallel ensureProductByName calls created local
  // duplicates from the subscription firehose.
  //
  // Mark collection as 'received' immediately so `useCollectionLoaded`
  // doesn't block on it.
  state.collections['portal_products'] = 'received';
  // portal_bills_meta retired — ack fields live on the bill doc itself
  // (see toggleBillAcknowledged). The collection has been purged from
  // Firestore via Settings → Maintenance → "Purge portal_bills_meta".
  notifyStatus();

  // Legacy `products` subscription RETIRED — admin's product list reads
  // `portal_products` (rich data) instead via `fetchPortalProductsPage`.
  // Mark as 'received' so any useCollectionLoaded listener doesn't block.
  state.collections['products'] = 'received';
  notifyStatus();

  // -----------------------------------------------------------------------
  // Pre-warm portal_products for the session.
  //
  // On a FRESH login (cache empty after logout): fetches top-50 portal_products
  // once → populates store.products + IndexedDB cache. Cost: 50 reads, once.
  // Cached products serve all subsequent needs (AdminProducts tab, DealModal,
  // class management iterations) without extra reads.
  //
  // On a returning session (cache still has data from prior session, e.g.
  // browser refresh within the 30-min TTL): loads cache into store, skips
  // the Firestore fetch entirely. Cost: 0 reads.
  //
  // Load More + search results go through the same cache helper
  // (mergePortalProductsSnapshot → cachePutMany), so they're persisted too —
  // a subsequent refresh keeps them in store.
  // -----------------------------------------------------------------------
  void (async () => {
    try {
      const { initProductCache, cacheGetAll, isCacheFresh } =
        await import('./productCache');
      const { mergePortalProductsSnapshot } = await import('../data/dummyData');
      await initProductCache();
      const cached = cacheGetAll();
      if (cached.length > 0) {
        mergePortalProductsSnapshot(cached);
      }
      if (isCacheFresh() && cached.length > 0) {
        log('info', 'sync', `portal_products session pre-warm: ${cached.length} from cache (no Firestore reads)`);
        return;
      }
      // Cache empty or stale — fetch fresh top-50.
      const page = await fetchPortalProductsPage(null, 50);
      mergePortalProductsSnapshot(page.products);
      log('info', 'sync', `portal_products session pre-warm: ${page.products.length} fetched from Firestore + cached`);
    } catch (err) {
      log('warn', 'sync', 'portal_products session pre-warm failed', err);
    }
  })();

  // -----------------------------------------------------------------------
  // Bills + payments — date-filtered subscriptions (last RECENT_WINDOW_DAYS).
  //
  // Why a window:
  //   At ~2.5k bills/day, the full collection grows past 900k docs in a year.
  //   Loading the entire collection on every portal session costs ~1 read per
  //   doc per session — quickly becomes the dominant Firestore cost.
  //
  //   We only need recent bills for the live dashboard. Older bills are
  //   accessed on demand via the "Load older" UI (Phase 4) which queries
  //   Firestore for a specific older range and merges into store.bills.
  //
  // Dashboard aggregates (totals, pending count, per-customer outstanding)
  // come from the admin_aggregates doc which is computed by the Worker from
  // the full Supabase replica — so they remain accurate across ALL bills,
  // not just the window we load here.
  //
  // Cursor fields:
  //   - bills.updatedAt  (ISO string, written by mobile on every create/edit)
  //   - payments.receivedAt (ISO string, set at payment record time)
  // -----------------------------------------------------------------------
  const RECENT_WINDOW_DAYS = 30;
  const recentCutoff = new Date(
    Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const billsQuery = fsQuery(
    fsCollection(db, `shops/${shop}/bills`),
    where('updatedAt', '>=', recentCutoff),
  );
  bind('bills', billsQuery, (docs, snap) => {
    applyBillsSnapshot(docs);

    // First snapshot — populate the "seen" set so the docChanges 'added'
    // logic below only fires for NEW bills, not the initial batch.
    if (firstBillsSnap) {
      firstBillsSnap = false;
      for (const d of docs) if (d._id) seenBillIds.add(d._id);
      return;
    }
    if (!snap?.docChanges) return;
    for (const ch of snap.docChanges()) {
      if (ch.type !== 'added') continue;
      const id = ch.doc.id;
      if (seenBillIds.has(id)) continue;
      seenBillIds.add(id);
      const data = ch.doc.data();
      const total = computeBillTotalFromDoc(data);
      // LOCAL-only billCounts patch for UI snappiness — doesn't write to
      // Firestore. The actual admin_aggregates Firestore increment was
      // already done by the writer (mobile addBill or portal addBill).
      // Doing it again here would double-count.
      void import('./billCounts').then(({ patchTotalDelta, patchTotalBilledDelta }) => {
        patchTotalDelta(+1);
        patchTotalBilledDelta(+total);
      });
      log('debug', 'sync', `Optimistic local-only bill patch: +${total} for ${id}`);
    }
  }, `shops/${shop}/bills [updatedAt >= ${recentCutoff}]`);

  // Payments collection subscription RETIRED (Deploy 5 cleanup). Payments
  // now live inside bills.payments[] — the bills subscription delivers them
  // alongside the bill doc. applyBillsSnapshot extracts them into
  // store.payments for any code still reading from there.
  //
  // Admin aggregates — single doc maintained by the auth-service Worker.
  // Replaces the inline store.bills.reduce(...) used by admin dashboards.
  // Costs 1 read per portal session (just this doc, not the full bills list).
  // Only matters for admin role; client portal never reads aggregates.
  if (currentUser()?.role === 'admin') {
    const aggPath = `shops/${shop}/_meta/admin_aggregates`;
    log('info', 'firestore', `Subscribing to ${aggPath}`);
    const unsubAgg = onSnapshot(
      fsDoc(db, aggPath),
      snap => {
        if (snap.exists()) {
          applyAdminAggregatesSnapshot(snap.data());
          log('debug', 'firestore', 'admin_aggregates received');
        } else {
          applyAdminAggregatesSnapshot(null);
          log('warn', 'firestore', 'admin_aggregates doc missing — Worker may not have run yet');
        }
      },
      err => {
        log('error', 'firestore', 'Snapshot error on admin_aggregates', err);
      },
    );
    state.listeners.push(unsubAgg);
  }

  // _meta is a collection but `business` is the single doc we care about.
  // Mobile updates are rare; client reads via 5-min incremental cron (no
  // cursor field, so technically caught only by reconcile — currently the
  // nightly cron and the manual resync button).
  const metaPath = `shops/${shop}/_meta`;
  state.collections._meta = 'subscribed';
  log('info', 'firestore', `Subscribing to ${metaPath} (looking for business doc)`);
  const unsubMeta = onSnapshot(
    fsDoc(db, `${metaPath}/business`),
    snap => {
      state.collections._meta = 'received';
      if (snap.exists()) {
        const data = snap.data();
        log('info', 'firestore', '_meta/business received', data);
        applyBusinessInfo(data);
        notify();
      } else {
        log('warn', 'firestore', '_meta/business not found — shop may not have business info set');
      }
      notifyStatus();
    },
    err => {
      state.collections._meta = 'error';
      state.lastError = err.message;
      log('error', 'firestore', 'Snapshot error on _meta/business', err);
      notifyStatus();
    },
  );
  state.listeners.push(unsubMeta);
};
