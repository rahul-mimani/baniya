import { Filesystem, Encoding } from '@capacitor/filesystem';
import { Bill } from '../types';
import { addCustomer } from './customerStorage';
import { addProduct } from './productStorage';
import { APP_DIR, initFile } from './paths';
import { pushDocMerge, deleteDoc, computeBillTotal, triggerWorkerSync } from './sync';
import { log } from '../utils/diagnostics';

const FILE_NAME = 'bills.json';

export const serializeBillForSync = (b: Bill): any => serializeBill(b);

const serializeBill = (b: Bill): any => ({
  id: b.id,
  billNumber: b.billNumber,
  customerName: b.customerName,
  // customerId is INTENTIONALLY OMITTED. It's portal-set (when admin links a
  // bill to a portal_customer). Mobile doesn't know it, and writing '' here
  // would wipe portal-set values via merge. Mobile bills will simply lack
  // the field until admin links them.
  products: b.products,
  // Bill total cached on the doc so the portal can sum across all bills
  // without iterating products. Recomputed on every save so it stays in sync
  // even when a line item is edited.
  total: computeBillTotal(b.products),
  createdAt: b.createdAt.toISOString(),
  updatedAt: b.updatedAt.toISOString(),
  createdByProfileId: b.createdByProfileId ?? null,
  createdByProfileName: b.createdByProfileName ?? null,
  acknowledged: b.acknowledged === true,
  acknowledgedAt: b.acknowledgedAt ? b.acknowledgedAt.toISOString() : null,
});

/**
 * Narrow serializer for the UPDATE path. Sends ONLY the fields mobile owns,
 * so concurrent admin actions (Release toggle, payment append) on the same
 * bill aren't clobbered by stale local state in mobile's merge payload.
 *
 * Ownership model:
 *   Mobile owns:  customerName, products, total, updatedAt
 *   Admin owns:   acknowledged, acknowledgedAt, customerId
 *   Either via field-level write:
 *     - payments[]  → arrayUnion/arrayRemove (additive, no replace)
 *     - acknowledged → mobile's toggleBillAcknowledged uses a narrow write too
 *
 * Excluded from this payload but harmless because they never change after
 * the initial create: id, billNumber, createdAt, createdByProfileId,
 * createdByProfileName.
 */
const serializeBillForUpdate = (b: Bill): any => ({
  customerName: b.customerName,
  products: b.products,
  total: computeBillTotal(b.products),
  updatedAt: b.updatedAt.toISOString(),
});

export const initStorage = async () => {
  await initFile(FILE_NAME, '[]');
};

/** 📖 Read all bills (defensive — coerces older shapes / missing fields). */
export const getBills = async (): Promise<Bill[]> => {
  try {
    const result = await Filesystem.readFile({
      path: FILE_NAME,
      directory: APP_DIR,
      encoding: Encoding.UTF8,
    });

    const dataStr =
      typeof result.data === 'string'
        ? result.data
        : await result.data.text();

    const raw = JSON.parse(dataStr);
    if (!Array.isArray(raw)) return [];

    const parseDate = (v: any): Date => {
      if (v instanceof Date) return v;
      if (typeof v === 'string' || typeof v === 'number') {
        const d = new Date(v);
        if (!isNaN(d.getTime())) return d;
      }
      return new Date();
    };

    return raw.map((b: any, i: number) => {
      const products = Array.isArray(b?.products)
        ? b.products.map((p: any, j: number) => ({
            id: p?.id != null ? String(p.id) : `${Date.now()}-${i}-${j}`,
            name: typeof p?.name === 'string' ? p.name : '',
            prefix: p?.prefix === 'Pieces' ? 'Pieces' : 'Box',
            quantity: p?.quantity != null ? String(p.quantity) : '0',
            price: p?.price != null ? String(p.price) : '0',
          }))
        : [];

      const isDraft = b?.isDraft === true;
      return {
        id: b?.id != null ? String(b.id) : `legacy-${i}`,
        // Drafts have NO bill number — keep it empty across reads. The
        // legacy fallback to `LE-{i+1}` only kicks in for non-draft bills
        // that lost their billNumber somehow.
        billNumber:
          typeof b?.billNumber === 'string' && b.billNumber.trim()
            ? b.billNumber
            : isDraft
              ? ''
              : `LE-${String(i + 1).padStart(7, '0')}`,
        customerName: typeof b?.customerName === 'string' ? b.customerName : 'Unknown',
        products,
        createdAt: parseDate(b?.createdAt),
        updatedAt: parseDate(b?.updatedAt ?? b?.createdAt),
        createdByProfileId: typeof b?.createdByProfileId === 'string' ? b.createdByProfileId : undefined,
        createdByProfileName: typeof b?.createdByProfileName === 'string' ? b.createdByProfileName : undefined,
        // Preserve release state across reads. Without these two lines,
        // getBills strips acknowledged + acknowledgedAt and the Release
        // button reverts to "Release to client" after every refresh/remount.
        acknowledged: b?.acknowledged === true,
        acknowledgedAt: b?.acknowledgedAt ? parseDate(b.acknowledgedAt) : undefined,
        // Preserve the local-only draft flag across reads.
        ...(isDraft ? { isDraft: true } : {}),
      } as Bill;
    });
  } catch (error) {
    console.error('Error reading bills:', error);
    return [];
  }
};


/** 💾 Save all bills */
export const saveBills = async (bills: Bill[]) => {
  const jsonData = JSON.stringify(bills, null, 2);
  await Filesystem.writeFile({
    path: FILE_NAME,
    data: jsonData,
    directory: APP_DIR,
    encoding: Encoding.UTF8,
  });
};

/** ➕ Add a new bill.
 *  Phase B: ONE Firestore write (bills/<id>). The auth-service worker
 *  derives customers, products, portal_products, admin_aggregates, and
 *  portal_customer.outstanding from this single write on next sync.
 *  Local autocomplete caches (customers.json / products.json) are still
 *  updated synchronously for instant in-app search. */
export const addBill = async (newBill: Bill): Promise<void> => {
  log('info', 'bills', `addBill id=${newBill.id} customer="${newBill.customerName}" products=${newBill.products.length} total=${computeBillTotal(newBill.products)}`);
  const bills = await getBills();
  bills.push(newBill);
  await saveBills(bills);
  // Local-only cache updates for autocomplete. These no longer push to
  // Firestore (worker derives instead).
  try { await addCustomer(newBill.customerName); } catch (e) { console.warn('addCustomer failed during addBill:', e); }
  for (const product of newBill.products) {
    try { await addProduct(product.name); } catch (e) { console.warn('addProduct failed during addBill:', e); }
  }
  // ONE Firestore write. Merge so portal-set fields (acknowledged,
  // acknowledgedAt, customerId when admin links the customer) survive any
  // future re-push from mobile.
  await pushDocMerge('bills', newBill.id, serializeBill(newBill));
  // Fire-and-forget worker trigger for ~1-2s cross-device propagation via
  // Supabase Realtime (instead of waiting up to 2 min for next cron tick).
  void triggerWorkerSync('bills');
};

/** 📝 Save a bill as a LOCAL-ONLY DRAFT.
 *  Mirrors addBill but skips every Firestore touch. Used when:
 *    - the device is offline and the user wants to preserve their work
 *    - the bill isn't ready for a final number yet
 *  No billNumber is assigned (caller passes ''); isDraft is set to true.
 *  Autocomplete caches still update so the typed customer + products
 *  appear in suggestions across the rest of the app immediately. */
export const addDraftBill = async (newBill: Bill): Promise<void> => {
  log('info', 'bills', `addDraftBill id=${newBill.id} customer="${newBill.customerName}" products=${newBill.products.length} (local-only)`);
  const bills = await getBills();
  bills.push({ ...newBill, isDraft: true });
  await saveBills(bills);
  try { await addCustomer(newBill.customerName); } catch (e) { console.warn('addCustomer failed during addDraftBill:', e); }
  for (const product of newBill.products) {
    try { await addProduct(product.name); } catch (e) { console.warn('addProduct failed during addDraftBill:', e); }
  }
  // No pushDocMerge / triggerWorkerSync — that's the point.
};

/** ✏️ Update a bill by ID.
 *  Phase B: ONE Firestore write. Pushes the NARROW field set (mobile-owned
 *  fields only — see serializeBillForUpdate) so concurrent admin actions
 *  on the same bill (Release toggle, payment append) don't get clobbered
 *  by stale local state in mobile's merge payload. */
export const updateBill = async (updatedBill: Bill): Promise<any> => {
  log('info', 'bills', `updateBill id=${updatedBill.id} customer="${updatedBill.customerName}" products=${updatedBill.products.length} total=${computeBillTotal(updatedBill.products)} ack=${updatedBill.acknowledged === true}`);
  const bills = await getBills();
  const index = bills.findIndex(b => b.id === updatedBill.id);
  if (index !== -1) {
    bills[index] = updatedBill;
    await saveBills(bills);
    try { await addCustomer(updatedBill.customerName); } catch (e) { console.warn('addCustomer failed during updateBill:', e); }
    for (const product of updatedBill.products) {
      try { await addProduct(product.name); } catch (e) { console.warn('addProduct failed during updateBill:', e); }
    }
    // Drafts stay local-only — no Firestore touch until handleSyncDraft
    // finalises them. updateBill on a draft is just "save edits to the
    // local draft", same shape as addDraftBill.
    if (updatedBill.isDraft === true) {
      log('info', 'bills', `updateBill id=${updatedBill.id} kept as draft (no Firestore push)`);
      return;
    }
    // Narrow merge — only fields mobile owns. The ack fields (admin domain)
    // and payments[] (additive via arrayUnion) are preserved server-side
    // even if our local copy is stale.
    await pushDocMerge('bills', updatedBill.id, serializeBillForUpdate(updatedBill));
    void triggerWorkerSync('bills');
  } else {
    console.warn('Bill not found for update:', updatedBill.id);
  }
};

/** 🗑️ Delete a bill by ID.
 *  Phase B: ONE Firestore delete. Worker recomputes admin_aggregates from
 *  the remaining bills on next sync (the deleted bill drops out of the
 *  sum naturally — no per-action decrement needed). */
export const deleteBill = async (billId: string): Promise<void> => {
  log('info', 'bills', `deleteBill id=${billId}`);
  const bills = await getBills();
  const filtered = bills.filter(b => b.id !== billId);
  await saveBills(filtered);
  await deleteDoc('bills', billId);
  void triggerWorkerSync('bills');
};

/** ✅ Toggle a bill's acknowledged (released) state. Mirrors the portal's
 *  toggleBillAcknowledged so mobile users can also release bills.
 *
 *  Writes the new state to Firestore (merge — preserves other portal fields)
 *  and atomically updates admin_aggregates.pendingCount.
 */
export const toggleBillAcknowledged = async (billId: string): Promise<boolean | null> => {
  const bills = await getBills();
  const idx = bills.findIndex(b => b.id === billId);
  if (idx < 0) {
    log('warn', 'bills', `toggleBillAcknowledged: bill ${billId} not found locally`);
    return null;
  }
  const wasAcked = bills[idx].acknowledged === true;
  log('info', 'bills', `toggleBillAcknowledged id=${billId} ${wasAcked ? 'release→pending' : 'pending→release'}`);
  const now = new Date();
  bills[idx] = {
    ...bills[idx],
    acknowledged: !wasAcked,
    acknowledgedAt: !wasAcked ? now : undefined,
  };
  await saveBills(bills);
  // Merge-write only the ack fields. ONE Firestore write — worker derives
  // pendingCount from the updated bill on next sync via the trigger below.
  await pushDocMerge('bills', billId, {
    acknowledged: !wasAcked,
    acknowledgedAt: !wasAcked ? now.toISOString() : null,
  });
  void triggerWorkerSync('bills');
  // Notify the React tree so any view showing the bill list re-reads from
  // local storage. Without this, returning to BillDetailView (or the search
  // list) shows the stale pre-toggle state.
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('billmaker-bills-updated', {
      detail: { billId, acknowledged: !wasAcked },
    }));
  }
  return !wasAcked;
};
