/**
 * Firestore sync layer using the Firebase JS SDK directly (no bundled credentials).
 *
 * Architecture:
 *   - Local JSON files are the canonical source of truth
 *   - Firestore is a mirror — writes happen local-first, then pushed
 *   - On incoming Firestore changes, items are merged into local (additive)
 *   - Cross-device deletes are propagated WITH a backup of the removed item
 *     so the user can recover via Settings if needed
 *   - User provides their own Firebase config in Settings → no shared credentials
 */
import { initializeApp, getApps, getApp, FirebaseApp, deleteApp } from 'firebase/app';
import { getAuth, signInAnonymously, Auth } from 'firebase/auth';
import {
  getFirestore,
  Firestore,
  doc,
  setDoc,
  deleteDoc as fsDeleteDoc,
  collection as fsCollection,
} from 'firebase/firestore';
import { FirebaseConfig } from './firebaseConfigStorage';
import { log } from '../utils/diagnostics';

interface SyncState {
  shopCode: string | null;
  authReady: boolean;
  available: boolean;
}

const state: SyncState = {
  shopCode: null,
  authReady: false,
  available: false,
};

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;

export const isSyncEnabled = (): boolean => state.available && !!state.shopCode && !!db;
export const getActiveShopCode = (): string | null => state.shopCode;

export interface SyncStatus {
  pluginAvailable: boolean;
  authReady: boolean;
  shopCode: string | null;
  enabled: boolean;
}

export const getSyncStatus = (): SyncStatus => ({
  pluginAvailable: !!db,
  authReady: state.authReady,
  shopCode: state.shopCode,
  enabled: isSyncEnabled(),
});

type Listener = (s: SyncStatus) => void;
const statusListeners = new Set<Listener>();
export const onSyncStatusChange = (fn: Listener): (() => void) => {
  statusListeners.add(fn);
  return () => { statusListeners.delete(fn); };
};
const notifyStatus = () => {
  const s = getSyncStatus();
  statusListeners.forEach(fn => { try { fn(s); } catch {} });
};

/**
 * Initialize Firebase with user-provided config and sign in anonymously. Idempotent —
 * if already initialized with the same config, returns true immediately. If initialized
 * with a different config, tears down and re-inits.
 */
export const initSync = async (config: FirebaseConfig, shopCode: string): Promise<boolean> => {
  const code = shopCode?.trim();
  if (!code || !config.apiKey?.trim() || !config.projectId?.trim() || !config.appId?.trim()) {
    state.shopCode = null;
    state.available = false;
    notifyStatus();
    return false;
  }

  try {
    // If a Firebase app already exists with a different config, tear it down first.
    if (getApps().length > 0) {
      const existing = getApp();
      // @ts-ignore — options is a non-public property but stable
      const opt = existing.options || {};
      if (opt.projectId !== config.projectId || opt.apiKey !== config.apiKey || opt.appId !== config.appId) {
        log('info', 'general', 'Firebase config changed — re-initializing');
        await stopAllListeners();
        await deleteApp(existing);
        app = null;
        auth = null;
        db = null;
      } else {
        app = existing;
      }
    }

    if (!app) {
      app = initializeApp({
        apiKey: config.apiKey,
        projectId: config.projectId,
        appId: config.appId,
        authDomain: config.authDomain || `${config.projectId}.firebaseapp.com`,
        messagingSenderId: config.messagingSenderId || '',
        storageBucket: config.storageBucket || `${config.projectId}.appspot.com`,
      });
    }

    auth = getAuth(app);
    db = getFirestore(app);

    if (!auth.currentUser) {
      log('info', 'general', 'Firebase anonymous sign-in');
      await signInAnonymously(auth);
    }

    state.shopCode = code;
    state.authReady = true;
    state.available = true;
    log('info', 'general', `Sync enabled for shop "${code}" on project ${config.projectId}`);
    notifyStatus();
    return true;
  } catch (e: any) {
    log('error', 'general', 'initSync failed', e);
    state.shopCode = null;
    state.available = false;
    notifyStatus();
    return false;
  }
};

export const disableSync = async () => {
  await stopAllListeners();
  state.shopCode = null;
  state.available = false;
  notifyStatus();
};

const safeRun = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
  if (!isSyncEnabled()) {
    log('debug', 'firebase', `Firestore ${label} skipped — sync not active`);
    return null;
  }
  const start = Date.now();
  try {
    const result = await fn();
    log('info', 'firebase', `Firestore ${label} OK (${Date.now() - start}ms)`);
    return result;
  } catch (e: any) {
    log('warn', 'firebase', `Firestore ${label} failed (${Date.now() - start}ms)`, e);
    return null;
  }
};

export const pushDoc = async (collectionName: string, docId: string, data: any): Promise<void> => {
  if (!db || !state.shopCode) return;
  await safeRun(`set ${collectionName}/${docId}`, () =>
    setDoc(doc(db!, `shops/${state.shopCode}/${collectionName}/${docId}`), data),
  );
};

/**
 * Same as pushDoc but merges with the existing doc — only sets the provided fields,
 * leaving other fields (like `createdAt`) untouched on repeat writes. Used for the
 * `customers` and `products` collections where the same name is upserted many times.
 *
 * Auto-stamps `lastModified: serverTimestamp()` on every write so the auth-service
 * replica's incremental sync (cursor = lastModified) picks up mobile changes. Without
 * this, mobile-originated writes would be invisible to incremental sync until the
 * next nightly full reconcile.
 */
export const pushDocMerge = async (collectionName: string, docId: string, data: any): Promise<void> => {
  if (!db || !state.shopCode) return;
  const { serverTimestamp } = await import('firebase/firestore');
  const stamped = { ...data, lastModified: serverTimestamp() };
  await safeRun(`merge ${collectionName}/${docId}`, () =>
    setDoc(doc(db!, `shops/${state.shopCode}/${collectionName}/${docId}`), stamped, { merge: true }),
  );
};

export const deleteDoc = async (collectionName: string, docId: string): Promise<void> => {
  if (!db || !state.shopCode) return;
  await safeRun(`delete ${collectionName}/${docId}`, () =>
    fsDeleteDoc(doc(db!, `shops/${state.shopCode}/${collectionName}/${docId}`)),
  );
};

// incrementAdminAggregates REMOVED (Phase B). The worker now maintains
// admin_aggregates via atomic increment() after each bills sync (see
// auth-service/src/lib/aggregates.ts → applyBillDeltasToAggregates).
// Mobile writes ONLY to bills/<id>; everything else is derived server-side.

/**
 * Append a payment record to `bills/<billId>.payments[]` via atomic arrayUnion.
 * Part of Stage 5A: payments are dual-written to BOTH the separate `payments`
 * collection AND embedded in the bill doc. The bill is the new source of
 * truth for client-portal "view payments per bill" rendering.
 */
export const appendPaymentToBill = async (
  billId: string,
  embedded: Record<string, any>,
): Promise<void> => {
  if (!db || !state.shopCode) {
    log('debug', 'firebase', `appendPaymentToBill skipped — sync not active (billId=${billId})`);
    return;
  }
  const start = Date.now();
  try {
    const { doc, updateDoc, arrayUnion, serverTimestamp } = await import('firebase/firestore');
    const ref = doc(db, `shops/${state.shopCode}/bills/${billId}`);
    await updateDoc(ref, {
      payments: arrayUnion(embedded),
      lastModified: serverTimestamp(),
    });
    log('info', 'firebase', `appendPaymentToBill ${billId} OK paymentId=${embedded.id} amount=${embedded.amount} (${Date.now() - start}ms)`);
  } catch (e: any) {
    log('warn', 'firebase', `appendPaymentToBill ${billId} failed (${Date.now() - start}ms): ${e?.message}`, e);
  }
};

/** Remove a payment from `bills/<billId>.payments[]` via arrayRemove. Needs
 *  the EXACT embedded shape (deep equality match). */
export const removePaymentFromBill = async (
  billId: string,
  embedded: Record<string, any>,
): Promise<void> => {
  if (!db || !state.shopCode) {
    log('debug', 'firebase', `removePaymentFromBill skipped — sync not active (billId=${billId})`);
    return;
  }
  const start = Date.now();
  try {
    const { doc, updateDoc, arrayRemove, serverTimestamp } = await import('firebase/firestore');
    const ref = doc(db, `shops/${state.shopCode}/bills/${billId}`);
    await updateDoc(ref, {
      payments: arrayRemove(embedded),
      lastModified: serverTimestamp(),
    });
    log('info', 'firebase', `removePaymentFromBill ${billId} OK paymentId=${embedded.id} (${Date.now() - start}ms)`);
  } catch (e: any) {
    log('warn', 'firebase', `removePaymentFromBill ${billId} failed (${Date.now() - start}ms): ${e?.message}`, e);
  }
};

// incrementCustomerByName REMOVED (Phase B). The worker now maintains
// portal_customers.outstanding via atomic increment() after each bills sync
// (see auth-service/src/lib/derive.ts → applyCustomerOutstandingDeltas).

/**
 * Cheap existence check: returns true if the collection has at least one doc.
 * Uses Firestore's getCountFromServer for one read regardless of doc count.
 * Used by bootstrap to skip re-pushing local data when Firestore already has it.
 */
export const collectionHasAnyDoc = async (collectionName: string): Promise<boolean> => {
  if (!db || !state.shopCode) return false;
  try {
    const { collection: fsCollection, getCountFromServer } = await import('firebase/firestore');
    const ref = fsCollection(db, `shops/${state.shopCode}/${collectionName}`);
    const snap = await getCountFromServer(ref);
    return snap.data().count > 0;
  } catch (e: any) {
    log('warn', 'general', `collectionHasAnyDoc(${collectionName}) failed — assuming has docs: ${e?.message}`);
    return true;  // Fail-safe: skip the push rather than over-push.
  }
};

/** Compute a bill total from its products array. Mirrors web-portal's
 *  computeBillTotalFromDoc and the SQL aggregate function. */
export const computeBillTotal = (products: Array<{ price?: string | number; quantity?: string | number }>): number => {
  let total = 0;
  for (const it of products || []) {
    const price = Number(it?.price) || 0;
    const qty = Number(it?.quantity) || 0;
    total += price * qty;
  }
  return total;
};

// ---------------------------------------------------------------------------
// Worker write-trigger.
//
// After every successful bill write to Firestore, mobile pings the auth
// service's /auth/sync/trigger/bills endpoint fire-and-forget. The worker
// immediately syncs Firestore → Supabase replica for `bills`, which then
// broadcasts via Realtime to all other devices in ~1-2s.
//
// Without this trigger the cross-device update would wait for the next
// 2-min cron tick. User accepted up to 30s lag, so the trigger is the
// difference between ~1s and ~120s perceived sync time.
//
// Best-effort: any failure is logged and ignored. The 2-min cron is the
// safety net.
// ---------------------------------------------------------------------------
const AUTH_SERVICE_URL: string =
  (import.meta as any).env?.VITE_AUTH_SERVICE_URL ||
  '';

export const triggerWorkerSync = async (collection: 'bills'): Promise<void> => {
  if (!state.shopCode) {
    log('debug', 'firebase', `triggerWorkerSync ${collection} skipped — no shop code`);
    return;
  }
  try {
    const { getAuth } = await import('firebase/auth');
    const auth = getAuth();
    const user = auth.currentUser;
    if (!user) {
      log('debug', 'firebase', `triggerWorkerSync ${collection} skipped — not signed in`);
      return;
    }
    const idToken = await user.getIdToken();
    log('info', 'firebase', `triggerWorkerSync ${collection} firing → ${AUTH_SERVICE_URL}`);
    // Fire-and-forget; we DO log the response status for diagnostics.
    void fetch(`${AUTH_SERVICE_URL}/mobile/sync/trigger/${encodeURIComponent(collection)}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ shop_code: state.shopCode }),
    })
      .then(r => {
        if (r.ok) log('info', 'firebase', `triggerWorkerSync ${collection} → ${r.status}`);
        else log('warn', 'firebase', `triggerWorkerSync ${collection} → ${r.status}`);
      })
      .catch(err => {
        log('warn', 'firebase', `triggerWorkerSync ${collection} network error`, err);
      });
  } catch (err) {
    log('warn', 'firebase', `triggerWorkerSync ${collection} token fetch failed`, err);
  }
};

// subscribeCollection REMOVED (Phase B). Mobile now reads via Supabase
// Realtime in storage/realtimeSync.ts — Firestore subscriptions are no
// longer used for reads. Writes still use the Firestore SDK below.

export const stopAllListeners = async () => {
  // Phase B: no Firestore subscriptions are active on mobile. Kept as a
  // no-op so existing callers (initSync teardown, etc.) don't need to be
  // touched. Also stops the Supabase Realtime channel.
  try {
    const { stopRealtimeSync } = await import('./realtimeSync');
    await stopRealtimeSync();
  } catch {
    /* realtimeSync not loaded — fine */
  }
};

// ---------------------------------------------------------------------------
// Repair & Sync — walks all local data and pushes everything to Firestore.
// Used after re-installing the app, or when the web portal shows missing
// items, or as a generic "force re-sync" button.
// ---------------------------------------------------------------------------

export interface RepairProgress {
  phase: 'idle' | 'customers' | 'products' | 'bills' | 'payments' | 'profiles' | 'done';
  done: number;
  total: number;
  message?: string;
}

export interface RepairResult {
  customers: number;
  products: number;
  bills: number;
  payments: number;
  profiles: number;
  errors: string[];
  durationMs: number;
}

/**
 * Pushes every locally-known customer, product, bill, payment, and profile to
 * Firestore (merging — won't overwrite richer cloud data with empty local data).
 * Safe to run multiple times. Returns counts so the UI can show "Pushed N items".
 */
export const repairAndSyncAll = async (
  onProgress?: (p: RepairProgress) => void,
): Promise<RepairResult> => {
  const start = Date.now();
  const result: RepairResult = {
    customers: 0,
    products: 0,
    bills: 0,
    payments: 0,
    profiles: 0,
    errors: [],
    durationMs: 0,
  };

  if (!isSyncEnabled()) {
    result.errors.push('Sync is not enabled — configure Firebase + Shop Code first.');
    result.durationMs = Date.now() - start;
    return result;
  }

  // Lazy-load to keep this module's import surface small.
  const { getCustomers } = await import('./customerStorage');
  const { getProducts } = await import('./productStorage');
  const { getBills } = await import('./storage');
  const { getPayments } = await import('./paymentStorage');
  const { getProfiles } = await import('./profileStorage');

  const slugify = (s: string): string =>
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'unnamed';

  try {
    // ------- Customers -------
    log('info', 'general', 'Repair & Sync: customers');
    const customers = await getCustomers();
    onProgress?.({ phase: 'customers', done: 0, total: customers.length });
    for (let i = 0; i < customers.length; i++) {
      const name = customers[i];
      const slug = slugify(name);
      await pushDocMerge('customers', slug, {
        id: slug,
        name,
        updatedAt: new Date().toISOString(),
      });
      result.customers++;
      onProgress?.({ phase: 'customers', done: i + 1, total: customers.length });
    }

    // ------- Products -------
    log('info', 'general', 'Repair & Sync: products');
    const products = await getProducts();
    onProgress?.({ phase: 'products', done: 0, total: products.length });
    for (let i = 0; i < products.length; i++) {
      const name = products[i];
      const slug = slugify(name);
      await pushDocMerge('products', slug, {
        id: slug,
        name,
        updatedAt: new Date().toISOString(),
      });
      result.products++;
      onProgress?.({ phase: 'products', done: i + 1, total: products.length });
    }

    // ------- Also catch names that only live in bills (older data) -------
    const bills = await getBills();
    const billCustomerNames = new Set<string>();
    const billProductNames = new Set<string>();
    for (const b of bills) {
      if (b.customerName) billCustomerNames.add(b.customerName.trim());
      for (const p of (b.products || [])) {
        if (p?.name) billProductNames.add(p.name.trim());
      }
    }
    for (const n of billCustomerNames) {
      if (!customers.some(c => c.toLowerCase() === n.toLowerCase())) {
        const slug = slugify(n);
        await pushDocMerge('customers', slug, { id: slug, name: n, updatedAt: new Date().toISOString() });
        result.customers++;
      }
    }
    for (const n of billProductNames) {
      if (!products.some(p => p.toLowerCase() === n.toLowerCase())) {
        const slug = slugify(n);
        await pushDocMerge('products', slug, { id: slug, name: n, updatedAt: new Date().toISOString() });
        result.products++;
      }
    }

    // ------- Bills -------
    // Use merge so portal-set fields (acknowledged, acknowledgedAt, customerId
    // from customer linking) aren't wiped during the repair sync — the whole
    // POINT of the user clicking Release in the portal was to set those fields,
    // and a no-merge overwrite silently reverts them.
    //
    // CRITICAL: push via serializeBill (not the raw Bill object). Raw bills
    // have Date objects for createdAt/updatedAt/acknowledgedAt; Firestore
    // converts those to Timestamps. Portal expects ISO strings (uses .slice()
    // for date filtering). serializeBill emits ISO strings.
    const { serializeBillForSync } = await import('./storage');
    log('info', 'general', 'Repair & Sync: bills');
    onProgress?.({ phase: 'bills', done: 0, total: bills.length });
    for (let i = 0; i < bills.length; i++) {
      const b = bills[i];
      try {
        await pushDocMerge('bills', b.id, serializeBillForSync(b));
        result.bills++;
      } catch (e: any) {
        result.errors.push(`bill ${b.id}: ${e?.message || e}`);
      }
      onProgress?.({ phase: 'bills', done: i + 1, total: bills.length });
    }

    // ------- Payments -------
    // Payments live inside bills/<id>.payments[] post-Deploy 5. Re-arrayUnion
    // each local payment into its bill so any payment that exists only on
    // mobile (offline-created, never synced) lands in the canonical place.
    // arrayUnion's deep-equality dedup makes this idempotent — safe to re-run.
    log('info', 'general', 'Repair & Sync: payments (embedded in bills)');
    const payments = await getPayments();
    onProgress?.({ phase: 'payments', done: 0, total: payments.length });
    for (let i = 0; i < payments.length; i++) {
      const p = payments[i];
      try {
        await appendPaymentToBill(p.billId, {
          id: p.id,
          amount: p.amount,
          receivedAt: p.receivedAt.toISOString(),
          method: p.method ?? null,
          note: p.note ?? null,
          createdByProfileId: p.createdByProfileId ?? null,
          createdByProfileName: p.createdByProfileName ?? null,
        });
        result.payments++;
      } catch (e: any) {
        result.errors.push(`payment ${p.id}: ${e?.message || e}`);
      }
      onProgress?.({ phase: 'payments', done: i + 1, total: payments.length });
    }

    // ------- Profiles -------
    log('info', 'general', 'Repair & Sync: profiles');
    const profiles = await getProfiles();
    onProgress?.({ phase: 'profiles', done: 0, total: profiles.length });
    for (let i = 0; i < profiles.length; i++) {
      const p = profiles[i];
      try {
        await pushDocMerge('profiles', p.id, {
          id: p.id,
          name: p.name,
          createdAt: p.createdAt.toISOString(),
        });
        result.profiles++;
      } catch (e: any) {
        result.errors.push(`profile ${p.id}: ${e?.message || e}`);
      }
      onProgress?.({ phase: 'profiles', done: i + 1, total: profiles.length });
    }

    onProgress?.({ phase: 'done', done: 1, total: 1 });
    result.durationMs = Date.now() - start;
    log(
      'info',
      'general',
      `Repair & Sync complete in ${result.durationMs}ms: ${result.customers} customers, ${result.products} products, ${result.bills} bills, ${result.payments} payments, ${result.profiles} profiles`,
    );
    return result;
  } catch (e: any) {
    result.errors.push(e?.message || String(e));
    result.durationMs = Date.now() - start;
    log('error', 'general', 'Repair & Sync failed', e);
    return result;
  }
};
