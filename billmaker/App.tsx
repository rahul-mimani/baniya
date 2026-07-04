import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Bill, Payment, Profile } from './types';
import BillViewer from './components/BillViewer';
import { Spinner } from './components/ui';
import SearchView from './components/SearchView';
import PrintView from './components/PrintView';
import HomeView from './components/HomeView';
import SettingsView from './components/SettingsView';
import PaymentsView from './components/PaymentsView';
import { HomeIcon, SearchIcon, PrintIcon, SettingsIcon, PlusIcon, AppLogoIcon, WalletIcon } from './components/Icons';
import Toast from './components/Toast';
import { initStorage, getBills, addBill, addDraftBill, updateBill } from './storage/storage';
import { initCustomerStorage } from './storage/customerStorage';
import { initProductStorage } from './storage/productStorage';
import {
  initProfileStorage,
  getProfiles,
  getActiveProfileId,
} from './storage/profileStorage';
import { initBusinessStorage, getBusinessInfo, saveBusinessInfo } from './storage/businessStorage';
import { initPaymentStorage, getPayments, savePayments } from './storage/paymentStorage';
import { saveBills } from './storage/storage';
import { saveProfiles } from './storage/profileStorage';
import { addCustomer } from './storage/customerStorage';
import { addProduct } from './storage/productStorage';
import { initFirebaseConfigStorage, getFirebaseConfig, isFirebaseConfigValid } from './storage/firebaseConfigStorage';
import { initDeletionBackupStorage, appendDeletionBackups, DeletedBackupEntry } from './storage/deletionBackupStorage';
import { initProductSyncStorage } from './storage/productSyncStorage';
import { initSync, isSyncEnabled, pushDocMerge } from './storage/sync';
import { Bill as BillType, Payment as PaymentType, Profile as ProfileType, BusinessInfo } from './types';
import { tryConsumeBack } from './utils/backHandler';
import { installGlobalErrorHandlers, log } from './utils/diagnostics';
import { motion } from 'framer-motion';
import './App.css';

type Tab = 'home' | 'search' | 'print' | 'payments' | 'settings';

/**
 * Push existing local data (bills, payments, profiles, business info) to Firestore before
 * any listener subscribes. Runs once per app launch when sync is enabled. Idempotent.
 * Without this, an empty Firestore collection would make the initial snapshot listener fire
 * with `docs: []` and the handler would wipe the local JSON file.
 */
async function bootstrapLocalToCloud() {
  if (!isSyncEnabled()) return;
  try {
    const { getBills } = await import('./storage/storage');
    const { getProfiles } = await import('./storage/profileStorage');
    const { getBusinessInfo } = await import('./storage/businessStorage');
    const { collectionHasAnyDoc } = await import('./storage/sync');

    // Bootstrap is only here to PREVENT the "empty remote → snapshot wipes
    // local" scenario. If Firestore already has docs for a collection, we
    // don't need to re-push anything. Skip per-collection based on existence.
    //
    // Payments are no longer in their own collection — they live inside
    // bills.payments[] (Deploy 5). Bootstrap doesn't touch payments anymore.

    const [bills, profiles, business] = await Promise.all([
      getBills(),
      getProfiles(),
      getBusinessInfo(),
    ]);

    const { serializeBillForSync } = await import('./storage/storage');

    // ----- Bills -----
    const billsHaveAny = await collectionHasAnyDoc('bills');
    if (!billsHaveAny && bills.length > 0) {
      log('info', 'storage', `Bootstrap: pushing ${bills.length} bills (remote empty)`);
      for (const b of bills) {
        await pushDocMerge('bills', b.id, serializeBillForSync(b));
      }
    } else {
      log('info', 'storage', `Bootstrap: skipping bills (remote has docs OR local empty)`);
    }

    // ----- Profiles -----
    const profilesHaveAny = await collectionHasAnyDoc('profiles');
    if (!profilesHaveAny && profiles.length > 0) {
      log('info', 'storage', `Bootstrap: pushing ${profiles.length} profiles (remote empty)`);
      for (const p of profiles) {
        await pushDocMerge('profiles', p.id, {
          id: p.id,
          name: p.name,
          createdAt: p.createdAt.toISOString(),
        });
      }
    } else {
      log('info', 'storage', `Bootstrap: skipping profiles (remote has docs OR local empty)`);
    }

    // ----- Business meta (single doc, always merge) -----
    if (business.name || business.phone || business.address || business.gst) {
      await pushDocMerge('_meta', 'business', {
        name: business.name,
        phone: business.phone,
        address: business.address,
        gst: business.gst,
      });
    }
    log('info', 'storage', 'Bootstrap complete');
  } catch (e) {
    log('error', 'storage', 'Bootstrap failed', e);
  }
}

/**
 * Subscribes to Firestore collections under the current shop and updates the local JSON cache
 * + triggers a React state reload whenever the remote changes. Called once after initSync
 * AND bootstrapLocalToCloud.
 */
function serializeForBackup(item: any): any {
  const out: any = {};
  for (const k in item) {
    const v = item[k];
    if (v instanceof Date) out[k] = v.toISOString();
    else if (Array.isArray(v)) out[k] = v.map(x => (typeof x === 'object' && x !== null ? { ...x } : x));
    else out[k] = v;
  }
  return out;
}

// Module-level guards. React.StrictMode in dev mode runs effects twice to
// surface bugs — without these guards, every boot side-effect (storage
// init, Firebase sign-in, bootstrap, sync listeners) runs twice in dev,
// flooding the diagnostics tab with duplicate log lines. The actual work
// is idempotent, but the noise makes debugging harder.
//
// Production builds don't double-mount, so these guards are no-ops there.
let bootEffectRan = false;
let syncListenersInstalled = false;

async function setupSyncListeners(
  reloadBills: () => Promise<void>,
  reloadPayments: () => Promise<void>,
  reloadProfiles: () => Promise<void>,
) {
  if (!isSyncEnabled()) return;
  if (syncListenersInstalled) {
    log('info', 'storage', 'setupSyncListeners called again — ignored (already installed)');
    return;
  }
  syncListenersInstalled = true;

  // Phase B: reads via Supabase Realtime (not Firestore subscriptions).
  // Writes still go to Firestore via the SDK (see storage/sync.ts).
  // Each per-collection handler receives (firestoreId, data, eventType).
  const { startRealtimeSync } = await import('./storage/realtimeSync');
  const business = await getBusinessInfo();
  const shopCode = business.shopCode?.trim();
  if (!shopCode) {
    log('warn', 'storage', 'Realtime sync skipped — no shop code in business info');
    return;
  }

  const reviveBill = (d: any): BillType => ({
    id: String(d.id),
    billNumber: String(d.billNumber ?? ''),
    customerName: String(d.customerName ?? ''),
    products: Array.isArray(d.products) ? d.products : [],
    createdAt: new Date(d.createdAt),
    updatedAt: new Date(d.updatedAt),
    createdByProfileId: d.createdByProfileId || undefined,
    createdByProfileName: d.createdByProfileName || undefined,
    acknowledged: d.acknowledged === true,
    acknowledgedAt: d.acknowledgedAt ? new Date(d.acknowledgedAt) : undefined,
  });

  const reviveProfile = (d: any): ProfileType => ({
    id: String(d.id),
    name: String(d.name ?? ''),
    createdAt: new Date(d.createdAt),
  });

  // Phase B: cross-device deletes arrive as explicit DELETE events from
  // Supabase Realtime (per-event handlers below). The snapshot-diff reconcile
  // pattern is no longer needed. backupDeleted() is still used to preserve
  // recoverable copies of deletions we received.
  const backupDeleted = async (kind: 'bills' | 'payments' | 'profiles', items: any[]) => {
    if (items.length === 0) return;
    const entries: DeletedBackupEntry[] = items.map(item => ({
      kind,
      itemId: item.id,
      deletedAt: new Date().toISOString(),
      reason: 'remote_disappeared',
      snapshot: serializeForBackup(item),
    }));
    await appendDeletionBackups(entries);
    log('warn', 'storage', `Backed up ${items.length} ${kind} removed by cross-device sync`);
  };

  const { getBills: getLocalBills } = await import('./storage/storage');
  const { getProfiles: getLocalProfiles } = await import('./storage/profileStorage');
  const { addCustomer } = await import('./storage/customerStorage');
  const { addProduct } = await import('./storage/productStorage');
  const { processDeletionTombstones } = await import('./storage/deletionTombstones');

  // -------------------------------------------------------------------------
  // Per-event handlers. Each receives one doc at a time from Supabase
  // Realtime. Local JSON files are the source of truth; we merge each
  // incoming doc into them.
  // -------------------------------------------------------------------------

  const handleBillEvent = async (
    billId: string,
    data: any,
    eventType: 'INSERT' | 'UPDATE' | 'DELETE',
  ) => {
    // Block-list gate — if admin has archived this bill ID, drop it.
    try {
      const { getBlockLists } = await import('./storage/syncState');
      const block = await getBlockLists();
      if (block.billIds.has(billId)) {
        // Make sure it's not in local either.
        const local = await getLocalBills();
        const filtered = local.filter(b => b.id !== billId);
        if (filtered.length !== local.length) {
          await saveBills(filtered);
          await reloadBills();
        }
        return;
      }
    } catch (e) {
      log('warn', 'storage', 'Block-list check failed during bill event', e);
    }

    const local = await getLocalBills();
    let next: BillType[];

    if (eventType === 'DELETE') {
      const before = local.length;
      next = local.filter(b => b.id !== billId);
      if (next.length === before) return; // not present locally — nothing to do
      // Backup the deleted bill so admin can't silently wipe.
      const bill = local.find(b => b.id === billId);
      if (bill) await backupDeleted('bills', [bill]);
      await saveBills(next);
      // Also drop any local payments that belonged to this bill.
      const localPayments = await getPayments();
      const remainingPayments = localPayments.filter(p => p.billId !== billId);
      if (remainingPayments.length !== localPayments.length) {
        await savePayments(remainingPayments);
        await reloadPayments();
      }
      await reloadBills();
      return;
    }

    if (!data) return;
    const revived = reviveBill({ ...data, id: billId });
    if (!revived.id) return;

    const idx = local.findIndex(b => b.id === billId);
    if (idx >= 0) {
      next = local.slice();
      next[idx] = revived;
    } else {
      next = [...local, revived];
    }
    await saveBills(next);

    // Extract embedded payments for THIS bill into local payments.json,
    // replacing any prior entries for this bill.
    const embeddedPayments = Array.isArray(data.payments) ? data.payments : [];
    const localPayments = await getPayments();
    const remaining = localPayments.filter(p => p.billId !== billId);
    const newPayments: PaymentType[] = embeddedPayments
      .filter((p: any) => p && typeof p === 'object' && typeof p.id === 'string')
      .map((p: any) => ({
        id: p.id,
        billId,
        amount: Number(p.amount) || 0,
        receivedAt: p.receivedAt ? new Date(p.receivedAt) : new Date(),
        method: p.method || undefined,
        note: typeof p.note === 'string' ? p.note : undefined,
        createdByProfileId: typeof p.createdByProfileId === 'string' ? p.createdByProfileId : undefined,
        createdByProfileName: typeof p.createdByProfileName === 'string' ? p.createdByProfileName : undefined,
      }));
    if (newPayments.length > 0 || remaining.length !== localPayments.length) {
      await savePayments([...remaining, ...newPayments]);
      await reloadPayments();
    }

    // Ensure local customer + product name lists pick up anything new in
    // THIS bill (autocomplete cache). Block list is checked inside.
    if (revived.customerName) {
      try { await addCustomer(revived.customerName); } catch (e) { log('warn', 'storage', 'addCustomer (handleBillEvent) failed', e); }
    }
    for (const p of revived.products) {
      if (p?.name) {
        try { await addProduct(p.name); } catch (e) { log('warn', 'storage', 'addProduct (handleBillEvent) failed', e); }
      }
    }

    await reloadBills();
  };

  const handleProfileEvent = async (
    profileId: string,
    data: any,
    eventType: 'INSERT' | 'UPDATE' | 'DELETE',
  ) => {
    const local = await getLocalProfiles();
    let next: ProfileType[];
    if (eventType === 'DELETE') {
      const before = local.length;
      next = local.filter(p => p.id !== profileId);
      if (next.length === before) return;
      const removed = local.find(p => p.id === profileId);
      if (removed) await backupDeleted('profiles', [removed]);
      await saveProfiles(next);
      await reloadProfiles();
      return;
    }
    if (!data) return;
    const revived = reviveProfile({ ...data, id: profileId });
    if (!revived.id) return;
    const idx = local.findIndex(p => p.id === profileId);
    if (idx >= 0) {
      next = local.slice();
      next[idx] = revived;
    } else {
      next = [...local, revived];
    }
    await saveProfiles(next);
    await reloadProfiles();
  };

  const handleBusinessMetaEvent = async (docId: string, data: any) => {
    // Only the `business` doc is meaningful for mobile — admin_aggregates is
    // ignored here (admin dashboard reads it, mobile doesn't).
    if (docId !== 'business' || !data) return;
    const local = await getBusinessInfo();
    const merged: BusinessInfo = {
      ...local,
      name: data.name ?? local.name,
      phone: data.phone ?? local.phone,
      address: data.address ?? local.address,
      gst: data.gst ?? local.gst,
      // shopCode stays local — never overwritten from the remote document
      shopCode: local.shopCode,
    };
    const { Filesystem, Encoding } = await import('@capacitor/filesystem');
    const { APP_DIR } = await import('./storage/paths');
    await Filesystem.writeFile({
      path: 'business.json',
      data: JSON.stringify(merged, null, 2),
      directory: APP_DIR,
      encoding: Encoding.UTF8,
    });
    log('info', 'storage', 'Sync: business info pulled from cloud');
  };

  const handleCustomerEvent = async (slug: string, data: any, eventType: 'INSERT' | 'UPDATE' | 'DELETE') => {
    // Per-event Realtime delivery — pass mode:'event' so applyRemoteCustomers
    // does NOT treat the single-doc payload as a "current snapshot" (which
    // would wrongly delete every previously-seen name from local).
    const { applyRemoteCustomers } = await import('./storage/customerStorage');
    if (eventType === 'DELETE') {
      // Mobile's local customers.json doesn't really need DELETEs since the
      // customer name can be re-typed. No-op is acceptable here.
      void slug;
      return;
    }
    if (!data || typeof data !== 'object') return;
    await applyRemoteCustomers([data], { mode: 'event' });
  };

  const handleProductEvent = async (slug: string, data: any, eventType: 'INSERT' | 'UPDATE' | 'DELETE') => {
    const { applyRemoteProducts } = await import('./storage/productStorage');
    if (eventType === 'DELETE') { void slug; return; }
    if (!data || typeof data !== 'object') return;
    await applyRemoteProducts([data], { mode: 'event' });
  };

  const handlePortalDeletionEvent = async (_docId: string, data: any) => {
    if (!data || typeof data !== 'object') return;
    const r = await processDeletionTombstones([data]);
    if (r.applied > 0) {
      await reloadBills();
      await reloadPayments();
      await reloadProfiles();
    }
    log('info', 'storage', `Tombstone applied: -${r.customersRemoved} customers, -${r.billsRemoved} bills, -${r.paymentsRemoved} payments`);
  };

  // Kick off the Realtime channel.
  await startRealtimeSync(shopCode, {
    onBill:           handleBillEvent,
    onProfile:        handleProfileEvent,
    onBusinessMeta:   handleBusinessMetaEvent,
    onCustomer:       handleCustomerEvent,
    onProduct:        handleProductEvent,
    onPortalDeletion: handlePortalDeletionEvent,
  });
}

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>('home');
  const [bills, setBills] = useState<Bill[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfileId, setActiveProfileIdState] = useState<string>('');
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [isCreatingBill, setIsCreatingBill] = useState(false);
  // Brief overlay spinner shown during tab transitions for visual feedback
  // when the user taps a new tab. Auto-dismisses after a short delay.
  const [isTabSwitching, setIsTabSwitching] = useState(false);
  const toastTimerRef = useRef<number | null>(null);

  const reloadBills = useCallback(async () => {
    const data = await getBills();
    setBills(data);
  }, []);

  const reloadPayments = useCallback(async () => {
    const data = await getPayments();
    setPayments(data);
  }, []);

  const reloadProfiles = useCallback(async () => {
    const [p, a] = await Promise.all([getProfiles(), getActiveProfileId()]);
    setProfiles(p);
    setActiveProfileIdState(a);
  }, []);

  useEffect(() => {
    // Module-level boot guard. React.StrictMode runs effects twice in dev
    // to surface bugs — without this guard, every line below logs twice
    // (initStorage, Firebase anonymous sign-in, bootstrap, etc.). The
    // operations themselves are idempotent (initStorage just ensures the
    // JSON files exist, initSync is a no-op when called with the same
    // config), but the duplicate log lines make the diagnostics tab harder
    // to read. Production builds don't double-mount so this guard is a
    // no-op there.
    if (bootEffectRan) {
      log('info', 'general', 'App boot — second invocation suppressed (StrictMode dev double-mount)');
      return;
    }
    bootEffectRan = true;

    installGlobalErrorHandlers();
    log('info', 'general', 'App boot');
    (async () => {
      try {
        await Promise.all([
          initStorage(),
          initCustomerStorage(),
          initProductStorage(),
          initProfileStorage(),
          initBusinessStorage(),
          initPaymentStorage(),
          initFirebaseConfigStorage(),
          initDeletionBackupStorage(),
          initProductSyncStorage(),
        ]);
        await Promise.all([reloadBills(), reloadProfiles(), reloadPayments()]);
        log('info', 'storage', 'Storage init complete');

        // Sync setup — needs BOTH a valid Firebase config AND a Shop Code (both in Settings)
        const [business, firebaseCfg] = await Promise.all([getBusinessInfo(), getFirebaseConfig()]);
        if (business.shopCode && business.shopCode.trim() && isFirebaseConfigValid(firebaseCfg)) {
          const ok = await initSync(firebaseCfg, business.shopCode.trim());
          if (ok) {
            // CRITICAL: push local data UP to Firestore BEFORE subscribing.
            // Otherwise an empty remote collection makes the listener wipe local data on first fire.
            await bootstrapLocalToCloud();
            await setupSyncListeners(reloadBills, reloadPayments, reloadProfiles);
          }
        }

        // Auto-sync products from the user's URL (typically a GitHub Pages
        // JSON). Runs in the background — failure is logged but never
        // blocks startup. Use case: admin updates products.json on GitHub,
        // every staff phone picks it up on the next app open.
        void (async () => {
          try {
            const { getProductSyncConfig } = await import('./storage/productSyncStorage');
            const psCfg = await getProductSyncConfig();
            if (!psCfg.url) return;
            const { syncProductsFromUrl } = await import('./utils/productSyncFromUrl');
            const r = await syncProductsFromUrl(psCfg.url);
            log('info', 'products', `Boot sync: fetched=${r.fetched} added=${r.added} total=${r.total} (${r.durationMs}ms)`);
          } catch (e: any) {
            log('warn', 'products', `Boot sync skipped: ${String(e?.message || e).slice(0, 160)}`);
          }
        })();
      } catch (e) {
        log('error', 'storage', 'Storage init failed', e);
      }
    })();
  }, [reloadBills, reloadProfiles, reloadPayments]);

  // Listen for local bill mutations (e.g. toggleBillAcknowledged) so the
  // UI reloads bills from storage immediately. Without this, returning to
  // a list view after a release shows the stale state.
  useEffect(() => {
    const onBillsUpdated = () => { void reloadBills(); };
    window.addEventListener('billmaker-bills-updated', onBillsUpdated);
    return () => window.removeEventListener('billmaker-bills-updated', onBillsUpdated);
  }, [reloadBills]);

  // Hardware back button (Android) — defers to per-view handlers, then falls back to tab nav
  useEffect(() => {
    let listenerHandle: any;
    let CapApp: any;
    (async () => {
      try {
        const mod = await import('@capacitor/app');
        CapApp = mod.App;
        listenerHandle = await CapApp.addListener('backButton', () => {
          if (tryConsumeBack()) return;
          if (isCreatingBill) { setIsCreatingBill(false); return; }
          if (activeTab !== 'home') { setActiveTab('home'); return; }
          CapApp.exitApp();
        });
      } catch {
        // Running in browser — no-op
      }
    })();
    return () => {
      listenerHandle?.remove?.();
    };
  }, [activeTab, isCreatingBill]);

  // Wrap setActiveTab to flash a spinner during transitions.
  const switchTab = useCallback((tab: Tab) => {
    setIsTabSwitching(true);
    setActiveTab(tab);
    window.setTimeout(() => setIsTabSwitching(false), 220);
  }, []);

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast({ message, type });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3000);
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
  }, []);

  const activeProfile = profiles.find(p => p.id === activeProfileId) || null;

  // Compute the next LE-XXXXXXX from MAX existing number, not bills.length.
  // Length-based numbering breaks if: app data cleared, catchup hasn't
  // finished, admin deleted bills via portal_deletions, or sync is partial —
  // all of those reduce the local count and would re-issue an already-used
  // number. Drafts (billNumber = '') are naturally skipped by the regex.
  const computeNextBillNumber = useCallback((): string => {
    let maxNum = 0;
    for (const b of bills) {
      const m = b.billNumber?.match(/LE-(\d+)/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > maxNum) maxNum = n;
      }
    }
    return `LE-${String(maxNum + 1).padStart(7, '0')}`;
  }, [bills]);

  const handleSaveBill = useCallback(
    async (billToSave: Partial<Bill>): Promise<Bill> => {
      if (!billToSave.customerName || !billToSave.products) {
        showToast('Customer name and products are required.', 'error');
        throw new Error('Invalid bill data');
      }
      try {
        if (billToSave.id) {
          const updatedBill: Bill = { ...billToSave, updatedAt: new Date() } as Bill;
          await updateBill(updatedBill);
          await reloadBills();
          showToast('Changes updated');
          return updatedBill;
        }
        const newBill: Bill = {
          ...billToSave,
          id: Date.now().toString(),
          billNumber: computeNextBillNumber(),
          customerName: billToSave.customerName!,
          products: billToSave.products!,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as Bill;
        await addBill(newBill);
        await reloadBills();
        showToast('Bill saved');
        return newBill;
      } catch (err) {
        showToast('Error saving bill', 'error');
        throw err;
      }
    },
    [computeNextBillNumber, reloadBills, showToast],
  );

  /** Save a draft — no bill number, never pushed to Firestore. Used by the
   *  Save Draft button in BillViewer create mode so the user doesn't lose
   *  their progress when sync is unavailable. */
  const handleSaveDraft = useCallback(
    async (billToSave: Partial<Bill>): Promise<Bill> => {
      if (!billToSave.customerName?.trim()) {
        showToast('Add a customer name first.', 'error');
        throw new Error('Customer name required');
      }
      try {
        // Editing an existing draft? Update it in place — still local-only.
        if (billToSave.id) {
          const updatedDraft: Bill = {
            ...billToSave,
            updatedAt: new Date(),
            isDraft: true,
            billNumber: '',
          } as Bill;
          await updateBill(updatedDraft);
          await reloadBills();
          showToast('Draft saved');
          return updatedDraft;
        }
        const newDraft: Bill = {
          ...billToSave,
          id: Date.now().toString(),
          billNumber: '',
          customerName: billToSave.customerName!,
          products: billToSave.products!,
          createdAt: new Date(),
          updatedAt: new Date(),
          isDraft: true,
        } as Bill;
        await addDraftBill(newDraft);
        await reloadBills();
        showToast('Draft saved');
        return newDraft;
      } catch (err) {
        showToast('Couldn’t save draft', 'error');
        throw err;
      }
    },
    [reloadBills, showToast],
  );

  /** Finalise a draft: assign a fresh bill number from max+1, clear the
   *  draft flag, persist locally + push to Firestore. The unhappy path
   *  (Firestore unreachable) is handled by updateBill — the local file
   *  is updated first so the bill number is reserved even if the push
   *  fails. The user can re-tap Sync to retry the push. */
  const handleSyncDraft = useCallback(
    async (draftId: string): Promise<Bill> => {
      const draft = bills.find(b => b.id === draftId && b.isDraft === true);
      if (!draft) {
        showToast('Draft not found', 'error');
        throw new Error('Draft not found');
      }
      try {
        const finalised: Bill = {
          ...draft,
          billNumber: draft.billNumber || computeNextBillNumber(),
          isDraft: false,
          updatedAt: new Date(),
        };
        // updateBill writes locally first, then attempts the Firestore push.
        await updateBill(finalised);
        await reloadBills();
        showToast(`Synced as ${finalised.billNumber}`);
        return finalised;
      } catch (err) {
        showToast('Sync failed — kept as draft', 'error');
        throw err;
      }
    },
    [bills, computeNextBillNumber, reloadBills, showToast],
  );

  return (
    <div className="min-h-screen font-sans">
      {/* Dark-navy top header — matches the bottom nav so the app chrome
          reads as one piece. White text/icons make actions visible. */}
      <header className="bg-sky-900 shadow-md sticky top-0 z-10 no-print app-header">
        <div className="container mx-auto px-4 py-2.5 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <AppLogoIcon size={32} />
            <div className="leading-tight">
              <h1 className="text-base font-bold text-white">BillMaker</h1>
              <p className="text-[10px] uppercase tracking-wider text-sky-200 font-semibold">Billing &amp; Invoicing</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* White bg + black icon. Settings gear is a neutral nav action. */}
            <button
              onClick={() => setActiveTab('settings')}
              aria-label="Open Settings"
              className={`p-2 rounded-full bg-white text-slate-900 active:bg-slate-100 transition ${activeTab === 'settings' ? 'ring-2 ring-sky-300' : ''}`}
            >
              <SettingsIcon />
            </button>
            {activeProfile && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-sky-200 hidden sm:inline">{activeProfile.name}</span>
                <div className="w-9 h-9 rounded-full bg-sky-600 text-white flex items-center justify-center text-sm font-bold ring-2 ring-sky-700">
                  {activeProfile.name.slice(0, 1).toUpperCase()}
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Viewport-bound tab-switch spinner. Fixed-positioned so it always
          shows in the visible area between the top header and bottom nav,
          regardless of how tall the underlying tab's content is. Previously
          it used absolute-inset-of-<main>, which stretched across the full
          (often very long) scroll height and looked inconsistent per tab. */}
      {isTabSwitching && (
        <div
          className="fixed left-0 right-0 z-30 flex items-center justify-center bg-amber-50/70 backdrop-blur-[2px] pointer-events-none"
          style={{
            top: 'calc(env(safe-area-inset-top, 0px) + 56px)',
            bottom: 'calc(env(safe-area-inset-bottom, 0px) + 56px)',
          }}
          aria-hidden="true"
        >
          <div className="bg-white rounded-2xl px-5 py-4 shadow-lg flex flex-col items-center gap-2">
            <Spinner size="lg" />
            <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-wide">
              Loading…
            </span>
          </div>
        </div>
      )}

      <main className="container mx-auto px-4 app-main">
        {activeTab === 'home' && (
          <HomeView
            bills={bills}
            activeProfile={activeProfile}
            onSaveBill={handleSaveBill}
            onSaveDraft={handleSaveDraft}
            onSyncDraft={handleSyncDraft}
          />
        )}
        {activeTab === 'search' && (
          <SearchView
            bills={bills}
            payments={payments}
            activeProfile={activeProfile}
            onSaveBill={handleSaveBill}
            onSaveDraft={handleSaveDraft}
            onSyncDraft={handleSyncDraft}
          />
        )}
        {activeTab === 'print' && <PrintView bills={bills} showToast={showToast} />}
        {activeTab === 'payments' && (
          <PaymentsView
            bills={bills}
            payments={payments}
            activeProfile={activeProfile}
            onPaymentsChanged={reloadPayments}
            showToast={showToast}
          />
        )}
        {activeTab === 'settings' && (
          <SettingsView onChanged={reloadProfiles} showToast={showToast} />
        )}
      </main>

      <nav className="bottom-nav no-print">
        <TabButton label="Home" icon={<HomeIcon />} isActive={activeTab === 'home'} onClick={() => switchTab('home')} />
        <TabButton label="Search" icon={<SearchIcon />} isActive={activeTab === 'search'} onClick={() => switchTab('search')} />
        <div className="fab-slot">
          <button
            onClick={() => setIsCreatingBill(true)}
            aria-label="Create new bill"
            className="fab"
          >
            <PlusIcon />
          </button>
        </div>
        <TabButton label="Payments" icon={<WalletIcon />} isActive={activeTab === 'payments'} onClick={() => switchTab('payments')} />
        <TabButton label="Print" icon={<PrintIcon />} isActive={activeTab === 'print'} onClick={() => switchTab('print')} />
      </nav>

      {/* New-bill flow uses BillViewer in 'create' mode for consistency.
          User fills → taps Preview → confirms → bill saves. */}
      <BillViewer
        isOpen={isCreatingBill}
        initialMode="create"
        activeProfile={activeProfile}
        onClose={() => setIsCreatingBill(false)}
        onSave={handleSaveBill}
        onSaveDraft={handleSaveDraft}
        onSyncDraft={handleSyncDraft}
        allBills={bills}
      />

      {toast && <Toast message={toast.message} type={toast.type} onDismiss={() => setToast(null)} />}
    </div>
  );
};

interface TabButtonProps {
  label: string;
  icon: React.ReactNode;
  isActive: boolean;
  onClick: () => void;
}

const TabButton: React.FC<TabButtonProps> = ({ label, icon, isActive, onClick }) => (
  <button onClick={onClick} className={`tab-button ${isActive ? 'active' : ''}`}>
    <div className="tab-content">
      {icon}
      <span>{label}</span>
    </div>
    {isActive && (
      <motion.div
        layoutId="tab-underline"
        className="tab-underline"
        transition={{ type: 'spring', stiffness: 400, damping: 25 }}
      />
    )}
  </button>
);

export default App;
