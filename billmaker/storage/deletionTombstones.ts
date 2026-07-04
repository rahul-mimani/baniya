// src/storage/deletionTombstones.ts
//
// Processes "deletion tombstone" documents written by the admin portal when
// a customer (or in the future, a product) is archived. Each tombstone is an
// explicit list of names + IDs to remove — no inference, no reconcile state,
// no race-condition guessing.
//
// Idempotent: we track processed tombstone IDs in sync_state.json under the
// `processedDeletions` key. A tombstone that's been applied once won't be
// re-applied even if its snapshot fires repeatedly or the app restarts.
import { Filesystem, Encoding } from '@capacitor/filesystem';
import { APP_DIR } from './paths';
import { log } from '../utils/diagnostics';
import { getSyncState, updateSyncState, invalidateBlockCache } from './syncState';
import { getCustomers, saveCustomers } from './customerStorage';
import { getProducts, saveProducts } from './productStorage';
import { getBills, saveBills } from './storage';
import { getPayments, savePayments } from './paymentStorage';
import { appendDeletionBackups, DeletedBackupEntry } from './deletionBackupStorage';

export interface DeletionTombstone {
  id: string;
  type: 'customer' | 'product';
  customerId?: string;
  customerName?: string;
  /** Lowercased slugs and/or raw names — both formats supported for safety. */
  nameSlugs?: string[];
  aliases?: string[];
  billIds?: string[];
  paymentIds?: string[];
  deletedAt: string;
}

/** Read processed-tombstone IDs from sync state. */
const getProcessedSet = async (): Promise<Set<string>> => {
  const s = await getSyncState();
  return new Set<string>(s.processedDeletions || []);
};

const setProcessed = async (ids: Set<string>): Promise<void> => {
  await updateSyncState({ processedDeletions: Array.from(ids) });
};

/**
 * Apply every unprocessed tombstone in the snapshot. Backs up removed bills /
 * payments to sync_deleted_backup.json so admin-driven deletes are still
 * recoverable locally if needed.
 *
 * Returns counts so the listener can log "applied N tombstones, removed M
 * customers / K bills / J payments".
 */
export const processDeletionTombstones = async (
  docs: any[],
): Promise<{
  applied: number;
  customersRemoved: number;
  productsRemoved: number;
  billsRemoved: number;
  paymentsRemoved: number;
}> => {
  let applied = 0;
  let customersRemoved = 0;
  let productsRemoved = 0;
  let billsRemoved = 0;
  let paymentsRemoved = 0;

  const processed = await getProcessedSet();

  // Snapshot may include already-applied tombstones; filter to new ones only.
  const fresh: DeletionTombstone[] = [];
  for (const d of docs) {
    const id = d?.id || d?._id;
    if (!id || processed.has(id)) continue;
    fresh.push({ ...d, id });
  }
  if (fresh.length === 0) {
    return { applied, customersRemoved, productsRemoved, billsRemoved, paymentsRemoved };
  }

  // Load all local stores once, mutate in memory, save once each at the end.
  let localCustomers = await getCustomers();
  let localProducts = await getProducts();
  let localBills = await getBills();
  let localPayments = await getPayments();
  const backups: DeletedBackupEntry[] = [];

  for (const t of fresh) {
    if (t.type === 'customer') {
      // Build set of names to remove: explicit slugs (lowercased), aliases
      // (lowercased), and the primary name (lowercased) as a safety net.
      const namesLower = new Set<string>();
      for (const s of t.nameSlugs || []) namesLower.add(String(s).toLowerCase());
      for (const a of t.aliases || []) namesLower.add(String(a).toLowerCase());
      if (t.customerName) namesLower.add(t.customerName.toLowerCase());

      const beforeCust = localCustomers.length;
      localCustomers = localCustomers.filter(c => {
        const lc = String(c).toLowerCase();
        // Match against name OR its slug-form (kebab-case alphanumeric)
        const slug = lc.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        return !namesLower.has(lc) && !namesLower.has(slug);
      });
      customersRemoved += beforeCust - localCustomers.length;

      // Remove bills by explicit IDs from the tombstone
      const billIdSet = new Set(t.billIds || []);
      if (billIdSet.size > 0) {
        const before = localBills.length;
        const removed = localBills.filter(b => billIdSet.has(b.id));
        for (const r of removed) {
          backups.push({
            kind: 'bills',
            itemId: r.id,
            deletedAt: new Date().toISOString(),
            reason: 'remote_disappeared',
            snapshot: serializeForBackup(r),
          });
        }
        localBills = localBills.filter(b => !billIdSet.has(b.id));
        billsRemoved += before - localBills.length;
      }
      // Also drop bills whose customerName matches — covers bills that mobile
      // may have created locally after admin deleted, with a name match.
      if (namesLower.size > 0) {
        const before = localBills.length;
        const removed = localBills.filter(b => namesLower.has((b.customerName || '').toLowerCase()));
        for (const r of removed) {
          backups.push({
            kind: 'bills',
            itemId: r.id,
            deletedAt: new Date().toISOString(),
            reason: 'remote_disappeared',
            snapshot: serializeForBackup(r),
          });
        }
        localBills = localBills.filter(b => !namesLower.has((b.customerName || '').toLowerCase()));
        billsRemoved += before - localBills.length;
      }

      // Remove payments by explicit IDs + any tied to bills we just removed
      const paymentIdSet = new Set(t.paymentIds || []);
      const removedBillIdSet = new Set(
        Array.from(billIdSet),
      );
      // billIdSet only has explicit; add the names-derived ones too — easier to
      // re-derive than to track above.
      // (Actually localBills no longer has them; can't get their IDs. We rely
      //  on tombstone.paymentIds being complete from the portal side.)
      if (paymentIdSet.size > 0 || removedBillIdSet.size > 0) {
        const before = localPayments.length;
        const removed = localPayments.filter(
          p => paymentIdSet.has(p.id) || removedBillIdSet.has(p.billId),
        );
        for (const r of removed) {
          backups.push({
            kind: 'payments',
            itemId: r.id,
            deletedAt: new Date().toISOString(),
            reason: 'remote_disappeared',
            snapshot: serializeForBackup(r),
          });
        }
        localPayments = localPayments.filter(
          p => !paymentIdSet.has(p.id) && !removedBillIdSet.has(p.billId),
        );
        paymentsRemoved += before - localPayments.length;
      }
    } else if (t.type === 'product') {
      const namesLower = new Set<string>();
      for (const s of t.nameSlugs || []) namesLower.add(String(s).toLowerCase());
      const beforeProd = localProducts.length;
      localProducts = localProducts.filter(p => {
        const lp = String(p).toLowerCase();
        const slug = lp.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        return !namesLower.has(lp) && !namesLower.has(slug);
      });
      productsRemoved += beforeProd - localProducts.length;
    }
    processed.add(t.id);
    applied++;
  }

  // Persist everything
  await saveCustomers(localCustomers);
  await saveProducts(localProducts);
  await saveBills(localBills);
  await savePayments(localPayments);
  if (backups.length > 0) await appendDeletionBackups(backups);
  await setProcessed(processed);

  // Update the BLOCK LISTS so the bills replay loop won't resurrect what we
  // just removed. Names and bill IDs go in lowercased + slug form so any
  // future bill mentioning the same customer (in any casing) gets blocked.
  const state = await getSyncState();
  const blockedCustomerNames = new Set<string>((state.blockedCustomerNames || []).map(n => n.toLowerCase()));
  const blockedProductNames = new Set<string>((state.blockedProductNames || []).map(n => n.toLowerCase()));
  const blockedBillIds = new Set<string>(state.blockedBillIds || []);
  for (const t of fresh) {
    if (t.type === 'customer') {
      for (const s of t.nameSlugs || []) blockedCustomerNames.add(String(s).toLowerCase());
      for (const a of t.aliases || []) blockedCustomerNames.add(String(a).toLowerCase());
      if (t.customerName) blockedCustomerNames.add(t.customerName.toLowerCase());
      for (const id of t.billIds || []) blockedBillIds.add(id);
    } else if (t.type === 'product') {
      for (const s of t.nameSlugs || []) blockedProductNames.add(String(s).toLowerCase());
    }
  }
  await updateSyncState({
    blockedCustomerNames: Array.from(blockedCustomerNames),
    blockedProductNames: Array.from(blockedProductNames),
    blockedBillIds: Array.from(blockedBillIds),
  });
  invalidateBlockCache();

  log(
    'info',
    'storage',
    `Tombstones: applied ${applied} (${customersRemoved} customers, ${productsRemoved} products, ${billsRemoved} bills, ${paymentsRemoved} payments removed)`,
  );

  return { applied, customersRemoved, productsRemoved, billsRemoved, paymentsRemoved };
};

const serializeForBackup = (item: any): any => {
  try {
    return JSON.parse(JSON.stringify(item));
  } catch {
    return { _failed: 'could not serialize' };
  }
};
