import { Customer, Product, Deal, DealItem, Bill, Label, RawCustomer, CustomerClass, BillItem, ClassDef, CustomerArchive, LabelColor, Payment, ALL_CLASS_CODES } from '../types';
import { pushPortalDoc, deletePortalDoc, lookupProductByName, appendPaymentToBill, incrementPortalCustomer } from '../lib/firestoreSync';
import { patchAdminAggregates } from '../lib/adminAggregates';
import { productKey } from '../lib/productKey';
import { cachePut, cacheDelete } from '../lib/productCache';
import { patchAckedDelta, patchTotalDelta, refreshBillCounts } from '../lib/billCounts';

// NO-OP. Previously triggered 2 getCountFromServer queries to refresh the
// bills total/acked tab counters. Now those counters come from
// admin_aggregates.{totalBillCount, pendingCount} via the existing
// subscription — updated atomically by patchAdminAggregates on every ack/
// settle/archive. The wasted reads are eliminated. Function kept as a no-op
// so existing call sites (settleBills, archiveCustomer, etc.) don't need
// to be touched.
const scheduleBillCountsRefresh = (): void => { /* no-op (post-aggregate-incremental) */ };

export const MAX_CLASSES = 5;

/**
 * Same slugify rules as Baniya mobile (storage/customerStorage.ts and
 * storage/productStorage.ts) — kebab-case, alphanumeric only, capped at 80 chars.
 * Matters because mobile uses this as the doc id in the canonical `customers`
 * and `products` collections; if the portal slugifies differently we get
 * duplicates instead of upserts.
 */
const slugifyName = (s: string): string =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unnamed';

// Canonical product-name comparison key. Used by ensureProductByName so that
// "Paracetamol 500mg", "paracetamol 500mg", and "Paracetamol  500mg" all
// match the same logical product (case + whitespace collapse only — no slug
// punctuation stripping, so "500mg" and "500 mg" remain distinct on purpose).
const normalizeProductName = (s: string): string =>
  s.trim().toLowerCase().replace(/\s+/g, ' ');

// productKey is the canonical id source for portal_products — single
// implementation lives in ../lib/productKey. SHA-256 hex of normalized name.
// Mobile's products/<slug> collection keeps using its own slug helper —
// that's a separate name-index collection, not portal_products.

/**
 * Push a customer name to the canonical `customers/<slug>` collection that
 * Baniya mobile reads from for autocomplete + search. Idempotent: same
 * name → same doc → merge-write keeps `updatedAt` fresh without duplicating.
 */
const syncCustomerNameToMobile = (name: string): void => {
  const trimmed = name.trim();
  if (!trimmed) return;
  const slug = slugifyName(trimmed);
  void pushPortalDoc('customers', slug, {
    id: slug,
    name: trimmed,
    updatedAt: new Date().toISOString(),
  });
};

/** Same as above but for product names → `products/<slug>`. */
const syncProductNameToMobile = (name: string): void => {
  const trimmed = name.trim();
  if (!trimmed) return;
  const slug = slugifyName(trimmed);
  void pushPortalDoc('products', slug, {
    id: slug,
    name: trimmed,
    updatedAt: new Date().toISOString(),
  });
};

/**
 * In-memory portal store with pub/sub. Persisted to localStorage so admin
 * enrichments (customer class, product prices, images, labels, deals) survive
 * page reloads.
 *
 * Two kinds of data live here:
 *  - Firestore-derived: bills, payments, raw customer/product names. These
 *    get replaced/merged whenever the Baniya mobile Firestore listener
 *    fires.
 *  - Admin enrichments: customer class/GST/phone, product descriptions/prices/
 *    images, labels, deals. Never overwritten by Firestore — those are
 *    portal-only fields keyed by the same id/name.
 */
/** v3: switched class defaults to Cura/Elixir/Vitae and moved labels/classes/
 *  deals/customers/products to Firestore-backed storage. Bumping the key wipes
 *  stale local data so Firestore takes precedence on next load. */
const STORE_KEY = 'billmaker-portal-store-v3';

const listeners = new Set<() => void>();
export const onStoreChange = (fn: () => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};
export const notify = () => {
  persist();
  listeners.forEach(fn => { try { fn(); } catch {} });
};

const id = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// ---------- Initial state (starter labels + deals only; everything else empty) ----------
const STARTER_LABELS: Label[] = [
  { id: 'l-otc', name: 'OTC', color: 'sky' },
  { id: 'l-anti', name: 'Antibiotic', color: 'rose' },
  { id: 'l-ins', name: 'Insulin', color: 'violet' },
  { id: 'l-supp', name: 'Supplements', color: 'emerald' },
  { id: 'l-dev', name: 'Devices', color: 'indigo' },
  { id: 'l-ppe', name: 'PPE', color: 'amber' },
  { id: 'l-diab', name: 'Diabetes', color: 'cyan' },
];

const STARTER_CLASS_DEFS: ClassDef[] = [
  { code: 'A', name: 'Cura', color: 'emerald' },
  { code: 'B', name: 'Elixir', color: 'sky' },
  { code: 'C', name: 'Vitae', color: 'slate' },
];

/** Suggested defaults for newly-added classes D and E (admin can edit after). */
const NEW_CLASS_DEFAULTS: Record<'D' | 'E', { name: string; color: LabelColor }> = {
  D: { name: 'Aureus', color: 'violet' },
  E: { name: 'Zenith', color: 'amber' },
};

interface BusinessInfo {
  name?: string;
  phone?: string;
  address?: string;
  gst?: string;
}

interface StoreShape {
  labels: Label[];
  classDefs: ClassDef[];
  customers: Customer[];
  products: Product[];
  deals: Deal[];
  bills: Bill[];
  /**
   * Mirror of mobile's `payments` collection. Mobile derives bill.paid from
   * sum of these — the portal does the same in `recomputeBillPayments()`.
   */
  payments: Payment[];
  rawCustomers: RawCustomer[];
  business: BusinessInfo;
  /** Soft-deleted customers + their bills, kept here so they can be restored. */
  archive: CustomerArchive[];
}

const EMPTY: StoreShape = {
  labels: STARTER_LABELS,
  classDefs: STARTER_CLASS_DEFS,
  customers: [],
  products: [],
  deals: [],
  bills: [],
  payments: [],
  rawCustomers: [],
  business: {},
  archive: [],
};

/** Migrate legacy `deal.productIds: string[]` → `deal.items: DealItem[]`. Idempotent. */
const migrateDeal = (d: any): Deal => {
  if (Array.isArray(d.items)) {
    // Already new shape — but sanitise any product entries
    return {
      id: d.id,
      title: d.title || '',
      description: d.description || '',
      items: d.items
        .filter((it: any) => it && it.productId)
        .map((it: any) => ({ productId: it.productId, prices: it.prices || {} })),
      discountPct: Number(d.discountPct) || 0,
      validUntil: d.validUntil || new Date().toISOString().slice(0, 10),
      visibleClasses: Array.isArray(d.visibleClasses) ? d.visibleClasses : [],
      bannerColor: d.bannerColor,
    };
  }
  // Legacy productIds[] → items[] with empty prices (fallback to discountPct)
  const ids: string[] = Array.isArray(d.productIds) ? d.productIds : [];
  return {
    id: d.id,
    title: d.title || '',
    description: d.description || '',
    items: ids.map(pid => ({ productId: pid, prices: {} })),
    discountPct: Number(d.discountPct) || 0,
    validUntil: d.validUntil || new Date().toISOString().slice(0, 10),
    visibleClasses: Array.isArray(d.visibleClasses) ? d.visibleClasses : [],
    bannerColor: d.bannerColor,
  };
};

const hydrate = (): StoreShape => {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { ...EMPTY, labels: [...STARTER_LABELS], classDefs: [...STARTER_CLASS_DEFS] };
    const parsed = JSON.parse(raw) as Partial<StoreShape> & { deals?: any[] };
    return {
      labels: parsed.labels?.length ? parsed.labels : [...STARTER_LABELS],
      classDefs: parsed.classDefs?.length ? parsed.classDefs : [...STARTER_CLASS_DEFS],
      customers: parsed.customers || [],
      products: parsed.products || [],
      deals: (parsed.deals || []).map(migrateDeal),
      bills: parsed.bills || [],
      payments: parsed.payments || [],
      rawCustomers: parsed.rawCustomers || [],
      business: parsed.business || {},
      archive: parsed.archive || [],
    };
  } catch {
    return { ...EMPTY, labels: [...STARTER_LABELS], classDefs: [...STARTER_CLASS_DEFS] };
  }
};

export const store: StoreShape = hydrate();

// Debug exposure — same pattern as __billmakerBackfillProductSearch in
// firestoreSync.ts. Lets admin inspect/audit local state from DevTools
// without touching the source. The store is already client-side-only data
// (localStorage-backed), so exposing it adds no new attack surface.
if (typeof window !== 'undefined') {
  (window as any).__billmakerStore = store;
  (window as any).__billmakerNormalizeProductName = normalizeProductName;
  // Late-bind bulkDeleteProducts because it's hoisted but uses deletePortalDoc
  // from another module; deferring the assignment lets callers resolve it via
  // window even though the function is defined further down the file.
  Object.defineProperty(window as any, '__billmakerBulkDeleteProducts', {
    configurable: true,
    get() { return bulkDeleteProducts; },
  });
}

let persistTimer: number | null = null;
const persist = () => {
  if (persistTimer !== null) return;
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch {}
  }, 100);
};

export const resetStore = () => {
  Object.assign(store, { ...EMPTY, labels: [...STARTER_LABELS] });
  notify();
};

// ===== Firestore portal-side sync =====
//
// Every mutation that follows pushes the resulting record to Firestore via
// `pushPortalDoc`. Subscriptions in `lib/firestoreSync.ts` invoke the apply*
// functions below to merge remote changes into the local store. The first time
// a portal collection fires empty, we seed defaults so a fresh shop has its
// labels + classes ready to go without admin intervention.

/** Tracks collections where we've already handled the "first fire" branch. */
const portalSeededThisSession = new Set<string>();

/**
 * Per-collection memory of which doc IDs we've seen in past remote snapshots.
 * Used by `reconcileByKey` to distinguish "pending local addition (preserve)"
 * from "deleted on another device (remove)".
 */
const lastRemoteIds: Record<string, Set<string>> = {
  portal_labels: new Set(),
  portal_classes: new Set(),
  portal_deals: new Set(),
  portal_customers: new Set(),
  portal_products: new Set(),
};

/**
 * Merge a remote snapshot into a local list without clobbering locally-added
 * items that haven't been confirmed by Firestore yet. Items that were in a
 * previous remote snapshot but missing from the current one are treated as
 * cross-device deletes and removed.
 */
function reconcileByKey<T>(
  collection: string,
  localList: readonly T[],
  remoteList: T[],
  keyFn: (item: T) => string,
): T[] {
  const remoteByKey = new Map(remoteList.map(r => [keyFn(r), r]));
  const remoteKeys = new Set(remoteByKey.keys());
  const prevRemote = lastRemoteIds[collection] || new Set();
  const merged: T[] = [];
  const seen = new Set<string>();

  for (const local of localList) {
    const k = keyFn(local);
    if (seen.has(k)) continue;
    if (remoteByKey.has(k)) {
      merged.push(remoteByKey.get(k)!); // remote wins for items present in both
    } else if (prevRemote.has(k)) {
      // Was in remote before but no longer — cross-device delete, drop it.
      continue;
    } else {
      // Never seen remotely → it's a freshly-added local item still in flight.
      merged.push(local);
    }
    seen.add(k);
  }
  // Append remote-only items
  for (const r of remoteList) {
    const k = keyFn(r);
    if (!seen.has(k)) {
      merged.push(r);
      seen.add(k);
    }
  }

  lastRemoteIds[collection] = remoteKeys;
  return merged;
}

export const applyPortalLabelsSnapshot = (docs: any[]): void => {
  if (docs.length === 0 && !portalSeededThisSession.has('portal_labels')) {
    portalSeededThisSession.add('portal_labels');
    const toSeed = store.labels.length > 0 ? store.labels : [...STARTER_LABELS];
    for (const l of toSeed) void pushPortalDoc('portal_labels', l.id, { id: l.id, name: l.name, color: l.color });
    if (store.labels.length === 0) {
      store.labels.push(...toSeed);
    }
    return;
  }
  portalSeededThisSession.add('portal_labels');
  const remote: Label[] = docs
    .map(d => ({ id: d._id || d.id, name: d.name, color: d.color }))
    .filter((l): l is Label => !!l.id && !!l.name && !!l.color);
  const merged = reconcileByKey<Label>('portal_labels', store.labels, remote, x => x.id);
  store.labels.length = 0;
  store.labels.push(...merged);
};

export const applyPortalClassesSnapshot = (docs: any[]): void => {
  if (docs.length === 0 && !portalSeededThisSession.has('portal_classes')) {
    portalSeededThisSession.add('portal_classes');
    const toSeed = store.classDefs.length > 0 ? store.classDefs : [...STARTER_CLASS_DEFS];
    for (const d of toSeed) void pushPortalDoc('portal_classes', d.code, { code: d.code, name: d.name, color: d.color });
    if (store.classDefs.length === 0) {
      store.classDefs.push(...toSeed);
    }
    return;
  }
  portalSeededThisSession.add('portal_classes');
  const remote: ClassDef[] = docs
    .map(d => ({ code: (d._id || d.code) as CustomerClass, name: d.name, color: d.color }))
    .filter(c => c.code && c.name && c.color && ALL_CLASS_CODES.includes(c.code));
  const merged = reconcileByKey<ClassDef>('portal_classes', store.classDefs, remote, x => x.code);
  merged.sort((a, b) => ALL_CLASS_CODES.indexOf(a.code) - ALL_CLASS_CODES.indexOf(b.code));
  store.classDefs.length = 0;
  store.classDefs.push(...merged);
};

export const applyPortalDealsSnapshot = (docs: any[]): void => {
  portalSeededThisSession.add('portal_deals');
  const remote: Deal[] = docs
    .map((d: any) => ({
      id: d._id || d.id,
      title: d.title || '',
      description: d.description || '',
      items: Array.isArray(d.items)
        ? d.items
            .filter((it: any) => it && it.productId)
            .map((it: any) => ({ productId: it.productId, prices: it.prices || {} }))
        : [],
      discountPct: Number(d.discountPct) || 0,
      validUntil: d.validUntil || new Date().toISOString().slice(0, 10),
      visibleClasses: Array.isArray(d.visibleClasses) ? d.visibleClasses : [],
      bannerColor: d.bannerColor,
    }))
    .filter(d => d.id && d.title);
  const merged = reconcileByKey<Deal>('portal_deals', store.deals, remote, x => x.id);
  store.deals.length = 0;
  store.deals.push(...merged);
};

export const applyPortalCustomersSnapshot = (docs: any[]): void => {
  portalSeededThisSession.add('portal_customers');
  const remote: Customer[] = docs
    .map((d: any) => ({
      id: d._id || d.id,
      name: (d.name || '').toString(),
      email: d.email || '',
      phone: d.phone || '',
      gstNumber: d.gstNumber || undefined,
      address: d.address || undefined,
      class: (d.class || 'C') as CustomerClass,
      createdAt: d.createdAt || new Date().toISOString(),
      aliases: Array.isArray(d.aliases) ? d.aliases : undefined,
      // Worker-maintained outstanding (single writer, no concurrency).
      // Falls back to undefined; UI then defers to aggregate map.
      outstanding: typeof d.outstanding === 'number' ? d.outstanding : undefined,
      lastOutstandingUpdate: typeof d.lastOutstandingUpdate === 'string' ? d.lastOutstandingUpdate : undefined,
    }))
    .filter(c => c.id && c.name);
  const merged = reconcileByKey<Customer>('portal_customers', store.customers, remote, x => x.id);
  store.customers.length = 0;
  store.customers.push(...merged);
  relinkBillsToCustomers();
  rebuildRawCustomers();
};

export const applyPortalProductsSnapshot = (docs: any[]): void => {
  // The portal_products subscription is a WINDOWED view (top-N by
  // lastModified — see firestoreSync.ts:productsQuery). Absence from a
  // snapshot is ambiguous: it can mean either "deleted" OR "fell out of
  // the top-N window because something newer was just written". The old
  // reconcileByKey-based implementation here treated absence as deletion,
  // which silently shrank the local catalog by one every time any product
  // was added or modified — because the new write bumped the oldest doc
  // out of the window, and reconcileByKey then dropped it locally.
  //
  // Additive merge is correct for this collection because the portal has
  // no UI for deleting products (admin can only toggle visibility / edit).
  // Cross-device delete propagation is therefore not a concern.
  portalSeededThisSession.add('portal_products');
  mergePortalProductsSnapshot(docs);
};

/**
 * Additive merge for products that came from a one-time loader / search query
 * (NOT a full collection subscription). Unlike applyPortalProductsSnapshot,
 * this doesn't treat "previously-seen-but-now-missing" as a delete — because
 * the source is a limited/filtered query, missing != deleted.
 *
 * Used by `loadMorePortalProducts` and `searchPortalProducts` in firestoreSync
 * so older / search-matched products survive subsequent live-snapshot fires.
 */
export const mergePortalProductsSnapshot = (docs: any[]): void => {
  const incoming: Product[] = docs
    .map((d: any) => ({
      id: d._id || d.id,
      name: (d.name || '').toString(),
      description: d.description || '',
      labelIds: Array.isArray(d.labelIds) ? d.labelIds : [],
      prices: d.prices || {},
      enabledClasses: d.enabledClasses || {},
      visibleToClient: !!d.visibleToClient,
      source: (d.source === 'billmaker' ? 'billmaker' : 'manual') as 'manual' | 'billmaker',
      inStock: d.inStock !== false,
      images: Array.isArray(d.images) ? d.images : [],
    }))
    .filter(p => p.id && p.name);
  if (incoming.length === 0) return;

  // Upsert by id: replace in place if present, append if new.
  const byId = new Map(store.products.map(p => [p.id, p]));
  for (const p of incoming) {
    byId.set(p.id, p);
  }
  store.products.length = 0;
  store.products.push(...byId.values());

  // Persist to the explicit cache (IndexedDB). On next session/reload, these
  // are available immediately without re-fetching from Firestore until logout.
  void import('../lib/productCache').then(({ cachePutMany }) => cachePutMany(incoming));

  // IMPORTANT: do NOT update `lastRemoteIds['portal_products']` here. The
  // live subscription only sees the top-N most-recent docs and uses
  // lastRemoteIds to detect cross-device deletes. If we registered loader/
  // search docs as "seen in subscription", the next subscription fire would
  // think they were deleted (they're outside the top-N window) and drop
  // them. By leaving them out of lastRemoteIds, reconcileByKey classifies
  // them as "never seen remotely → freshly-added local" and preserves them.
};

// ---------- Session (in-memory only, not persisted) ----------
export const session = {
  currentView: 'admin' as 'client' | 'admin',
  currentCustomerId: '',
};
export const setView = (v: 'client' | 'admin') => { session.currentView = v; listeners.forEach(fn => fn()); };
export const setCurrentCustomer = (id: string) => { session.currentCustomerId = id; listeners.forEach(fn => fn()); };

// ===== Bills =====
// Bills come from mobile's `bills` collection — the portal does NOT own
// them. Until recently, portal-side `acknowledged` / `acknowledgedAt` lived
// in a SEPARATE `portal_bills_meta/<billId>` collection (one extra doc per
// bill ever, full-collection subscription, no upper bound on reads).
//
// We now merge the ack fields INTO `bills/<billId>` itself (merge:true so
// mobile's other fields stay untouched; mobile reads its bill back via
// Firestore listener but never references `acknowledged`, verified). This
// eliminates an entire collection-wide subscription from cold load.
//
// During the transition we still read from billsMetaMap as a fallback for
// bills written before this change. After admin runs the migration tool in
// Settings → Maintenance, every bill has the field on the doc and the
// portal_bills_meta subscription can be removed entirely.
export const toggleBillAcknowledged = (billId: string) => {
  const b = store.bills.find(b => b.id === billId);
  if (!b) return;
  const wasAcked = b.acknowledged;
  b.acknowledged = !wasAcked;
  b.acknowledgedAt = b.acknowledged ? new Date().toISOString() : undefined;
  // Keep the local meta map in sync — old code paths (mergeBillsSnapshot,
  // applyBillsSnapshot) still consult it as a fallback for bills without the
  // ack fields on the doc itself.
  if (b.acknowledged) {
    billsMetaMap.set(b.id, { acknowledged: true, acknowledgedAt: b.acknowledgedAt });
  } else {
    billsMetaMap.set(b.id, { acknowledged: false });
  }
  // Optimistic patch — billCounts updates instantly for snappy UX.
  patchAckedDelta(b.acknowledged ? +1 : -1);
  notify();
  // Merge-write directly onto the bill doc. Mobile's other fields stay
  // untouched because pushPortalDoc uses setDoc with merge:true.
  void pushPortalDoc('bills', b.id, {
    acknowledged: b.acknowledged,
    acknowledgedAt: b.acknowledgedAt || null,
  });
  // Re-query Firestore so the local count matches the actual server state
  // (drops any accumulated optimistic delta drift).
  scheduleBillCountsRefresh();
};

export const acknowledgeBills = (billIds: string[]) => {
  let changed = false;
  const touched: Bill[] = [];
  for (const bid of billIds) {
    const b = store.bills.find(b => b.id === bid);
    if (b && !b.acknowledged) {
      b.acknowledged = true;
      b.acknowledgedAt = new Date().toISOString();
      billsMetaMap.set(b.id, { acknowledged: true, acknowledgedAt: b.acknowledgedAt });
      changed = true;
      touched.push(b);
    }
  }
  if (changed) {
    // Bulk optimistic patch — one increment per newly-acked bill.
    patchAckedDelta(+touched.length);
    notify();
    for (const b of touched) {
      void pushPortalDoc('bills', b.id, {
        acknowledged: b.acknowledged,
        acknowledgedAt: b.acknowledgedAt || null,
      });
    }
    // Sync the count with Firestore truth shortly after.
    scheduleBillCountsRefresh();
  }
};

/**
 * Mark a set of bills as fully paid. For each bill where remaining > 0, this:
 *   1. Updates `bill.paid` locally so the UI reflects it instantly.
 *   2. Writes a `payments/<id>` doc to Firestore for the remaining amount —
 *      this is what mobile actually uses to compute paid (mobile derives
 *      `bill.paid` from sum of payments, it never stores paid on the bill).
 *   3. Adds the payment to the local `store.payments` so the local recompute
 *      stays consistent.
 * Returns the number of bills actually settled.
 */
export const settleBills = (billIds: string[]): number => {
  let count = 0;
  const now = new Date().toISOString();
  const newPayments: Payment[] = [];
  let totalSettled = 0;
  const perCustomerDelta: Record<string, number> = {};
  for (const bid of billIds) {
    const b = store.bills.find(b => b.id === bid);
    if (!b) continue;
    const due = (b.total || 0) - (b.paid || 0);
    if (due <= 0) continue;
    // Local update
    b.paid = b.total;
    count++;
    totalSettled += due;
    // Track per-customer reduction for optimistic aggregate patch. Key
    // mirrors AdminCustomers lookup: customerId first, fall back to name.
    const customerKey = b.customerId || b.customerName;
    if (customerKey) {
      perCustomerDelta[customerKey] = (perCustomerDelta[customerKey] || 0) - due;
    }
    // Synthesize a payment record matching mobile's shape
    const paymentId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-portal`;
    const payment: Payment = {
      id: paymentId,
      billId: b.id,
      amount: due,
      receivedAt: now,
      method: 'portal-settle',
      note: 'Bulk-settled from portal',
      createdByProfileId: null,
      createdByProfileName: 'Portal Admin',
    };
    newPayments.push(payment);
  }
  if (count === 0) return 0;
  store.payments.push(...newPayments);
  // Optimistic aggregate patch — totalRevenue grows, outstanding shrinks,
  // per-customer outstandings drop. Atomic Firestore increment to
  // admin_aggregates also runs inside patchAdminAggregates (see
  // adminAggregates.ts persistAggregateDelta), so dashboard stays consistent
  // across browser tabs without any cron dependency.
  patchAdminAggregates({
    totalRevenueDelta: totalSettled,
    perCustomerOutstandingDelta: perCustomerDelta,
  });
  notify();
  // Persist each payment into `bills/<id>.payments[]` (canonical post-Deploy 5)
  // and atomically decrement the linked portal_customer's outstanding so
  // ClientBills + AdminCustomers stay accurate without a cron recompute.
  // Look up bill once per id to derive customerId / customerName for the
  // increment — bill might have customerId set (admin-linked) or be name-only.
  for (const p of newPayments) {
    const bill = store.bills.find(b => b.id === p.billId);
    void appendPaymentToBill(p.billId, {
      id: p.id,
      amount: p.amount,
      receivedAt: typeof p.receivedAt === 'string' ? p.receivedAt : new Date(p.receivedAt).toISOString(),
      method: p.method ?? null,
      note: p.note ?? null,
      createdByProfileId: p.createdByProfileId ?? null,
      createdByProfileName: p.createdByProfileName ?? null,
    });
    void incrementPortalCustomer(
      { id: bill?.customerId || null, name: bill?.customerName || null },
      { paidDelta: p.amount },
    );
  }
  return count;
};

// Module-scoped map of portal_bills_meta — kept in sync with the live
// subscription. transformBillDocs reads from here so newly-loaded bills
// (via lookback or pagination) get correct ack state, not just the bills
// that happened to already be in store.bills at the time the meta snapshot
// fired.
const billsMetaMap = new Map<string, { acknowledged: boolean; acknowledgedAt?: string }>();

/** Apply a portal_bills_meta snapshot — restores `acknowledged` flag for matching bills. */
export const applyPortalBillsMetaSnapshot = (docs: any[]): void => {
  portalSeededThisSession.add('portal_bills_meta');
  for (const d of docs) {
    const id = d._id || d.id;
    if (!id) continue;
    billsMetaMap.set(id, {
      acknowledged: !!d.acknowledged,
      acknowledgedAt: d.acknowledgedAt || undefined,
    });
  }
  for (const b of store.bills) {
    const meta = billsMetaMap.get(b.id);
    if (meta) {
      b.acknowledged = meta.acknowledged;
      b.acknowledgedAt = meta.acknowledgedAt;
    }
  }
};

// ===== Customers =====
export const addCustomer = (input: Omit<Customer, 'id' | 'createdAt'>) => {
  const customer: Customer = { ...input, id: id('c'), createdAt: new Date().toISOString() };
  store.customers.push(customer);
  notify();
  void pushPortalDoc('portal_customers', customer.id, customer);
  // Also publish to the canonical `customers/<slug>` collection so Baniya
  // mobile's search/autocomplete picks it up.
  syncCustomerNameToMobile(customer.name);
  // Atomic increment so Overview "Customers" tile reflects immediately
  // without waiting for the portal_customers subscription to re-fire.
  patchAdminAggregates({ customerCountDelta: 1 });
  return customer;
};

export const updateCustomer = (
  customerId: string,
  patch: Partial<Pick<Customer, 'phone' | 'gstNumber' | 'address' | 'class' | 'email' | 'name'>>,
) => {
  const c = store.customers.find(c => c.id === customerId);
  if (!c) return;
  const oldName = c.name;
  Object.assign(c, patch);
  const nameChanged = patch.name !== undefined && patch.name !== oldName;
  // If the name changed, propagate to bills so the customer↔bill linkage stays correct.
  if (nameChanged) {
    for (const b of store.bills) {
      if (b.customerId === customerId || b.customerName === oldName) {
        b.customerName = patch.name!;
        b.customerId = customerId;
      }
    }
    rebuildRawCustomers();
  }
  notify();
  void pushPortalDoc('portal_customers', c.id, c);
  // Only push to mobile's canonical `customers/<slug>` when the name actually
  // changes — otherwise every class/GST/phone tweak would trigger an
  // unnecessary write that re-fans through every device's snapshot listener.
  if (nameChanged) syncCustomerNameToMobile(c.name);
};

/**
 * Soft-delete a customer: archives the customer record + all their bills, then
 * removes them from the active store. Use `restoreCustomer(customerId)` to undo.
 * Bills get a `[ARCHIVED]` placeholder prefix on their customerName so they don't
 * accidentally re-link if the same name reappears via Firestore.
 */
export const archiveCustomer = (customerId: string, reason?: string): boolean => {
  const cIdx = store.customers.findIndex(c => c.id === customerId);
  if (cIdx < 0) return false;
  const customer = store.customers[cIdx];

  // Build the full set of names this customer is known by — primary name plus
  // any aliases recorded during Manage-Customers merges. Match case-insensitively
  // so trivial typos in bill names ("Acme" vs "acme") still get caught.
  const nameSet = new Set<string>();
  nameSet.add(customer.name.toLowerCase());
  for (const a of customer.aliases || []) nameSet.add(a.toLowerCase());

  const customerBills = store.bills.filter(
    b =>
      b.customerId === customerId ||
      nameSet.has((b.customerName || '').toLowerCase()),
  );
  const billIds = new Set(customerBills.map(b => b.id));

  // Collect payments tied to those bills — they get archived (so restore can
  // bring them back) AND deleted from Firestore.
  const customerPayments = store.payments.filter(p => billIds.has(p.billId));

  store.archive.push({
    archivedAt: new Date().toISOString(),
    reason: reason?.trim() || undefined,
    customer: { ...customer },
    bills: customerBills.map(b => ({ ...b })),
    payments: customerPayments.map(p => ({ ...p })),
  });

  // Remove bills + payments from the active store
  for (let i = store.bills.length - 1; i >= 0; i--) {
    if (billIds.has(store.bills[i].id)) store.bills.splice(i, 1);
  }
  for (let i = store.payments.length - 1; i >= 0; i--) {
    if (billIds.has(store.payments[i].billId)) store.payments.splice(i, 1);
  }
  store.customers.splice(cIdx, 1);
  rebuildRawCustomers();
  notify();

  // ---- Firestore cleanup ----
  // Wipe the portal-managed enrichment record …
  void deletePortalDoc('portal_customers', customerId);
  // … AND the mobile-canonical name slug(s).
  void deletePortalDoc('customers', slugifyName(customer.name));
  for (const alias of customer.aliases || []) {
    void deletePortalDoc('customers', slugifyName(alias));
  }
  // Delete every bill. Embedded `bills/<id>.payments[]` entries go with each
  // bill — no separate payments-collection cleanup needed post-Deploy 5.
  for (const bid of billIds) {
    void deletePortalDoc('bills', bid);
  }

  // Plus write an EXPLICIT deletion tombstone listing exactly what to remove.
  // Mobile subscribes to portal_deletions and processes each tombstone once.
  // Belt-and-suspenders with the deletes above — the tombstone path doesn't
  // depend on mobile's reconcile state being intact across restarts, so this
  // is the path that actually guarantees cross-device cleanup.
  const tombstoneId = `del-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  void pushPortalDoc('portal_deletions', tombstoneId, {
    id: tombstoneId,
    type: 'customer',
    customerId,
    customerName: customer.name,
    nameSlugs: [slugifyName(customer.name), ...(customer.aliases || []).map(a => slugifyName(a))],
    aliases: customer.aliases || [],
    billIds: Array.from(billIds),
    paymentIds: customerPayments.map(p => p.id),
    deletedAt: new Date().toISOString(),
  });

  // Atomically decrement admin_aggregates so the Overview counters stay
  // accurate. Without this, archiving a customer would leave the totals
  // stale (still counting deleted bills/payments).
  let totalBilledDelta = 0;
  let pendingDelta = 0;
  for (const b of customerBills) {
    totalBilledDelta -= (b.total || 0);
    if (!b.acknowledged) pendingDelta -= 1;
  }
  let totalRevenueDelta = 0;
  for (const p of customerPayments) {
    totalRevenueDelta -= (p.amount || 0);
  }
  patchAdminAggregates({
    totalBilledDelta,
    totalRevenueDelta,
    totalBillCountDelta: -customerBills.length,
    pendingCountDelta:   pendingDelta,
    customerCountDelta:  -1,  // archive removes one portal_customer
  });
  scheduleBillCountsRefresh();
  return true;
};

/** Restore an archived customer + their bills back into the active store. */
export const restoreCustomer = (customerId: string): boolean => {
  const aIdx = store.archive.findIndex(a => a.customer.id === customerId);
  if (aIdx < 0) return false;
  const archived = store.archive[aIdx];

  // Skip restore if the customer name is now in use by another active record
  const collision = store.customers.find(c => c.name === archived.customer.name);
  if (collision) return false;

  store.customers.push(archived.customer);
  for (const b of archived.bills) {
    if (!store.bills.some(existing => existing.id === b.id)) store.bills.push(b);
  }
  for (const p of archived.payments || []) {
    if (!store.payments.some(existing => existing.id === p.id)) store.payments.push(p);
  }
  store.archive.splice(aIdx, 1);
  rebuildRawCustomers();
  notify();

  // ---- Firestore restore ----
  void pushPortalDoc('portal_customers', archived.customer.id, archived.customer);
  syncCustomerNameToMobile(archived.customer.name);
  // Re-publish each bill in the EXACT shape mobile expects (Product type
  // uses `prefix`/`price` as strings, not `unit`/`rate` as numbers). Mobile
  // doesn't recognise the portal-internal field names and would show ₹0.
  for (const b of archived.bills) {
    void pushPortalDoc('bills', b.id, {
      id: b.id,
      billNumber: b.billNumber,
      customerName: b.customerName,
      products: b.items.map((it, idx) => ({
        id: `${b.id}-prod-${idx}`,
        name: it.productName,
        prefix: it.unit === 'Box' || it.unit === 'Pieces' ? it.unit : 'Pieces',
        quantity: String(it.quantity || 0),
        price: String(it.rate || 0),
      })),
      createdAt: b.createdAt,
      updatedAt: new Date().toISOString(),
      restoredFromPortal: true,
      restoredAt: new Date().toISOString(),
    });
  }
  // Re-embed each payment into its bill's payments[] (canonical post-Deploy 5).
  // The bill push above carries products only — it does NOT set payments[],
  // so embedding is a separate arrayUnion. Also re-increment the linked
  // portal_customer's paid total for each payment so the dashboard reflects
  // the restored state (the increment is the inverse of what archive removed).
  for (const p of archived.payments || []) {
    void appendPaymentToBill(p.billId, {
      id: p.id,
      amount: p.amount,
      receivedAt: typeof p.receivedAt === 'string' ? p.receivedAt : new Date(p.receivedAt).toISOString(),
      method: p.method ?? null,
      note: p.note ?? null,
      createdByProfileId: p.createdByProfileId ?? null,
      createdByProfileName: p.createdByProfileName ?? null,
    });
    void incrementPortalCustomer(
      { id: archived.customer.id, name: archived.customer.name },
      { paidDelta: p.amount },
    );
  }

  // Re-increment admin_aggregates by the totals being restored — mirrors the
  // archive decrement so the counter doc lands at the same place it would be
  // if the archive had never happened.
  let totalBilledDelta = 0;
  let pendingDelta = 0;
  for (const b of archived.bills) {
    totalBilledDelta += (b.total || 0);
    if (!b.acknowledged) pendingDelta += 1;
  }
  let totalRevenueDelta = 0;
  for (const p of archived.payments || []) {
    totalRevenueDelta += (p.amount || 0);
  }
  patchAdminAggregates({
    totalBilledDelta,
    totalRevenueDelta,
    totalBillCountDelta: archived.bills.length,
    pendingCountDelta:   pendingDelta,
    customerCountDelta:  +1,  // restore brings back the portal_customer
  });
  return true;
};

/** Permanently remove an archived customer + their bills. */
export const purgeArchivedCustomer = (customerId: string): boolean => {
  const aIdx = store.archive.findIndex(a => a.customer.id === customerId);
  if (aIdx < 0) return false;
  store.archive.splice(aIdx, 1);
  notify();
  return true;
};

export const updateCustomerClass = (customerId: string, newClass: CustomerClass) => {
  updateCustomer(customerId, { class: newClass });
};

/**
 * Ensure a portal Customer record exists for this raw name. INTENTIONALLY only
 * callable from admin-driven flows (Manage Customers' "create canonical"
 * action) — there are NO automatic call sites. Auto-creating customers from
 * bills or mobile's `customers` collection would violate the "customers come
 * only from the admin dashboard" rule.
 */
export const ensureCustomerByName = (name: string): boolean => {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const exists = store.customers.find(
    c => c.name === trimmed || (c.aliases || []).includes(trimmed),
  );
  if (exists) return false;
  const newCustomer: Customer = {
    id: id('c'),
    name: trimmed,
    email: '',
    phone: '',
    class: 'C',
    createdAt: new Date().toISOString(),
  };
  store.customers.push(newCustomer);
  // Backfill bills that mention this name so the client-side filter works.
  for (const b of store.bills) {
    if (!b.customerId && b.customerName && b.customerName.toLowerCase() === trimmed.toLowerCase()) {
      b.customerId = newCustomer.id;
    }
  }
  void pushPortalDoc('portal_customers', newCustomer.id, newCustomer);
  syncCustomerNameToMobile(newCustomer.name);
  return true;
};

// ===== Manage Customers (merge raw names → canonical customer) =====
export const linkRawCustomers = (rawNames: string[], canonicalCustomerId: string, canonicalName: string) => {
  for (const rawName of rawNames) {
    const raw = store.rawCustomers.find(r => r.rawName === rawName);
    if (raw) {
      raw.linkedCustomerId = canonicalCustomerId;
      // Clear the manual-unlink marker so future rebuilds treat this as
      // intentionally linked again (not "explicitly unlinked, don't touch").
      delete raw.manuallyUnlinked;
    }
  }
  const canonical = store.customers.find(c => c.id === canonicalCustomerId);
  if (canonical) {
    canonical.name = canonicalName;
    canonical.aliases = Array.from(new Set([...(canonical.aliases || []), ...rawNames]));
  }

  // Track bills whose customerName changed — they need to be re-pushed to
  // Firestore so mobile sees the rename. Without this push, mobile keeps
  // showing the old name in its bills list and the old slugs in autocomplete.
  const affectedBills: Bill[] = [];
  const rawNamesLowerSet = new Set(rawNames.map(n => n.toLowerCase()));
  for (const b of store.bills) {
    if (rawNamesLowerSet.has((b.customerName || '').toLowerCase())) {
      // Record the pre-link customerName so unlinkRawCustomer can revert
      // this exact bill back to its original raw name. Only set once — if
      // somehow the bill was already linked (shouldn't happen since
      // customerName would equal canonical, not a raw, on second link),
      // preserve the original lineage rather than overwriting.
      if (!b.linkedFromName) b.linkedFromName = b.customerName;
      b.customerName = canonicalName;
      b.customerId = canonicalCustomerId;
      affectedBills.push(b);
    }
  }
  notify();

  if (!canonical) return;

  // 1. Portal-side enrichment record + canonical-name slug (already worked)
  void pushPortalDoc('portal_customers', canonical.id, canonical);
  syncCustomerNameToMobile(canonical.name);

  // 2. Re-push only the changed fields (customerName + audit markers + the
  //    linkedFromName lineage). Using setDoc with merge:true means we leave
  //    the original `products` array, `createdAt`, `billNumber`, etc.
  //    untouched. Mobile's Product shape uses different field names
  //    (prefix/price vs unit/rate, quantity as string) and a per-line `id`;
  //    pushing portal's BillItem shape over the top destroys mobile's data
  //    and shows ₹0 totals in the mobile app.
  for (const b of affectedBills) {
    void pushPortalDoc('bills', b.id, {
      customerName: b.customerName,
      linkedFromName: b.linkedFromName,
      renamedFromPortal: true,
      renamedAt: new Date().toISOString(),
    });
  }

  // 3. Delete the OLD name slugs from `customers/<slug>` so mobile's customer
  //    reconcile drops them from local customers.json + autocomplete. Skip
  //    the canonical's own slug (we just wrote it above).
  const canonicalSlug = slugifyName(canonicalName);
  const slugsToDelete = new Set<string>();
  for (const rawName of rawNames) {
    const slug = slugifyName(rawName);
    if (slug && slug !== canonicalSlug) slugsToDelete.add(slug);
  }
  for (const slug of slugsToDelete) {
    void deletePortalDoc('customers', slug);
  }
};

export const createCanonicalFromRaw = (rawNames: string[], canonicalName: string, customerClass: CustomerClass = 'C') => {
  const c = addCustomer({ name: canonicalName, email: '', phone: '', class: customerClass });
  linkRawCustomers(rawNames, c.id, canonicalName);
  return c;
};

/** Break a previously-merged link. Reverts the bills that were rewritten by
 *  linkRawCustomers back to the raw name (using each bill's recorded
 *  `linkedFromName`), removes the alias from the canonical customer, clears
 *  the link flag on the rawCustomers entry, and pushes everything to Firestore.
 *
 *  Bills that were already on the canonical name BEFORE the link (i.e. no
 *  `linkedFromName` marker) stay put — we can't safely guess which raw they
 *  originated from. They'll still display under the canonical customer.
 *
 *  Legacy data note: existing linked-bills from BEFORE this fix shipped don't
 *  have `linkedFromName`. Unlinking those won't revert those specific bills.
 *  Only links performed after this deploy are fully reversible. */
export const unlinkRawCustomer = (rawName: string): boolean => {
  const raw = store.rawCustomers.find(r => r.rawName === rawName);
  if (!raw || !raw.linkedCustomerId) return false;
  const customer = store.customers.find(c => c.id === raw.linkedCustomerId);
  if (customer) {
    customer.aliases = (customer.aliases || []).filter(a => a !== rawName);
  }
  raw.linkedCustomerId = undefined;
  // Stick a marker so rebuildRawCustomers's auto-link fallback (which matches
  // raw name against any customer's name/alias) doesn't immediately re-link
  // this raw when the canonical customer happens to share the same name.
  raw.manuallyUnlinked = true;

  // Revert any bills that were rewritten during the original link. Match on
  // linkedFromName (recorded at link time) so we revert only the bills that
  // genuinely came from this specific raw name — not unrelated bills that
  // happen to belong to the same canonical customer.
  const revertedBills: Bill[] = [];
  for (const b of store.bills) {
    if (b.linkedFromName === rawName) {
      b.customerName = rawName;
      b.customerId = '';
      delete b.linkedFromName;
      revertedBills.push(b);
    }
  }

  notify();
  if (customer) void pushPortalDoc('portal_customers', customer.id, customer);

  // Push the reverted bills so mobile sees the rollback and the next portal
  // session reads them in their pre-link shape. `linkedFromName: null` is
  // intentional — pushPortalDoc strips `undefined` (which would leave the
  // stale value in Firestore under merge:true), but it keeps `null`, which
  // transformBillDocs treats as "no lineage".
  for (const b of revertedBills) {
    void pushPortalDoc('bills', b.id, {
      customerName: b.customerName,
      linkedFromName: null,
      unlinkedFromPortal: true,
      unlinkedAt: new Date().toISOString(),
    });
  }
  return true;
};

// ===== Class Definitions =====

/** Current active class codes in canonical order (A → E). */
export const getActiveClassCodes = (): CustomerClass[] =>
  store.classDefs.map(d => d.code).sort((a, b) => ALL_CLASS_CODES.indexOf(a) - ALL_CLASS_CODES.indexOf(b));

export const updateClassDef = (code: CustomerClass, patch: Partial<Pick<ClassDef, 'name' | 'color'>>): void => {
  const def = store.classDefs.find(d => d.code === code);
  if (!def) return;
  if (patch.name !== undefined) def.name = patch.name.trim() || def.name;
  if (patch.color !== undefined) def.color = patch.color;
  notify();
  void pushPortalDoc('portal_classes', def.code, { code: def.code, name: def.name, color: def.color });
};

/**
 * Add the next available class code (D or E). Returns the code that was added,
 * or null if all 5 are already active.
 */
export const addNextClassDef = (): CustomerClass | null => {
  const used = new Set(store.classDefs.map(d => d.code));
  for (const code of ALL_CLASS_CODES) {
    if (!used.has(code)) {
      const seed = code === 'D' || code === 'E' ? NEW_CLASS_DEFAULTS[code] : { name: `Tier ${code}`, color: 'slate' as LabelColor };
      const def: ClassDef = { code, name: seed.name, color: seed.color };
      store.classDefs.push(def);
      // Make sure existing products have an entry (default disabled, price 0) for the new class.
      const touchedProducts: Product[] = [];
      for (const p of store.products) {
        let changed = false;
        if (p.enabledClasses[code] === undefined) { p.enabledClasses[code] = false; changed = true; }
        if (p.prices[code] === undefined) { p.prices[code] = 0; changed = true; }
        if (changed) touchedProducts.push(p);
      }
      notify();
      void pushPortalDoc('portal_classes', def.code, { code: def.code, name: def.name, color: def.color });
      for (const p of touchedProducts) void pushPortalDoc('portal_products', p.id, p);
      return code;
    }
  }
  return null;
};

/**
 * Remove a class definition. Refuses to remove A/B/C (the core tiers), or any
 * class that is currently assigned to a customer / referenced by a product /
 * referenced by a deal. Returns true on success, false on refusal.
 */
export const removeClassDef = (code: CustomerClass): { ok: boolean; reason?: string } => {
  if (code === 'A' || code === 'B' || code === 'C') {
    return { ok: false, reason: 'Class A, B, and C are core tiers and can\'t be removed.' };
  }
  const customerUse = store.customers.filter(c => c.class === code).length;
  if (customerUse > 0) {
    return { ok: false, reason: `${customerUse} customer(s) are assigned to Class ${code}. Reassign them first.` };
  }
  const productUse = store.products.filter(p => p.enabledClasses[code]).length;
  if (productUse > 0) {
    return { ok: false, reason: `${productUse} product(s) have Class ${code} enabled. Disable that class on them first.` };
  }
  const dealUse = store.deals.filter(d => d.visibleClasses.includes(code)).length;
  if (dealUse > 0) {
    return { ok: false, reason: `${dealUse} deal(s) target Class ${code}. Remove them from those deals first.` };
  }
  const idx = store.classDefs.findIndex(d => d.code === code);
  if (idx < 0) return { ok: false, reason: 'Class not found.' };
  store.classDefs.splice(idx, 1);
  // Clean up any stranded price/enabled entries on products
  const touchedProducts: Product[] = [];
  for (const p of store.products) {
    let changed = false;
    if (p.prices[code] !== undefined) { delete p.prices[code]; changed = true; }
    if (p.enabledClasses[code] !== undefined) { delete p.enabledClasses[code]; changed = true; }
    if (changed) touchedProducts.push(p);
  }
  notify();
  void deletePortalDoc('portal_classes', code);
  for (const p of touchedProducts) void pushPortalDoc('portal_products', p.id, p);
  return { ok: true };
};

export const getClassDef = (code: CustomerClass): ClassDef =>
  store.classDefs.find(d => d.code === code) || { code, name: `Class ${code}`, color: 'slate' };

export const isClassActive = (code: CustomerClass): boolean =>
  store.classDefs.some(d => d.code === code);

export const classDisplayName = (code: CustomerClass): string => getClassDef(code).name;
export const classBadgeClasses = (code: CustomerClass): string => labelColorClasses[getClassDef(code).color];

// ===== Products =====
export const addProduct = async (input: Omit<Product, 'id'>): Promise<Product> => {
  // Doc id IS productKey(name) — same name → same key → same doc. Admin
  // typing the same name twice merges with the existing doc; no duplicate
  // is ever created.
  const keyId = await productKey(input.name);
  const existing = store.products.find(p => p.id === keyId);
  if (existing) {
    Object.assign(existing, input);
    notify();
    void pushPortalDoc('portal_products', keyId, existing);
    void cachePut(existing);
    return existing;
  }
  const product: Product = { ...input, id: keyId };
  store.products.push(product);
  notify();
  void pushPortalDoc('portal_products', keyId, product);
  void cachePut(product);
  syncProductNameToMobile(product.name);
  patchAdminAggregates({ productCountDelta: 1 });
  return product;
};

export const updateProduct = (productId: string, patch: Partial<Product>) => {
  const p = store.products.find(p => p.id === productId);
  if (!p) return;
  const oldName = p.name;
  Object.assign(p, patch);
  const nameChanged = patch.name !== undefined && patch.name !== oldName;
  notify();
  void pushPortalDoc('portal_products', p.id, p);
  void cachePut(p);
  // Only sync the name to mobile's canonical `products/<slug>` when it
  // actually changed — every price/image/description edit otherwise triggers
  // a redundant write that fans through every connected listener.
  if (nameChanged) {
    // If the slug changed too (i.e. the rename wasn't just a casing tweak),
    // the OLD `products/<oldSlug>` doc still exists in Firestore and would
    // come back on the next `products` snapshot as a doc whose name no
    // longer matches any portal product — re-spawning a phantom. Delete it
    // before writing the new slug.
    const oldSlug = slugifyName(oldName);
    const newSlug = slugifyName(p.name);
    if (oldSlug && oldSlug !== newSlug) {
      void deletePortalDoc('products', oldSlug);
    }
    syncProductNameToMobile(p.name);
  }
};

/**
 * Ensure a portal Product draft exists for this name. Called automatically
 * when a new product appears in mobile's canonical `products` Firestore
 * collection (e.g. user typed a new product on a bill). The resulting draft
 * has source='billmaker' and stays hidden from clients until admin enriches
 * it with prices/description/labels.
 *
 * Two-stage lookup to avoid phantom-duplicates:
 *   1. SYNC fast path: check normalized name against local store.
 *   2. ASYNC fallback: if local doesn't have it, query Firestore directly
 *      via lookupProductByName (which uses the indexed `nameLower` field).
 *      Catches the case where the keeper exists in Firestore but is outside
 *      the live subscription's top-50 window — without this check, we'd
 *      wrongly create a duplicate.
 *
 * Returns Promise<boolean> — true if a new product was created, false if
 * the name was already known (either locally or in Firestore).
 *
 * Hydration side-effect: when we find a remote keeper, we add it to the
 * local store so subsequent ensureProductByName calls for the same name
 * hit the sync fast path. Avoids re-querying Firestore on every cycle.
 */
// Safety flag — when false, ensureProductByName will NOT create new portal_products
// drafts. Used to stop the phantom-creation bleed while we backfill legacy docs
// that lack the `nameLower` index. Default true (normal behavior). Persisted in
// localStorage so the setting survives reloads.
const ENSURE_PRODUCTS_FLAG_KEY = 'billmaker-ensure-products-enabled';
let ensureProductsEnabled = (() => {
  try {
    const v = localStorage.getItem(ENSURE_PRODUCTS_FLAG_KEY);
    return v === null ? true : v === 'true';
  } catch { return true; }
})();

export const isEnsureProductsEnabled = (): boolean => ensureProductsEnabled;
export const setEnsureProductsEnabled = (enabled: boolean): void => {
  ensureProductsEnabled = enabled;
  try { localStorage.setItem(ENSURE_PRODUCTS_FLAG_KEY, String(enabled)); } catch {}
};

// Cache of names verified to exist in Firestore this session. Skips repeat
// Firestore reads from every mobile-products snapshot fire — without this,
// 50 names × every snapshot would mean 50 wasted reads each time.
const verifiedRemoteNames = new Set<string>();

export const ensureProductByName = async (name: string): Promise<boolean> => {
  const trimmed = name.trim();
  if (!trimmed) return false;
  // Bleed-stop: when disabled, we don't auto-create drafts.
  if (!ensureProductsEnabled) return false;

  const keyId = await productKey(trimmed);
  const normalized = normalizeProductName(trimmed);

  // SYNC fast path 1: already verified to exist in Firestore this session.
  if (verifiedRemoteNames.has(normalized)) return false;

  // SYNC fast path 2: already in local store (which is the windowed top-50).
  const localExists = store.products.find(
    p => p.id === keyId || normalizeProductName(p.name) === normalized,
  );
  if (localExists) {
    verifiedRemoteNames.add(normalized);
    return false;
  }

  // ASYNC: check Firestore. If the doc already exists at this key, do
  // NOTHING — don't push to local store (would bloat the windowed view),
  // don't re-write (setDoc with merge:true and empty defaults would wipe
  // existing enrichment).
  const remote = await lookupProductByName(normalized);
  if (remote && remote.id) {
    verifiedRemoteNames.add(normalized);
    return false;
  }

  const prices: Partial<Record<CustomerClass, number>> = {};
  const enabledClasses: Partial<Record<CustomerClass, boolean>> = {};
  for (const def of store.classDefs) {
    prices[def.code] = 0;
    enabledClasses[def.code] = false;
  }
  const newProduct: Product = {
    id: keyId,
    name: trimmed,
    description: '',
    labelIds: [],
    prices,
    enabledClasses,
    visibleToClient: false,
    source: 'billmaker',
    inStock: true,
    images: [],
  };
  // Optimistic local insert. The cache also receives the entry so the UI
  // sees it immediately. setDoc with merge:true on the same key is idempotent
  // — parallel calls for the same name resolve to the same doc.
  store.products.push(newProduct);
  notify();
  void pushPortalDoc('portal_products', keyId, newProduct);
  void cachePut(newProduct);
  syncProductNameToMobile(newProduct.name);
  patchAdminAggregates({ productCountDelta: 1 });
  return true;
};

/**
 * Bulk-delete portal_products by id. Optimistically removes from the local
 * store, then fans out Firestore deletes in small parallel batches (to avoid
 * hammering the SDK / rate limits). Each Firestore delete schedules a
 * reconcile sync on the worker (see deletePortalDoc → scheduleSync), so the
 * Supabase replica converges automatically afterwards.
 *
 * Used by the "Catalog cleanup" tool in Admin Settings to deduplicate phantom
 * drafts created by the pre-fix ensureProductByName loop. Also exposed on
 * window.__billmakerBulkDeleteProducts for power-user console workflows.
 */
export const bulkDeleteProducts = async (
  ids: string[],
  onProgress?: (deleted: number, total: number) => void,
): Promise<{ deleted: number; failed: number; failedIds: string[]; slugsDeleted: number }> => {
  const idSet = new Set(ids);
  if (idSet.size === 0) return { deleted: 0, failed: 0, failedIds: [], slugsDeleted: 0 };

  // Capture each deleted product's name BEFORE splicing — we use these to
  // also clean up the matching `products/<slug>` docs after the main
  // delete loop. Without that second phase, stale slug docs whose names
  // don't normalize-match any surviving keeper would re-trigger
  // ensureProductByName on every cold portal session, re-spawning the
  // same phantoms forever (the "36/43 daily ghosts" loop).
  const nameById = new Map<string, string>();
  for (const p of store.products) {
    if (idSet.has(p.id)) nameById.set(p.id, p.name);
  }

  // Optimistic local removal — splice in reverse so indexes stay valid.
  const before = store.products.length;
  for (let i = store.products.length - 1; i >= 0; i--) {
    if (idSet.has(store.products[i].id)) store.products.splice(i, 1);
  }
  const removed = before - store.products.length;
  // Drop the cache entries too — without this, AdminProducts (which reads
  // from cache after the architecture refactor) would still show the deleted
  // products until the next refetch.
  for (const id of idSet) void cacheDelete(id);
  if (removed > 0) patchAdminAggregates({ productCountDelta: -removed });
  notify();

  // Parallel batches of 10 — keeps things snappy without flooding Firestore.
  const BATCH = 10;
  const idArr = Array.from(idSet);
  const failedIds: string[] = [];
  let processed = 0;
  for (let i = 0; i < idArr.length; i += BATCH) {
    const chunk = idArr.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      chunk.map(id => deletePortalDoc('portal_products', id)),
    );
    results.forEach((r, idx) => {
      if (r.status === 'rejected') failedIds.push(chunk[idx]);
    });
    processed += chunk.length;
    onProgress?.(processed, idArr.length);
  }

  // Phase 2: delete the matching slug docs from the mobile-canonical
  // `products/` collection. Safe because:
  //   - The KEEPER portal_product is unaffected (it lives in portal_products,
  //     not in the slug collection).
  //   - Mobile autocomplete uses its own local products.json — not Firestore
  //     reads — so losing a slug doc doesn't break mobile UX.
  //   - If mobile types this name on a future bill, addProductsBatch will
  //     re-create the slug doc; portal then discovers it via the subscription
  //     and normalize-matches the keeper → no phantom.
  // Slugs may collide between keeper and phantom (same name → same slug);
  // we dedupe to one delete per unique slug so no wasted writes.
  const uniqueSlugs = new Set<string>();
  for (const name of nameById.values()) {
    const s = slugifyName(name);
    if (s && s !== 'unnamed') uniqueSlugs.add(s);
  }
  let slugsDeleted = 0;
  const slugArr = Array.from(uniqueSlugs);
  for (let i = 0; i < slugArr.length; i += BATCH) {
    const chunk = slugArr.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      chunk.map(slug => deletePortalDoc('products', slug)),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') slugsDeleted++;
    }
  }

  return { deleted: removed, failed: failedIds.length, failedIds, slugsDeleted };
};

export const canProductBeVisible = (p: Product): boolean => {
  const hasName = !!p.name.trim();
  const hasDescription = !!p.description.trim();
  // Only consider currently-active classes — iterating ALL_CLASS_CODES would
  // also count classes the admin has removed.
  const activeCodes = store.classDefs.map(d => d.code);
  const anyClassEnabled = activeCodes.some(c => !!p.enabledClasses[c]);
  const anyPrice = activeCodes.some(c => (p.prices[c] || 0) > 0);
  return hasName && hasDescription && anyClassEnabled && anyPrice;
};

export const toggleProductVisibility = (productId: string): { ok: boolean; reason?: string } => {
  const p = store.products.find(p => p.id === productId);
  if (!p) return { ok: false, reason: 'Not found' };
  if (!p.visibleToClient) {
    if (!canProductBeVisible(p)) {
      return { ok: false, reason: 'Need name, description, at least one enabled class with a non-zero price.' };
    }
  }
  p.visibleToClient = !p.visibleToClient;
  notify();
  void pushPortalDoc('portal_products', p.id, p);
  return { ok: true };
};

// ===== Labels =====
export const addLabel = (name: string, color: Label['color']) => {
  const l: Label = { id: id('l'), name: name.trim(), color };
  store.labels.push(l);
  notify();
  void pushPortalDoc('portal_labels', l.id, { id: l.id, name: l.name, color: l.color });
  return l;
};

export const updateLabel = (labelId: string, patch: Partial<Pick<Label, 'name' | 'color'>>) => {
  const l = store.labels.find(l => l.id === labelId);
  if (!l) return;
  if (patch.name !== undefined) l.name = patch.name.trim();
  if (patch.color !== undefined) l.color = patch.color;
  notify();
  void pushPortalDoc('portal_labels', l.id, { id: l.id, name: l.name, color: l.color });
};

export const deleteLabel = (labelId: string) => {
  const idx = store.labels.findIndex(l => l.id === labelId);
  if (idx >= 0) store.labels.splice(idx, 1);
  // Strip from any products that referenced it — and push those products too.
  const affectedProducts: Product[] = [];
  for (const p of store.products) {
    if (p.labelIds.includes(labelId)) {
      p.labelIds = p.labelIds.filter(id => id !== labelId);
      affectedProducts.push(p);
    }
  }
  notify();
  void deletePortalDoc('portal_labels', labelId);
  for (const p of affectedProducts) void pushPortalDoc('portal_products', p.id, p);
};

// ===== Deals =====

/**
 * Resolve the effective price for a product within a deal, for a given class.
 * Order of precedence:
 *   1. Explicit per-class override in `deal.items[i].prices[code]`
 *   2. Product's normal price × (1 − deal.discountPct), if discountPct > 0
 *   3. Product's normal price for that class
 */
export interface DealPriceResolution {
  /** The effective price the client should pay. */
  price: number;
  /** The product's normal Class price (for showing strike-through). */
  original: number;
  /** True if the price comes from an explicit override (not just the discount). */
  isOverride: boolean;
  /** True if any kind of deal pricing applies (override OR discount on this row). */
  isDiscounted: boolean;
}

export const dealPriceFor = (deal: Deal, product: Product, code: CustomerClass): DealPriceResolution => {
  const original = Number(product.prices[code] || 0);
  const item = deal.items.find(i => i.productId === product.id);
  const overrideRaw = item ? item.prices[code] : undefined;
  if (overrideRaw !== undefined && overrideRaw !== null && !isNaN(Number(overrideRaw))) {
    return { price: Number(overrideRaw), original, isOverride: true, isDiscounted: true };
  }
  if (deal.discountPct > 0 && original > 0) {
    return { price: original * (1 - deal.discountPct / 100), original, isOverride: false, isDiscounted: true };
  }
  return { price: original, original, isOverride: false, isDiscounted: false };
};

export const addDeal = (input: Omit<Deal, 'id'>) => {
  const deal: Deal = { ...input, id: id('d') };
  store.deals.push(deal);
  notify();
  void pushPortalDoc('portal_deals', deal.id, deal);
  patchAdminAggregates({ dealCountDelta: 1 });
  return deal;
};

export const updateDeal = (dealId: string, patch: Partial<Deal>) => {
  const d = store.deals.find(d => d.id === dealId);
  if (!d) return;
  Object.assign(d, patch);
  notify();
  void pushPortalDoc('portal_deals', d.id, d);
};

export const deleteDeal = (dealId: string) => {
  const idx = store.deals.findIndex(d => d.id === dealId);
  if (idx >= 0) store.deals.splice(idx, 1);
  notify();
  void deletePortalDoc('portal_deals', dealId);
  patchAdminAggregates({ dealCountDelta: -1 });
};

// ===== Firestore snapshot appliers (called by lib/firestoreSync.ts) =====

/**
 * Rebuilds `store.rawCustomers` from the current bills + Firestore-derived
 * customer names. Each unique customer name in bills becomes a raw entry with
 * a billCount. Existing admin merge-links (linkedCustomerId) are preserved.
 * Auto-links to a canonical customer when the name matches exactly
 * (case-insensitive) — admin can still manually re-link via the UI.
 */
export const rebuildRawCustomers = (): void => {
  const counts = new Map<string, number>();
  // Group bills by customerName
  for (const b of store.bills) {
    const name = (b.customerName || '').trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  // Also include any customer names known via the Firestore `customers` collection
  // that may not have an associated bill yet (rare but possible).
  //
  // AND include customer aliases — these are raw names that the admin has
  // explicitly linked to a canonical. Without this, after linkRawCustomers
  // rewrites bills, the original raw name has no bill-derived source and
  // would vanish from the Manage Customers list, hiding the linked entry
  // (and the Unlink button on it).
  for (const c of store.customers) {
    if (!counts.has(c.name)) counts.set(c.name, 0);
    for (const a of c.aliases || []) {
      if (!counts.has(a)) counts.set(a, 0);
    }
  }

  // Preserve admin merge-links AND the manual-unlink markers. Without the
  // manual-unlink preservation, a raw that was just explicitly unlinked
  // would fall through to the auto-link branch below, immediately re-linking
  // itself to a canonical that still shares its name.
  const priorLinks = new Map<string, string>();
  const manuallyUnlinkedRaws = new Set<string>();
  for (const r of store.rawCustomers) {
    if (r.linkedCustomerId) priorLinks.set(r.rawName, r.linkedCustomerId);
    if (r.manuallyUnlinked) manuallyUnlinkedRaws.add(r.rawName);
  }

  const next: RawCustomer[] = [];
  for (const [rawName, billCount] of counts) {
    let linkedCustomerId = priorLinks.get(rawName);
    const manuallyUnlinked = manuallyUnlinkedRaws.has(rawName);
    if (!linkedCustomerId && !manuallyUnlinked) {
      // Auto-link when an exact (case-insensitive) match exists. Skipped for
      // raws the admin explicitly unlinked — their intent should stick.
      const lower = rawName.toLowerCase();
      const match = store.customers.find(
        c =>
          c.name.toLowerCase() === lower ||
          (c.aliases || []).some(a => a.toLowerCase() === lower),
      );
      if (match) linkedCustomerId = match.id;
    }
    next.push({
      rawName,
      billCount,
      linkedCustomerId,
      ...(manuallyUnlinked ? { manuallyUnlinked: true } : {}),
    });
  }

  store.rawCustomers.length = 0;
  store.rawCustomers.push(...next);
};

/** Replace `store.bills` with the latest from Firestore. Preserves `acknowledged` flag locally. */
/**
 * Additive merge for bills that came from a one-time loader query (NOT the
 * live subscription). Used by `loadBillsForDateRange` in firestoreSync to
 * append older bills to the local store without the live-subscription
 * reconcile dropping them on its next fire.
 *
 * Schema-wise this is the same transform as applyBillsSnapshot — it just
 * merges instead of replacing and leaves `lastRemoteIds['bills']` untouched
 * so reconcileByKey treats these as "freshly added local" (preserved) on the
 * next subscription fire.
 */
export const mergeBillsSnapshot = (docs: any[]): void => {
  const incoming = transformBillDocs(docs);
  if (incoming.length === 0) return;
  const byId = new Map(store.bills.map(b => [b.id, b]));
  for (const b of incoming) {
    // Keep existing ack state if already known — meta doc subscription
    // populated it.
    const existing = byId.get(b.id);
    if (existing) {
      b.acknowledged = existing.acknowledged;
      b.acknowledgedAt = existing.acknowledgedAt;
    }
    byId.set(b.id, b);
  }
  store.bills.length = 0;
  store.bills.push(...byId.values());
  recomputeBillPaidFromPayments();
  rebuildRawCustomers();
};

/**
 * Shared bill transform — turns raw Firestore docs into Bill[] honoring the
 * customer-name → id backfill, mobile field aliases (prefix/price), and the
 * archived-customer filter. Used by both applyBillsSnapshot (replace) and
 * mergeBillsSnapshot (additive).
 */
/**
 * Coerce any timestamp-ish value to an ISO string. Handles:
 *   - ISO strings (passthrough)
 *   - JS Date objects (.toISOString())
 *   - Firestore Timestamp objects (.toDate().toISOString())
 *   - numbers (ms epoch → Date → ISO)
 * Returns empty string for invalid/null/undefined.
 */
const toIsoString = (v: any): string => {
  if (typeof v === 'string') return v;
  if (v instanceof Date) {
    return isNaN(v.getTime()) ? '' : v.toISOString();
  }
  // Firestore Timestamp duck-type
  if (v && typeof v === 'object' && typeof v.toDate === 'function') {
    try {
      const d = v.toDate();
      return d instanceof Date && !isNaN(d.getTime()) ? d.toISOString() : '';
    } catch { return ''; }
  }
  if (typeof v === 'number') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? '' : d.toISOString();
  }
  return '';
};

const transformBillDocs = (docs: any[]): Bill[] => {
  // Ack source order:
  //   1. billsMetaMap — the portal_bills_meta live subscription's source of
  //      truth, kept current as meta changes.
  //   2. existing store.bills as fallback (for the edge case where a bill
  //      was loaded but its meta hasn't fired yet — preserves in-flight UI
  //      state).
  const ackMap = new Map<string, { acknowledged: boolean; acknowledgedAt?: string }>();
  for (const b of store.bills) ackMap.set(b.id, { acknowledged: b.acknowledged, acknowledgedAt: b.acknowledgedAt });
  // billsMetaMap takes precedence — it's the authoritative source.
  for (const [id, meta] of billsMetaMap) ackMap.set(id, meta);

  const nameToId = new Map<string, string>();
  for (const c of store.customers) {
    nameToId.set(c.name.toLowerCase(), c.id);
    for (const a of c.aliases || []) nameToId.set(a.toLowerCase(), c.id);
  }

  const reviveItems = (raw: any): BillItem[] => {
    const arr = Array.isArray(raw?.products) ? raw.products : Array.isArray(raw?.items) ? raw.items : [];
    return arr.map((it: any) => {
      const quantityNum = Number(it?.quantity || it?.qty || 0);
      const rateNum = Number(it?.rate || it?.price || 0);
      return {
        productName: it?.name || it?.productName || '',
        quantity: quantityNum,
        unit: it?.unit || it?.prefix || 'Pieces',
        rate: rateNum,
        amount: Number(it?.amount) || quantityNum * rateNum || 0,
      };
    });
  };

  const archivedBillIds = new Set<string>();
  const archivedNamesLower = new Set<string>();
  const archivedNameSlugs = new Set<string>();
  const slugify = (s: string) =>
    s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  for (const a of store.archive) {
    for (const b of a.bills || []) {
      if (b.id) archivedBillIds.add(b.id);
    }
    if (a.customer?.name) {
      const n = a.customer.name;
      archivedNamesLower.add(n.toLowerCase());
      archivedNameSlugs.add(slugify(n));
    }
    for (const alias of a.customer?.aliases || []) {
      archivedNamesLower.add(alias.toLowerCase());
      archivedNameSlugs.add(slugify(alias));
    }
  }

  const result: Bill[] = [];
  for (const d of docs) {
    const bid = d._id || d.id;
    if (!bid) continue;
    const items = reviveItems(d);
    const total = Number(d.total ?? items.reduce((s, i) => s + i.amount, 0));
    // bill.paid is now derived from bill.payments[] (Deploy 5).
    // Embedded payments are the source of truth; fallback to d.paid for any
    // pre-Deploy-5 bill that hasn't been migrated.
    const embeddedPayments = Array.isArray(d.payments) ? d.payments : [];
    const paidFromEmbedded = embeddedPayments.reduce(
      (s: number, p: any) => s + (Number(p?.amount) || 0), 0,
    );
    const paid = embeddedPayments.length > 0
      ? paidFromEmbedded
      : Number(d.paid ?? 0);
    const ack = ackMap.get(bid);
    const customerName = (d.customerName || '').toString().trim();
    if (archivedBillIds.has(bid)) continue;
    if (archivedNamesLower.has(customerName.toLowerCase())) continue;
    if (archivedNameSlugs.has(slugify(customerName))) continue;
    const resolvedId =
      d.customerId ||
      nameToId.get(customerName.toLowerCase()) ||
      '';
    result.push({
      id: bid,
      billNumber: d.billNumber || d.number || bid,
      customerId: resolvedId,
      customerName,
      items,
      total,
      paid,
      // Defensively coerce createdAt to an ISO string. Mobile's repair-sync
      // pushed Bill objects with Date values, which Firestore converts to
      // Timestamps. Without this normalization, downstream `.slice(0, 10)`
      // calls (AdminStatements, AdminBills sort, etc.) throw.
      createdAt: toIsoString(d.createdAt) || toIsoString(d.created_at) || new Date().toISOString(),
      // Ack lives on the bill doc itself. The store.bills fallback below
      // preserves UI ack state during in-flight writes.
      acknowledged: typeof d.acknowledged === 'boolean' ? d.acknowledged : (ack?.acknowledged ?? false),
      acknowledgedAt: (typeof d.acknowledged === 'boolean' ? (d.acknowledgedAt || undefined) : ack?.acknowledgedAt),
      // Lineage marker from linkRawCustomers; `|| undefined` so null/empty
      // (from a previous unlink push) reads as "no lineage" rather than
      // an empty string that would never match a rawName.
      linkedFromName: d.linkedFromName || undefined,
    });
  }
  return result;
};

export const applyBillsSnapshot = (docs: any[]): void => {
  const next = transformBillDocs(docs);
  store.bills.length = 0;
  store.bills.push(...next);
  // Deploy 5: payments live inside bills.payments[]. Extract them into
  // store.payments so legacy consumers (AdminStatements, archive flow) keep
  // working without a separate payments subscription. This is the SINGLE
  // source of truth — no more recomputeBillPaidFromPayments needed.
  const allPayments: Payment[] = [];
  for (const d of docs) {
    const bid = (d._id || d.id || '').toString();
    if (!bid) continue;
    const embedded = Array.isArray(d.payments) ? d.payments : [];
    for (const p of embedded) {
      if (!p?.id) continue;
      allPayments.push({
        id: String(p.id),
        billId: bid,
        amount: Number(p.amount) || 0,
        receivedAt: typeof p.receivedAt === 'string' ? p.receivedAt : new Date().toISOString(),
        method: p.method ?? null,
        note: p.note ?? null,
        createdByProfileId: p.createdByProfileId ?? null,
        createdByProfileName: p.createdByProfileName ?? null,
      });
    }
  }
  store.payments.length = 0;
  store.payments.push(...allPayments);
  rebuildRawCustomers();
};

/**
 * Re-applies the archived-customer filter to `store.bills` immediately, without
 * waiting for the next Firestore snapshot. Call this from archive/restore
 * actions so the UI updates instantly.
 */
const dropArchivedBillsLocally = (): void => {
  const archivedNames = new Set<string>();
  for (const a of store.archive) {
    if (a.customer?.name) archivedNames.add(a.customer.name.toLowerCase());
    for (const alias of a.customer?.aliases || []) archivedNames.add(alias.toLowerCase());
  }
  if (archivedNames.size === 0) return;
  for (let i = store.bills.length - 1; i >= 0; i--) {
    const name = (store.bills[i].customerName || '').toLowerCase();
    if (archivedNames.has(name)) store.bills.splice(i, 1);
  }
};

/**
 * Re-resolve every bill's `customerId` from its `customerName`. Called whenever
 * the customer set changes (new customer added, name edited, merge happened) so
 * client-portal filters keep working without waiting for the next Firestore push.
 */
export const relinkBillsToCustomers = (): void => {
  const nameToId = new Map<string, string>();
  for (const c of store.customers) {
    nameToId.set(c.name.toLowerCase(), c.id);
    for (const a of c.aliases || []) nameToId.set(a.toLowerCase(), c.id);
  }
  let touched = 0;
  for (const b of store.bills) {
    const found = nameToId.get((b.customerName || '').toLowerCase());
    if (found && b.customerId !== found) {
      b.customerId = found;
      touched++;
    }
  }
  if (touched > 0) notify();
};

/**
 * Sum the `payments` collection per billId and write the result back to each
 * matching `bill.paid`. Mobile is authoritative on payments — it never stores
 * `paid` on a bill, so the portal has to re-derive it the same way.
 */
export const recomputeBillPaidFromPayments = (): void => {
  const totals = new Map<string, number>();
  for (const p of store.payments) {
    if (!p.billId) continue;
    totals.set(p.billId, (totals.get(p.billId) || 0) + (Number(p.amount) || 0));
  }
  for (const b of store.bills) {
    const sum = totals.get(b.id) || 0;
    // Use the larger of (Firestore bill.paid, sum-of-payments). Some bills may
    // be marked paid directly (e.g. "Settle Outstanding" wrote paid=total)
    // without a payment record — don't undo those.
    const next = Math.max(Number(b.paid) || 0, sum);
    if (b.paid !== next) b.paid = next;
  }
};

/** Replace `store.payments` with the latest from Firestore + re-derive bill.paid. */
export const applyPaymentsSnapshot = (docs: any[]): void => {
  const next: Payment[] = docs
    .map((d: any) => ({
      id: d._id || d.id,
      billId: (d.billId || '').toString(),
      amount: Number(d.amount) || 0,
      receivedAt: d.receivedAt || new Date().toISOString(),
      method: d.method ?? null,
      note: d.note ?? null,
      createdByProfileId: d.createdByProfileId ?? null,
      createdByProfileName: d.createdByProfileName ?? null,
    }))
    .filter(p => p.id && p.billId);
  store.payments.length = 0;
  store.payments.push(...next);
  recomputeBillPaidFromPayments();
};

/** @deprecated The portal no longer subscribes to mobile's `customers`
 *  collection (it was eating Firestore reads and auto-creating portal customer
 *  stubs, which violates the "admin-only customer creation" rule). Kept as a
 *  no-op so any lingering import doesn't crash. */
export const applyCustomersSnapshot = (_docs: any[]): void => {};

/**
 * Sync incoming product names from mobile's canonical `products` collection.
 * Unlike customers (admin-only creation), products from mobile bills SHOULD
 * auto-appear in the admin's Products tab as drafts (source: 'billmaker')
 * — admin then enriches them with prices, descriptions, images, labels.
 */
export const applyProductsSnapshot = (docs: any[]): void => {
  // ensureProductByName is now async (does a Firestore lookup on local miss
  // to avoid creating phantoms when the keeper is outside the live
  // subscription window). Fire-and-forget per slug doc — each name resolves
  // independently in parallel, the subscription handler returns immediately.
  for (const d of docs) {
    const name = (d?.name || '').toString().trim();
    if (!name) continue;
    void ensureProductByName(name);
  }
};

export const applyBusinessInfo = (data: any): void => {
  store.business = {
    name: data?.name,
    phone: data?.phone,
    address: data?.address,
    gst: data?.gst,
  };
};

// ===== Helpers =====
export const fmtINR = (n: number) =>
  `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Indian-system compact currency. Returns "₹85k", "₹1.2L", "₹2 Cr" etc.
 * Use where stat-card width is constrained (e.g. mobile) — pair with fmtINR
 * to show the exact value in smaller text below.
 *
 * Rules:
 *   < 1,000           → exact (₹500)
 *   1,000  – 99,999   → "Xk" (₹85k, ₹12.5k)
 *   1,00,000 – 99,99,999 → "XL" (₹1.2L, ₹21L)
 *   ≥ 1,00,00,000    → "X Cr" (₹2.5 Cr)
 */
export const fmtINRCompact = (n: number): string => {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs < 1000) {
    return `${sign}₹${Math.round(abs)}`;
  }
  if (abs < 100_000) {
    const v = abs / 1000;
    return `${sign}₹${v >= 10 ? Math.round(v) : v.toFixed(1)}k`;
  }
  if (abs < 1_00_00_000) {
    const v = abs / 100_000;
    return `${sign}₹${v >= 10 ? Math.round(v) : v.toFixed(1)}L`;
  }
  const v = abs / 1_00_00_000;
  return `${sign}₹${v >= 10 ? Math.round(v) : v.toFixed(2)} Cr`;
};

export const labelColorClasses: Record<Label['color'], string> = {
  sky: 'bg-sky-100 text-sky-700 border-sky-200',
  indigo: 'bg-indigo-100 text-indigo-700 border-indigo-200',
  emerald: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  amber: 'bg-amber-100 text-amber-700 border-amber-200',
  rose: 'bg-rose-100 text-rose-700 border-rose-200',
  violet: 'bg-violet-100 text-violet-700 border-violet-200',
  slate: 'bg-slate-200 text-slate-700 border-slate-300',
  cyan: 'bg-cyan-100 text-cyan-700 border-cyan-200',
};
