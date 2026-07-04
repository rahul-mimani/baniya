import React, { useEffect, useRef, useState } from 'react';
import { BusinessInfo, Profile } from '../types';
import {
  BuildingIcon,
  UserIcon,
  PlusIcon,
  TrashIcon,
  DownloadIcon,
  UploadIcon,
  CheckIcon,
  PrintIcon,
  ExternalLinkIcon,
} from './Icons';
import { getBusinessInfo } from '../storage/businessStorage';
import {
  getProfiles,
  addProfile as addProfileStorage,
  deleteProfile as deleteProfileStorage,
  getActiveProfileId,
  setActiveProfileId,
} from '../storage/profileStorage';
import { exportAllData, openBackupFile, importAllData, ImportResult } from '../utils/backupData';
import { exportSettings, openSettingsFile, importSettings, ImportSettingsResult } from '../utils/settingsJson';
import { syncProductsFromUrl } from '../utils/productSyncFromUrl';
import { exportProductsAsJson, openExportedProducts } from '../utils/exportProductsJson';
import { publishProductsToUrl } from '../utils/publishProductsToUrl';
import { getProductSyncConfig, saveProductSyncConfig, ProductSyncConfig } from '../storage/productSyncStorage';
import { migrateAllData, MigrationReport } from '../utils/migrateData';
import { useUsbPrinter } from '../hooks/useUsbPrinter';
import UsbPrinterStatus from './UsbPrinterStatus';
import PrinterDiagnostics from './PrinterDiagnostics';
import { log } from '../utils/diagnostics';
import { getSyncStatus, onSyncStatusChange, SyncStatus, repairAndSyncAll, RepairProgress, RepairResult } from '../storage/sync';
import {
  getFirebaseConfig,
  isFirebaseConfigValid,
  FirebaseConfig,
} from '../storage/firebaseConfigStorage';
import {
  getDeletionBackups,
  clearDeletionBackups,
  DeletedBackupEntry,
} from '../storage/deletionBackupStorage';
import BulkMarkPaidModal from './BulkMarkPaidModal';
import { CashIcon } from './Icons';

interface SettingsViewProps {
  onChanged: () => void;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

const SettingsView: React.FC<SettingsViewProps> = ({ onChanged, showToast }) => {
  // Business + Firebase state are read-only after Phase 4: they're never
  // mutated via form fields anymore. Kept as state so the JSON-import flow
  // can refresh the read-only status card without remounting the section.
  const [business, setBusiness] = useState<BusinessInfo>({ name: '', phone: '', address: '', gst: '' });
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [newProfileName, setNewProfileName] = useState('');
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [migrationReport, setMigrationReport] = useState<MigrationReport | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(getSyncStatus());
  const [firebaseCfg, setFirebaseCfg] = useState<FirebaseConfig>({ apiKey: '', projectId: '', appId: '' });
  const [bulkPaidEnabled, setBulkPaidEnabled] = useState(false);
  const [showBulkPaidModal, setShowBulkPaidModal] = useState(false);
  const [deletionBackups, setDeletionBackups] = useState<DeletedBackupEntry[]>([]);
  const [repairing, setRepairing] = useState(false);
  const [repairProgress, setRepairProgress] = useState<RepairProgress | null>(null);
  const [repairResult, setRepairResult] = useState<RepairResult | null>(null);
  const [importingSettings, setImportingSettings] = useState(false);
  const [exportingSettings, setExportingSettings] = useState(false);
  // Product sync from a user-provided URL. URL is provisioned via the
  // settings JSON (productSync.url); this view only shows status + runs
  // the sync. No manual URL form by Phase 4 rule.
  const [productSyncCfg, setProductSyncCfg] = useState<ProductSyncConfig>({ url: '' });
  const [productSyncUrlDraft, setProductSyncUrlDraft] = useState('');
  const [savingProductSyncUrl, setSavingProductSyncUrl] = useState(false);
  const [syncingProducts, setSyncingProducts] = useState(false);
  const [exportingProducts, setExportingProducts] = useState(false);
  // Publish-to-URL (one-tap POST to an npoint.io bin) — uses the same
  // URL field the user already saved for syncing.
  const [publishing, setPublishing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const settingsFileInputRef = useRef<HTMLInputElement>(null);

  const handleRepairSync = async () => {
    if (!syncStatus.enabled) {
      showToast('Sync is not active — enable Firebase + Shop Code first.', 'error');
      return;
    }
    if (!window.confirm('Push all local customers, products, bills, payments, and profiles to Firestore? Safe to run multiple times.')) return;
    setRepairing(true);
    setRepairResult(null);
    setRepairProgress({ phase: 'idle', done: 0, total: 0 });
    try {
      const r = await repairAndSyncAll(p => setRepairProgress(p));
      setRepairResult(r);
      if (r.errors.length === 0) {
        showToast(`Repair & Sync done: ${r.customers + r.products + r.bills + r.payments + r.profiles} items pushed`, 'success');
      } else {
        showToast(`Repair & Sync finished with ${r.errors.length} error(s)`, 'error');
      }
    } catch (e: any) {
      showToast(e?.message || 'Repair & Sync failed', 'error');
    } finally {
      setRepairing(false);
    }
  };

  useEffect(() => onSyncStatusChange(setSyncStatus), []);

  useEffect(() => {
    (async () => {
      const cfg = await getFirebaseConfig();
      setFirebaseCfg(cfg);
      const backups = await getDeletionBackups();
      setDeletionBackups(backups);
      const ps = await getProductSyncConfig();
      setProductSyncCfg(ps);
      setProductSyncUrlDraft(ps.url || '');
    })();
  }, []);

  const handlePublishToUrl = async () => {
    setPublishing(true);
    try {
      const r = await publishProductsToUrl();
      setProductSyncCfg(await getProductSyncConfig());
      showToast(`Published ${r.count} product(s) to the bin (${r.durationMs} ms)`, 'success');
    } catch (e: any) {
      showToast(e?.message || 'Publish failed', 'error');
    } finally {
      setPublishing(false);
    }
  };

  const handleSaveProductSyncUrl = async () => {
    const trimmed = productSyncUrlDraft.trim();
    setSavingProductSyncUrl(true);
    try {
      await saveProductSyncConfig({ ...productSyncCfg, url: trimmed });
      const next = await getProductSyncConfig();
      setProductSyncCfg(next);
      showToast(trimmed ? 'Product sync URL saved' : 'Product sync URL cleared');
    } catch (e: any) {
      showToast(e?.message || 'Could not save URL', 'error');
    } finally {
      setSavingProductSyncUrl(false);
    }
  };

  // Dump the local catalogue (= Firestore-synced view) into a Downloads/
  // file as ["name", "name", ...] — admin pastes it into the GitHub
  // products.json so non-Firestore phones can sync from the URL.
  const handleExportProductsForGithub = async () => {
    setExportingProducts(true);
    try {
      const r = await exportProductsAsJson();
      const where = r.location === 'downloads' ? 'Downloads' : 'app storage';
      showToast(`Exported ${r.count} product(s) to ${where} · ${r.fileName}`, 'success');
      // Pop the system viewer/share sheet so the user can copy the JSON
      // straight into GitHub without hunting for the file.
      try { await openExportedProducts(r.uri); } catch { /* viewer unavailable */ }
    } catch (e: any) {
      showToast(e?.message || 'Export failed', 'error');
    } finally {
      setExportingProducts(false);
    }
  };

  const handleSyncProductsNow = async () => {
    if (!productSyncCfg.url) {
      showToast('Set productSync.url in the settings JSON first.', 'error');
      return;
    }
    setSyncingProducts(true);
    try {
      const r = await syncProductsFromUrl(productSyncCfg.url);
      // Refresh the cached config so the "Last synced" line updates
      // without having to navigate away.
      setProductSyncCfg(await getProductSyncConfig());
      showToast(
        r.fetched === 0
          ? 'Sync completed (no names in response).'
          : `Synced ${r.fetched} name(s) · ${r.added} new`,
        'success',
      );
    } catch (e: any) {
      showToast(e?.message || 'Product sync failed', 'error');
    } finally {
      setSyncingProducts(false);
    }
  };

  // Settings JSON is now the ONLY way to provision business + Firebase
  // values on a device. Manual entry was removed by user request — they
  // ship a JSON to staff phones and import it.
  const handleExportSettings = async () => {
    setExportingSettings(true);
    try {
      const { fileName, uri } = await exportSettings();
      showToast(`Exported ${fileName}`);
      try { await openSettingsFile(uri); } catch { /* viewer not available */ }
    } catch (e: any) {
      showToast(e?.message || 'Export failed', 'error');
    } finally {
      setExportingSettings(false);
    }
  };

  const triggerSettingsImport = () => {
    settingsFileInputRef.current?.click();
  };

  const handleSettingsFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImportingSettings(true);
    try {
      const text = await file.text();
      const result: ImportSettingsResult = await importSettings(text);
      // Reload the in-memory copies so the status card reflects the new
      // values immediately. Sync activation still needs an app restart
      // (Firebase init happens at boot).
      const [b, fb, ps] = await Promise.all([
        getBusinessInfo(),
        getFirebaseConfig(),
        getProductSyncConfig(),
      ]);
      setBusiness(b);
      setFirebaseCfg(fb);
      setProductSyncCfg(ps);
      const parts: string[] = [];
      if (result.businessApplied) parts.push('business');
      if (result.firebaseApplied) parts.push('Firebase config');
      if (result.productSyncApplied) parts.push('product sync URL');
      showToast(`Imported ${parts.join(' + ')}. Restart app to activate sync.`);
    } catch (err: any) {
      showToast(err?.message || 'Import failed', 'error');
    } finally {
      setImportingSettings(false);
    }
  };

  const handleClearDeletionBackups = async () => {
    if (!window.confirm(`Permanently clear ${deletionBackups.length} deletion backup(s)? They cannot be restored after this.`)) return;
    await clearDeletionBackups();
    setDeletionBackups([]);
    showToast('Deletion backups cleared');
  };

  useEffect(() => {
    (async () => {
      const [b, p, a] = await Promise.all([getBusinessInfo(), getProfiles(), getActiveProfileId()]);
      setBusiness(b);
      setProfiles(p);
      setActiveId(a);
    })();
  }, []);

  const handleAddProfile = async () => {
    const trimmed = newProfileName.trim();
    if (!trimmed) return;
    const profile = await addProfileStorage(trimmed);
    setProfiles(prev => [...prev, profile]);
    if (!activeId) {
      await setActiveProfileId(profile.id);
      setActiveId(profile.id);
    }
    setNewProfileName('');
    onChanged();
    showToast(`Added ${trimmed}`);
  };

  const handleActivate = async (id: string) => {
    await setActiveProfileId(id);
    setActiveId(id);
    onChanged();
  };

  const handleDeleteProfile = async (id: string, name: string) => {
    if (!window.confirm(`Delete profile "${name}"? Existing bills will keep their record.`)) return;
    await deleteProfileStorage(id);
    setProfiles(prev => prev.filter(p => p.id !== id));
    if (activeId === id) setActiveId('');
    onChanged();
  };

  const handleMigrate = async () => {
    setMigrating(true);
    setMigrationReport(null);
    try {
      const report = await migrateAllData();
      setMigrationReport(report);
      onChanged();
      const totalFixed = report.bills.fixed + report.customers.fixed + report.products.fixed;
      if (totalFixed === 0 && report.errors.length === 0) {
        showToast('Data is already in the new format');
      } else {
        showToast(`Repaired ${totalFixed} entr${totalFixed === 1 ? 'y' : 'ies'}`);
      }
    } catch (e: any) {
      showToast(e?.message || 'Migration failed', 'error');
    } finally {
      setMigrating(false);
    }
  };

  const handleExport = async () => {
    try {
      const { fileName, uri } = await exportAllData();
      showToast(`Exported ${fileName}`);
      try {
        await openBackupFile(uri);
      } catch {
        // Some Android setups can't open .json — silently ignore
      }
    } catch (e) {
      console.error(e);
      showToast('Export failed', 'error');
    }
  };

  const triggerImport = () => {
    if (importMode === 'replace' && !confirmReplace) {
      showToast('Confirm "Replace all" first', 'error');
      return;
    }
    fileInputRef.current?.click();
  };

  const handleFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const result: ImportResult = await importAllData(text, importMode);
      showToast(
        `Imported ${result.newBills} bills, ${result.newCustomers} customers, ${result.newProducts} products`,
      );
      setConfirmReplace(false);
      onChanged();
      // refresh local profile list
      const [p, a] = await Promise.all([getProfiles(), getActiveProfileId()]);
      setProfiles(p);
      setActiveId(a);
      const b = await getBusinessInfo();
      setBusiness(b);
    } catch (err: any) {
      showToast(err?.message || 'Import failed', 'error');
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <Section
        icon={<BuildingIcon />}
        title="Settings (JSON)"
        description="Business info, shop code, and Firebase config are managed exclusively via a JSON file. Import to provision a device; export to share."
      >
        <div className="space-y-3 text-sm text-slate-700">
          {/* Current state — read-only summary. Manual entry is intentionally
              not supported here; admins ship a JSON file to staff phones. */}
          <div className="bg-slate-50 border border-slate-200 rounded-md p-3 space-y-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-slate-500 uppercase tracking-wide">Business</span>
              <span className="text-slate-800 truncate text-right">
                {business.name || <span className="text-slate-400 italic">not set</span>}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-slate-500 uppercase tracking-wide">Phone</span>
              <span className="text-slate-800 truncate text-right">
                {business.phone || <span className="text-slate-400 italic">not set</span>}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-slate-500 uppercase tracking-wide">Shop code</span>
              <span className="font-mono text-slate-800 truncate text-right">
                {business.shopCode || <span className="text-slate-400 italic font-sans">not set</span>}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-slate-500 uppercase tracking-wide">Firebase</span>
              <span className="font-mono text-slate-800 truncate text-right">
                {isFirebaseConfigValid(firebaseCfg)
                  ? firebaseCfg.projectId
                  : <span className="text-slate-400 italic font-sans">not configured</span>}
              </span>
            </div>

            <div className={`mt-2 flex items-center gap-2 rounded px-2 py-1.5 border ${
              syncStatus.enabled ? 'bg-sky-50 border-sky-200 text-sky-800' : 'bg-slate-100 border-slate-200 text-slate-600'
            }`}>
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${syncStatus.enabled ? 'bg-sky-500 animate-pulse' : 'bg-slate-400'}`} />
              <span className="flex-1">
                {syncStatus.enabled ? (
                  <>Cloud sync <strong>active</strong> for shop <span className="font-mono">{syncStatus.shopCode}</span></>
                ) : syncStatus.shopCode ? (
                  <>Sync configured but inactive — auth in progress…</>
                ) : (
                  <>Sync disabled (local-only mode)</>
                )}
              </span>
            </div>
          </div>

          {/* Import + Export buttons. Import OVERWRITES the existing settings
              (by user requirement). A restart is still needed for the
              Firebase init to pick up changes. */}
          <input
            ref={settingsFileInputRef}
            type="file"
            accept="application/json,.json"
            onChange={handleSettingsFileChosen}
            className="hidden"
          />
          <button
            onClick={triggerSettingsImport}
            disabled={importingSettings}
            className="w-full flex items-center justify-center gap-2 bg-sky-600 text-white font-semibold py-2.5 rounded-md active:bg-sky-700 transition disabled:bg-slate-300"
          >
            <UploadIcon />
            {importingSettings ? 'Importing…' : 'Import settings JSON (overwrites)'}
          </button>
          <button
            onClick={handleExportSettings}
            disabled={exportingSettings}
            className="w-full flex items-center justify-center gap-2 bg-white text-sky-700 border border-sky-300 font-semibold py-2.5 rounded-md active:bg-sky-50 transition disabled:opacity-60"
          >
            <DownloadIcon />
            {exportingSettings ? 'Exporting…' : 'Export current settings'}
          </button>

          <details className="text-xs text-slate-500">
            <summary className="cursor-pointer font-semibold text-slate-600">JSON format reference</summary>
            <pre className="mt-2 p-3 bg-slate-900 text-sky-100 rounded-md overflow-x-auto leading-relaxed text-[11px]">{`{
  "version": 1,
  "business": {
    "name": "Bharti Traders",
    "phone": "+91 ...",
    "address": "...",
    "gst": "...",
    "shopCode": "acme-store-2026"
  },
  "firebase": {
    "apiKey": "AIzaSy...",
    "projectId": "billmaker-abc12",
    "appId": "1:123:android:abcdef",
    "authDomain": "billmaker-abc12.firebaseapp.com",
    "messagingSenderId": "123456789",
    "storageBucket": "billmaker-abc12.appspot.com"
  }
}`}</pre>
            <p className="mt-2 leading-relaxed">
              Either block (<code className="font-mono">business</code> or <code className="font-mono">firebase</code>) can be omitted. Imports overwrite every key present in the file. Restart the app after importing to activate Firebase sync.
            </p>
          </details>
        </div>
      </Section>

      <Section
        icon={<UploadIcon />}
        title="Repair & Sync"
        description="Push every local customer, product, bill, payment, and profile to Firestore. Use after re-installing or when another device shows missing data."
      >
        <div className="space-y-3">
          <div className={`rounded-md border p-3 text-xs leading-relaxed ${
            syncStatus.enabled
              ? 'bg-sky-50 border-sky-200 text-sky-900'
              : 'bg-amber-50 border-amber-200 text-amber-900'
          }`}>
            {syncStatus.enabled ? (
              <>
                Customers and products will be written as separate Firestore collections (<code>customers/</code> and <code>products/</code>), keyed by a stable slug of the name. Safe to run any number of times — re-runs only refresh <code>updatedAt</code>.
              </>
            ) : (
              <>
                Sync is not active right now. Save Firebase config + Shop Code above, restart the app, then come back.
              </>
            )}
          </div>

          <button
            onClick={handleRepairSync}
            disabled={!syncStatus.enabled || repairing}
            className="w-full bg-emerald-600 text-white font-semibold py-2.5 rounded-md active:bg-emerald-700 transition disabled:bg-slate-300"
          >
            {repairing ? 'Pushing to cloud…' : 'Repair & Sync to Cloud'}
          </button>

          {repairing && repairProgress && (
            <div className="text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-md p-2.5">
              <p className="font-semibold">
                {repairProgress.phase === 'done'
                  ? 'Wrapping up…'
                  : `Pushing ${repairProgress.phase}… (${repairProgress.done} / ${repairProgress.total})`}
              </p>
              {repairProgress.total > 0 && (
                <div className="mt-1.5 h-1.5 bg-slate-200 rounded overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 transition-all"
                    style={{ width: `${Math.round((repairProgress.done / repairProgress.total) * 100)}%` }}
                  />
                </div>
              )}
            </div>
          )}

          {repairResult && !repairing && (
            <div className={`text-xs rounded-md p-3 border ${
              repairResult.errors.length === 0
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-amber-50 border-amber-200 text-amber-900'
            }`}>
              <p className="font-semibold mb-1">
                {repairResult.errors.length === 0 ? '✓ Sync complete' : `Finished with ${repairResult.errors.length} error(s)`}
              </p>
              <ul className="space-y-0.5">
                <li>• Customers pushed: <strong>{repairResult.customers}</strong></li>
                <li>• Products pushed: <strong>{repairResult.products}</strong></li>
                <li>• Bills pushed: <strong>{repairResult.bills}</strong></li>
                <li>• Payments pushed: <strong>{repairResult.payments}</strong></li>
                <li>• Profiles pushed: <strong>{repairResult.profiles}</strong></li>
                <li className="text-slate-500">• Took {repairResult.durationMs} ms</li>
              </ul>
              {repairResult.errors.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer font-semibold">Show errors ({repairResult.errors.length})</summary>
                  <ul className="mt-1.5 space-y-0.5 font-mono text-[10px] max-h-32 overflow-y-auto">
                    {repairResult.errors.map((e, i) => <li key={i} className="break-all">• {e}</li>)}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>
      </Section>

      <Section
        icon={<DownloadIcon />}
        title="Product sync from URL"
        description="Point this at a JSON endpoint (e.g. a GitHub Pages file). The app auto-syncs on every open, plus you can tap Sync now."
      >
        <div className="space-y-3 text-sm text-slate-700">
          <Field label="Product list URL">
            <input
              type="url"
              inputMode="url"
              value={productSyncUrlDraft}
              onChange={e => setProductSyncUrlDraft(e.target.value)}
              placeholder="https://your-user.github.io/your-repo/products.json"
              className="w-full px-3 py-2 border border-slate-300 rounded-md focus:ring-sky-500 focus:border-sky-500 bg-white font-mono text-xs"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </Field>
          <button
            onClick={handleSaveProductSyncUrl}
            disabled={savingProductSyncUrl || productSyncUrlDraft.trim() === (productSyncCfg.url || '')}
            className="w-full bg-sky-500 text-white font-semibold py-2.5 rounded-md active:bg-sky-600 transition disabled:bg-slate-300"
          >
            {savingProductSyncUrl ? 'Saving…' : 'Save URL'}
          </button>

          <div className="bg-slate-50 border border-slate-200 rounded-md p-3 space-y-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-slate-500 uppercase tracking-wide">Last synced</span>
              <span className="text-slate-800">
                {productSyncCfg.lastSyncedAt
                  ? new Date(productSyncCfg.lastSyncedAt).toLocaleString()
                  : <span className="text-slate-400 italic">never</span>}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-slate-500 uppercase tracking-wide">Last published</span>
              <span className="text-slate-800">
                {productSyncCfg.lastPublishedAt
                  ? new Date(productSyncCfg.lastPublishedAt).toLocaleString()
                  : <span className="text-slate-400 italic">never</span>}
              </span>
            </div>
            {productSyncCfg.lastResult && (
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-slate-500 uppercase tracking-wide">Last result</span>
                <span className="text-slate-800">
                  <strong>{productSyncCfg.lastResult.added}</strong> new · {productSyncCfg.lastResult.total} total
                </span>
              </div>
            )}
          </div>

          <button
            onClick={handleSyncProductsNow}
            disabled={syncingProducts || !productSyncCfg.url}
            className="w-full flex items-center justify-center gap-2 bg-sky-600 text-white font-semibold py-2.5 rounded-md active:bg-sky-700 transition disabled:bg-slate-300"
          >
            <DownloadIcon />
            {syncingProducts ? 'Syncing…' : 'Sync now'}
          </button>

          {/* One-tap publish: POSTs the local catalogue to the same URL.
              npoint.io bins accept anonymous POSTs — no PAT, no OAuth. */}
          <button
            onClick={handlePublishToUrl}
            disabled={publishing || !productSyncCfg.url}
            className="w-full flex items-center justify-center gap-2 bg-emerald-600 text-white font-bold py-2.5 rounded-md active:bg-emerald-700 transition disabled:bg-slate-300"
          >
            <UploadIcon />
            {publishing ? 'Publishing…' : 'Publish local products to URL'}
          </button>

          {/* Fallback when the URL is read-only (e.g. GitHub Pages): export
              the JSON to Downloads so the admin can paste it manually. */}
          <button
            onClick={handleExportProductsForGithub}
            disabled={exportingProducts}
            className="w-full flex items-center justify-center gap-2 bg-white text-slate-700 border border-slate-300 font-semibold py-2 rounded-md active:bg-slate-50 transition disabled:opacity-60"
          >
            <DownloadIcon />
            {exportingProducts ? 'Exporting…' : 'Or export to file'}
          </button>

          <details className="text-xs text-slate-500">
            <summary className="cursor-pointer font-semibold text-slate-600">Set up an npoint.io bin (free, no signup)</summary>
            <ol className="mt-2 space-y-1 list-decimal list-inside leading-relaxed">
              <li>Go to <strong>npoint.io</strong> → click <strong>Create new</strong>.</li>
              <li>Paste a starter list like <code className="font-mono">["Paracetamol 500"]</code> → Save.</li>
              <li>Copy the page URL (e.g. <code className="font-mono">https://api.npoint.io/abc123</code>) into the field above and tap <strong>Save URL</strong>.</li>
              <li>Tap <strong>Publish local products to URL</strong> to overwrite the bin with this device's catalogue.</li>
              <li>Other phones with the same URL get the new list on their next <strong>Sync now</strong> / app open.</li>
            </ol>
          </details>

          <p className="text-xs text-slate-500 leading-relaxed">
            Sync accepts <code className="font-mono">["A","B"]</code>,
            {' '}<code className="font-mono">{`[{"name":"A"}]`}</code>, or
            {' '}<code className="font-mono">{`{"products":[...]}`}</code>.
            Existing names are skipped — only new ones are added.
          </p>
        </div>
      </Section>

      <Section icon={<UserIcon />} title="Users" description="Tag each bill with the user who created it.">
        <div className="space-y-2">
          {profiles.length === 0 && (
            <p className="text-sm text-slate-400 italic">No users yet. Add one below.</p>
          )}
          {profiles.map(p => {
            const isActive = p.id === activeId;
            return (
              <div
                key={p.id}
                className={`flex items-center gap-3 p-3 rounded-md border transition ${
                  isActive ? 'border-sky-500 bg-sky-50' : 'border-slate-200 bg-white'
                }`}
              >
                <button
                  onClick={() => handleActivate(p.id)}
                  className={`w-7 h-7 rounded-full border-2 flex items-center justify-center transition ${
                    isActive ? 'border-sky-500 bg-sky-500 text-white' : 'border-slate-300 bg-white'
                  }`}
                  aria-label={`Make ${p.name} active`}
                >
                  {isActive && <CheckIcon />}
                </button>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-slate-800 truncate">{p.name}</p>
                  {isActive && <p className="text-xs text-sky-600 font-medium">Active</p>}
                </div>
                <button
                  onClick={() => handleDeleteProfile(p.id, p.name)}
                  className="text-slate-400 active:text-red-500 p-1"
                  aria-label={`Delete ${p.name}`}
                >
                  <TrashIcon />
                </button>
              </div>
            );
          })}

          <div className="flex gap-2 pt-2">
            <input
              type="text"
              value={newProfileName}
              onChange={e => setNewProfileName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAddProfile()}
              placeholder="New user name"
              className="flex-1 px-3 py-2 border border-slate-300 rounded-md focus:ring-sky-500 focus:border-sky-500 bg-white"
            />
            <button
              onClick={handleAddProfile}
              disabled={!newProfileName.trim()}
              className="flex items-center gap-1 bg-sky-500 text-white font-semibold px-4 rounded-md active:bg-sky-600 disabled:bg-slate-300"
            >
              <PlusIcon />
              Add
            </button>
          </div>
        </div>
      </Section>

      <Section icon={<PrintIcon />} title="Printer Setup" description="How to print to a USB-C / OTG printer.">
        <PrinterSetupContent showToast={showToast} />
      </Section>

      <Section icon={<PrintIcon />} title="Printer Diagnostics" description="Test the printer connection and capture errors for debugging.">
        <PrinterDiagnostics showToast={showToast} />
      </Section>

      <Section icon={<CheckIcon />} title="Repair / Migrate Data" description="Use this once after upgrading from an older version.">
        <div className="space-y-3 text-sm text-slate-700">
          <p>
            Scans <code className="text-xs bg-slate-100 px-1 rounded">bills.json</code>,{' '}
            <code className="text-xs bg-slate-100 px-1 rounded">customers.json</code>, and{' '}
            <code className="text-xs bg-slate-100 px-1 rounded">products.json</code> in your device's
            Documents folder, fills in missing fields with safe defaults, drops duplicates, and rewrites
            them in the new format. Your existing data is preserved — nothing is deleted.
          </p>
          <button
            onClick={handleMigrate}
            disabled={migrating}
            className="w-full flex items-center justify-center gap-2 bg-amber-500 text-white font-semibold py-3 rounded-md active:bg-amber-600 transition disabled:opacity-60"
          >
            {migrating ? 'Repairing…' : 'Scan and repair data'}
          </button>
          {migrationReport && (
            <div className="bg-slate-50 border border-slate-200 rounded-md p-3 space-y-1 text-xs">
              <p><strong>Bills:</strong> {migrationReport.bills.total} total, {migrationReport.bills.fixed} repaired</p>
              <p><strong>Customers:</strong> {migrationReport.customers.total} total, {migrationReport.customers.fixed} repaired</p>
              <p><strong>Products:</strong> {migrationReport.products.total} total, {migrationReport.products.fixed} repaired</p>
              {migrationReport.errors.length > 0 && (
                <div className="pt-2 border-t border-slate-200">
                  <p className="font-semibold text-red-700">Warnings:</p>
                  <ul className="list-disc list-inside text-red-700">
                    {migrationReport.errors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </Section>

      <Section icon={<CashIcon />} title="Bulk Mark Paid" description="Settle outstanding bills for one or more customers in one action.">
        <div className="space-y-3 text-sm text-slate-700">
          <label className="flex items-center justify-between gap-3 cursor-pointer">
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-slate-800">Enable bulk mark-paid</p>
              <p className="text-xs text-slate-500 leading-relaxed mt-0.5">
                This bulk action creates a "settlement" payment for every outstanding bill of the selected customer(s).
                Kept off by default to prevent accidental mass-payment entries.
              </p>
            </div>
            <button
              role="switch"
              aria-checked={bulkPaidEnabled}
              onClick={() => setBulkPaidEnabled(v => !v)}
              className={`relative w-11 h-6 rounded-full transition flex-shrink-0 ${bulkPaidEnabled ? 'bg-sky-600' : 'bg-slate-300'}`}
            >
              <span
                className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition ${bulkPaidEnabled ? 'left-[22px]' : 'left-0.5'}`}
              />
            </button>
          </label>

          {bulkPaidEnabled && (
            <button
              onClick={() => setShowBulkPaidModal(true)}
              className="w-full flex items-center justify-center gap-2 bg-sky-600 text-white font-bold py-3 rounded-md active:bg-sky-700 transition"
            >
              <CashIcon />
              Mark customer bills as paid
            </button>
          )}
        </div>
      </Section>

      <Section icon={<TrashIcon />} title="Deletion Backups" description="Items removed from this device by cross-device sync are preserved here.">
        <div className="space-y-3 text-sm text-slate-700">
          <div className={`rounded-md border p-3 flex items-center justify-between gap-3 ${
            deletionBackups.length > 0 ? 'bg-amber-50 border-amber-200' : 'bg-slate-50 border-slate-200'
          }`}>
            <div className="min-w-0">
              <p className="font-bold text-slate-800">{deletionBackups.length}</p>
              <p className="text-xs text-slate-500">
                {deletionBackups.length === 0
                  ? 'No deleted items backed up. You\'re all clear.'
                  : 'Items removed from this device when sync detected they were deleted on another device.'}
              </p>
            </div>
          </div>
          {deletionBackups.length > 0 && (
            <>
              <div className="max-h-48 overflow-y-auto border border-slate-200 rounded-md divide-y divide-slate-100">
                {deletionBackups.slice().reverse().slice(0, 30).map((e, i) => (
                  <div key={i} className="px-3 py-2 text-xs">
                    <div className="flex justify-between items-baseline">
                      <span className="font-semibold text-slate-700 capitalize">{e.kind}</span>
                      <span className="text-slate-400">{new Date(e.deletedAt).toLocaleString()}</span>
                    </div>
                    <p className="text-slate-500 font-mono truncate mt-0.5">{e.itemId}</p>
                  </div>
                ))}
                {deletionBackups.length > 30 && (
                  <p className="text-[11px] text-slate-400 italic text-center py-1.5">
                    +{deletionBackups.length - 30} older entries
                  </p>
                )}
              </div>
              <button
                onClick={handleClearDeletionBackups}
                className="w-full flex items-center justify-center gap-2 bg-white text-rose-700 border border-rose-300 font-semibold py-2.5 rounded-md active:bg-rose-50 transition"
              >
                <TrashIcon />
                Clear deletion backup log
              </button>
              <p className="text-xs text-slate-500 leading-relaxed">
                Full item data is preserved in <code className="font-mono">sync_deleted_backup.json</code>. Use <strong>Export all data</strong> to retrieve it as part of a JSON backup.
              </p>
            </>
          )}
        </div>
      </Section>

      <Section icon={<DownloadIcon />} title="Backup & Sync" description="Export a JSON file you can share or import on another device.">
        <div className="space-y-3">
          <button
            onClick={handleExport}
            className="w-full flex items-center justify-center gap-2 bg-indigo-600 text-white font-semibold py-3 rounded-md active:bg-indigo-700 transition"
          >
            <DownloadIcon />
            Export all data (JSON)
          </button>

          <div className="border-t pt-3 space-y-3">
            <p className="text-sm font-medium text-slate-700">Import mode</p>
            <div className="flex gap-2">
              <button
                onClick={() => { setImportMode('merge'); setConfirmReplace(false); }}
                className={`flex-1 py-2 px-3 rounded-md text-sm font-semibold transition ${
                  importMode === 'merge'
                    ? 'bg-sky-500 text-white'
                    : 'bg-white text-slate-700 border border-slate-300'
                }`}
              >
                Merge
              </button>
              <button
                onClick={() => setImportMode('replace')}
                className={`flex-1 py-2 px-3 rounded-md text-sm font-semibold transition ${
                  importMode === 'replace'
                    ? 'bg-red-500 text-white'
                    : 'bg-white text-slate-700 border border-slate-300'
                }`}
              >
                Replace all
              </button>
            </div>
            <p className="text-xs text-slate-500">
              {importMode === 'merge'
                ? 'Keeps your existing data and adds new entries (skips duplicates by ID).'
                : '⚠️ Erases everything currently on this device and replaces it with the file contents.'}
            </p>

            {importMode === 'replace' && (
              <label className="flex items-start gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={confirmReplace}
                  onChange={e => setConfirmReplace(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-red-600 focus:ring-red-500"
                />
                I understand this will erase all existing data.
              </label>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              onChange={handleFileChosen}
              className="hidden"
            />
            <button
              onClick={triggerImport}
              className="w-full flex items-center justify-center gap-2 bg-slate-700 text-white font-semibold py-3 rounded-md active:bg-slate-800 transition"
            >
              <UploadIcon />
              Choose JSON to import
            </button>
          </div>
        </div>
      </Section>

      {showBulkPaidModal && (
        <BulkMarkPaidModal
          onClose={() => setShowBulkPaidModal(false)}
          onChanged={() => {
            onChanged();
            showToast('Bulk payment recorded');
          }}
          showToast={showToast}
        />
      )}
    </div>
  );
};

const PRINT_SERVICES: { name: string; pkg: string; hint: string }[] = [
  { name: 'NokoPrint', pkg: 'com.nokoprint', hint: 'USB-C / Wi-Fi / Bluetooth — works with most Canon, HP, Epson, Brother, etc.' },
  { name: 'Mopria Print Service', pkg: 'org.mopria.printplugin', hint: 'Universal Wi-Fi / IPP-Everywhere' },
  { name: 'HP Print Service Plugin', pkg: 'com.hp.android.printservice', hint: 'For HP printers' },
  { name: 'Canon Print Service', pkg: 'jp.co.canon.android.printservice.plugin', hint: 'For Canon printers (Wi-Fi)' },
  { name: 'Brother Print Service Plugin', pkg: 'com.brother.printservice', hint: 'For Brother printers' },
  { name: 'Epson Print Enabler', pkg: 'epson.print.service', hint: 'For Epson printers' },
];

const openPlayStore = async (
  pkg: string,
  label: string,
  showToast: (m: string, t?: 'success' | 'error') => void,
) => {
  log('info', 'general', `Open Play Store: ${label} (${pkg})`);
  const intentUrl = `market://details?id=${pkg}`;
  const webUrl = `https://play.google.com/store/apps/details?id=${pkg}`;

  let AppLauncher: any;
  try {
    const mod = await import('@capacitor/app-launcher');
    AppLauncher = mod.AppLauncher;
  } catch (e: any) {
    log('error', 'general', 'AppLauncher import failed — running in web?', String(e?.message || e));
    try { window.open(webUrl, '_blank'); } catch {}
    showToast('AppLauncher not available. Search Play Store for: ' + label, 'error');
    return;
  }

  // Try market:// first
  try {
    const r = await AppLauncher.openUrl({ url: intentUrl });
    log('info', 'general', `openUrl(market://) → ${JSON.stringify(r)}`);
    if (r?.completed) return;
    log('warn', 'general', 'market:// returned completed=false; trying https');
  } catch (e: any) {
    log('warn', 'general', `openUrl(market://) threw: ${String(e?.message || e)}`);
  }

  // Fallback to https Play Store URL
  try {
    const r = await AppLauncher.openUrl({ url: webUrl });
    log('info', 'general', `openUrl(https) → ${JSON.stringify(r)}`);
    if (r?.completed) return;
    log('warn', 'general', 'https URL returned completed=false');
  } catch (e: any) {
    log('error', 'general', `openUrl(https) threw: ${String(e?.message || e)}`);
  }

  // Both failed
  showToast(
    `Could not open Play Store for "${label}". Open Play Store manually and search for "${label}".`,
    'error',
  );
};

const PrinterSetupContent: React.FC<{ showToast: (m: string, t?: 'success' | 'error') => void }> = ({ showToast }) => {
  const usb = useUsbPrinter();
  return (
  <div className="space-y-4 text-sm text-slate-700">
    <UsbPrinterStatus printers={usb.printers} supported={usb.supported} />

    <ol className="space-y-2 list-decimal list-inside">
      <li>Plug your printer into the device's <strong>USB-C port</strong> (use an OTG adapter if needed).</li>
      <li>Install a <strong>print service</strong> for Android to talk to it (see options below).</li>
      <li>Open the <strong>Print</strong> tab, select bills, tap <strong>Print → choose printer</strong>.</li>
      <li>Your USB printer appears in the printer list — pick it and print.</li>
    </ol>

    <div className="bg-amber-50 border border-amber-200 rounded-md p-3 text-xs text-amber-900">
      <strong>Note:</strong> USB printing needs a device that supports <strong>USB Host (OTG)</strong>.
      Most modern Android phones/tablets do. The emulator does not — testing requires a real device.
    </div>

    <div>
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Recommended print services</p>
      <div className="space-y-2">
        {PRINT_SERVICES.map(s => (
          <button
            key={s.pkg}
            onClick={() => openPlayStore(s.pkg, s.name, showToast)}
            className="w-full flex items-center justify-between gap-3 p-3 rounded-md border border-slate-200 bg-white active:bg-slate-50 transition text-left"
          >
            <div className="min-w-0">
              <p className="font-semibold text-slate-800 truncate">{s.name}</p>
              <p className="text-xs text-slate-500 truncate">{s.hint}</p>
            </div>
            <span className="text-sky-600 flex-shrink-0">
              <ExternalLinkIcon />
            </span>
          </button>
        ))}
      </div>
    </div>

    <p className="text-xs text-slate-500 leading-relaxed">
      If the printer doesn't show up in the print dialog, unplug & replug the cable, then check{' '}
      <em>Android Settings → Connected devices → USB</em> to confirm the printer is detected.
    </p>
  </div>
  );
};

interface SectionProps {
  icon: React.ReactNode;
  title: string;
  description?: string;
  children: React.ReactNode;
}

const Section: React.FC<SectionProps> = ({ icon, title, description, children }) => (
  <section className="bg-white rounded-xl shadow-sm overflow-hidden">
    <header className="px-5 py-4 border-b bg-slate-50 flex items-start gap-3">
      <div className="w-9 h-9 rounded-lg bg-sky-100 text-sky-600 flex items-center justify-center flex-shrink-0">
        {icon}
      </div>
      <div className="min-w-0">
        <h2 className="font-bold text-slate-800">{title}</h2>
        {description && <p className="text-xs text-slate-500 mt-0.5">{description}</p>}
      </div>
    </header>
    <div className="p-5">{children}</div>
  </section>
);

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label className="block text-sm font-medium text-slate-600 mb-1">{label}</label>
    {children}
  </div>
);

export default SettingsView;
