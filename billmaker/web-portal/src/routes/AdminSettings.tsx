import React, { useState, useEffect, useRef } from 'react';
import { Settings as SettingsIcon, Flame, Store, ShieldCheck, AlertCircle, ExternalLink, Trash2, Image as ImageIcon, Cloud, Mail, Phone as PhoneIcon, Loader2, RotateCw, CheckCircle2, Upload } from 'lucide-react';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Badge } from '../components/ui/badge';
import {
  PortalConfig,
  getPortalConfig,
  savePortalConfig,
  clearPortalConfig,
  isConfigValid,
  isImagesConfigured,
  onConfigChange,
} from '../data/portalConfig';
import { authedFetch } from '../lib/authClient';
import { store, bulkDeleteProducts, isEnsureProductsEnabled, setEnsureProductsEnabled } from '../data/dummyData';
import {
  loadMorePortalProducts,
  areMorePortalProductsAvailable,
  backfillProductsLastModified,
  migrateBillsAckMetaToBillDocs,
  purgePortalBillsMeta,
  consolidateProductsToSlugs,
  type ConsolidateResult,
  migratePaymentsIntoBills,
  type MigratePaymentsResult,
  auditFirestoreSchemas,
  normalizeFirestoreSchemas,
  findGhostBills,
  purgeGhostBills,
  type SchemaAuditReport,
  type SchemaNormalizeResult,
  type GhostBillScanResult,
} from '../lib/firestoreSync';

interface ShopRecord {
  code: string;
  name: string;
  admin_contact_email: string | null;
  admin_contact_phone: string | null;
  display_name: string | null;
}

const AdminSettings: React.FC = () => {
  const [cfg, setCfg] = useState<PortalConfig>(getPortalConfig());
  const [draft, setDraft] = useState<PortalConfig>(getPortalConfig());
  const [savedToast, setSavedToast] = useState(false);

  // Shop record (admin contact info) — lives in the auth-service shops table,
  // not in localStorage. Loaded once on mount.
  const [shop, setShop] = useState<ShopRecord | null>(null);
  const [shopDraft, setShopDraft] = useState<ShopRecord | null>(null);
  const [shopSaving, setShopSaving] = useState(false);
  const [shopError, setShopError] = useState<string | null>(null);
  const [shopSaved, setShopSaved] = useState(false);

  useEffect(() => onConfigChange(c => setCfg(c)), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await authedFetch('/admin/shop');
        if (!r.ok) return;
        const body = await r.json();
        if (!cancelled && body.shop) {
          setShop(body.shop);
          setShopDraft(body.shop);
        }
      } catch {
        // ignore — admin can still use the rest of the page
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const shopDirty = shop && shopDraft && (
    (shop.admin_contact_email || '') !== (shopDraft.admin_contact_email || '') ||
    (shop.admin_contact_phone || '') !== (shopDraft.admin_contact_phone || '') ||
    (shop.display_name || '') !== (shopDraft.display_name || '')
  );

  const handleShopSave = async () => {
    if (!shopDraft) return;
    setShopSaving(true);
    setShopError(null);
    try {
      const r = await authedFetch('/admin/shop', {
        method: 'PATCH',
        body: JSON.stringify({
          admin_contact_email: shopDraft.admin_contact_email || '',
          admin_contact_phone: shopDraft.admin_contact_phone || '',
          display_name: shopDraft.display_name || '',
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || 'save_failed');
      setShop(body.shop);
      setShopDraft(body.shop);
      setShopSaved(true);
      setTimeout(() => setShopSaved(false), 3000);
    } catch (e: any) {
      setShopError(e?.message === 'invalid_email' ? 'Please enter a valid email.' : 'Could not save. Try again.');
    } finally {
      setShopSaving(false);
    }
  };

  const dirty =
    draft.apiKey !== cfg.apiKey ||
    draft.projectId !== cfg.projectId ||
    draft.appId !== cfg.appId ||
    (draft.authDomain || '') !== (cfg.authDomain || '') ||
    (draft.messagingSenderId || '') !== (cfg.messagingSenderId || '') ||
    (draft.cloudinaryCloudName || '') !== (cfg.cloudinaryCloudName || '') ||
    (draft.cloudinaryUploadPreset || '') !== (cfg.cloudinaryUploadPreset || '') ||
    draft.shopCode !== cfg.shopCode;

  const valid = isConfigValid(draft);
  const connected = isConfigValid(cfg);
  const imagesReady = isImagesConfigured(cfg);

  const handleSave = () => {
    savePortalConfig(draft);
    setSavedToast(true);
    setTimeout(() => setSavedToast(false), 3000);
  };

  // ---------------------------------------------------------------------------
  // Bulk JSON config import. Saves the admin from typing 10+ fields by hand on
  // every fresh install / new device. Expected file shape:
  //   {
  //     "firebase": { "apiKey": "...", "projectId": "...", "appId": "...",
  //                   "authDomain": "...", "messagingSenderId": "..." },
  //     "shopCode": "your-shop-code",
  //     "cloudinary": { "cloudName": "...", "uploadPreset": "..." },
  //     "shop": { "display_name": "...", "admin_contact_email": "...",
  //               "admin_contact_phone": "..." }
  //   }
  // Overwrite mode: present fields replace existing values; absent fields are
  // left untouched.
  // ---------------------------------------------------------------------------
  const importFileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleImport = async (file: File): Promise<void> => {
    setImporting(true);
    setImportMsg(null);
    try {
      const text = await file.text();
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('File is not valid JSON.');
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('JSON root must be an object.');
      }

      // Strict-ish validators — surface typos rather than silently ignoring.
      const asObject = (v: unknown, path: string): Record<string, unknown> | undefined => {
        if (v === undefined) return undefined;
        if (typeof v !== 'object' || v === null || Array.isArray(v)) {
          throw new Error(`"${path}" must be an object.`);
        }
        return v as Record<string, unknown>;
      };
      const asString = (v: unknown, path: string): string | undefined => {
        if (v === undefined) return undefined;
        if (typeof v !== 'string') throw new Error(`"${path}" must be a string.`);
        return v.trim();
      };

      const fb = asObject(parsed.firebase, 'firebase');
      const cn = asObject(parsed.cloudinary, 'cloudinary');
      const sh = asObject(parsed.shop, 'shop');
      const shopCode = asString(parsed.shopCode, 'shopCode');

      // Build merged portal config (only overwrite fields the user included)
      const current = getPortalConfig();
      const next: PortalConfig = {
        apiKey: asString(fb?.apiKey, 'firebase.apiKey') ?? current.apiKey,
        projectId: asString(fb?.projectId, 'firebase.projectId') ?? current.projectId,
        appId: asString(fb?.appId, 'firebase.appId') ?? current.appId,
        authDomain: asString(fb?.authDomain, 'firebase.authDomain') ?? current.authDomain,
        messagingSenderId:
          asString(fb?.messagingSenderId, 'firebase.messagingSenderId') ?? current.messagingSenderId,
        shopCode: shopCode ?? current.shopCode,
        cloudinaryCloudName:
          asString(cn?.cloudName, 'cloudinary.cloudName') ?? current.cloudinaryCloudName,
        cloudinaryUploadPreset:
          asString(cn?.uploadPreset, 'cloudinary.uploadPreset') ?? current.cloudinaryUploadPreset,
      };
      savePortalConfig(next);
      setDraft(next);

      // Shop record — only PATCH if user included a `shop` block. Failures here
      // shouldn't roll back the portal config save (it's already persisted), so
      // we surface a partial-success message instead.
      let shopUpdated = false;
      if (sh) {
        const displayName = asString(sh.display_name, 'shop.display_name');
        const adminEmail = asString(sh.admin_contact_email, 'shop.admin_contact_email');
        const adminPhone = asString(sh.admin_contact_phone, 'shop.admin_contact_phone');
        try {
          const r = await authedFetch('/admin/shop', {
            method: 'PATCH',
            body: JSON.stringify({
              display_name: displayName ?? (shop?.display_name || ''),
              admin_contact_email: adminEmail ?? (shop?.admin_contact_email || ''),
              admin_contact_phone: adminPhone ?? (shop?.admin_contact_phone || ''),
            }),
          });
          const body = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
          if (body.shop) {
            setShop(body.shop);
            setShopDraft(body.shop);
          }
          shopUpdated = true;
        } catch (e: any) {
          setImportMsg({
            type: 'error',
            text: `Portal config saved, but shop record update failed: ${e?.message || 'unknown'}`,
          });
          return;
        }
      }

      const parts = ['Portal config updated'];
      if (shopUpdated) parts.push('shop record updated');
      setImportMsg({ type: 'success', text: parts.join(' · ') + '.' });
      setTimeout(() => setImportMsg(null), 6000);
    } catch (e: any) {
      setImportMsg({ type: 'error', text: e?.message || 'Import failed.' });
    } finally {
      setImporting(false);
      // Reset the file input so the same file can be re-selected
      if (importFileRef.current) importFileRef.current.value = '';
    }
  };

  const handleClear = () => {
    if (!window.confirm('Clear all Firebase configuration? This will disconnect the portal from your Firestore. (Local data here is unaffected.)')) return;
    clearPortalConfig();
    setDraft(getPortalConfig());
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight flex items-center gap-2">
          <SettingsIcon className="h-7 w-7 text-secondary" /> Settings
        </h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          Admin-only configuration. These credentials connect the web portal to the same Firestore your Baniya mobile app uses.
        </p>
      </header>

      {/* Connection status hero */}
      <Card className={`mb-4 border-2 ${connected ? 'border-emerald-300 bg-emerald-50' : 'border-amber-300 bg-amber-50'}`}>
        <CardContent className="p-4 flex items-start gap-3">
          {connected ? (
            <ShieldCheck className="h-6 w-6 text-emerald-700 flex-shrink-0" />
          ) : (
            <AlertCircle className="h-6 w-6 text-amber-700 flex-shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className={`font-bold ${connected ? 'text-emerald-900' : 'text-amber-900'}`}>
                {connected ? 'Firestore configured' : 'Firestore not configured'}
              </p>
              {connected && <Badge variant="success">Active</Badge>}
            </div>
            <p className={`text-xs mt-0.5 ${connected ? 'text-emerald-800' : 'text-amber-800'}`}>
              {connected ? (
                <>
                  Connected to project <span className="font-mono font-semibold">{cfg.projectId}</span>,
                  shop <span className="font-mono font-semibold">{cfg.shopCode}</span>.
                  The <strong>Manage Customers</strong> tab will pull raw names from this Firestore once live sync is wired.
                </>
              ) : (
                <>Enter your Firebase credentials + shop code below to enable cloud sync. Required for <strong>Manage Customers</strong> to pull data from Baniya mobile.</>
              )}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Bulk JSON import — saves typing 10+ fields on every new install. */}
      <Card className="mb-4 border-2 border-dashed border-primary/30 bg-primary/5">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-primary to-secondary flex items-center justify-center text-white flex-shrink-0">
              <Upload className="h-4 w-4" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-sm">Bulk import config</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Upload a JSON file containing Firebase, Cloudinary, shop code, and shop record values
                in one go. Present fields overwrite; missing fields stay untouched.
              </p>
              <details className="mt-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer font-medium select-none hover:text-foreground">
                  Show expected JSON shape
                </summary>
                <pre className="mt-1.5 p-2.5 rounded-md bg-slate-900 text-slate-100 text-[10.5px] leading-snug overflow-auto font-mono">{`{
  "firebase": {
    "apiKey": "AIza...",
    "projectId": "your-project-id",
    "appId": "1:935...:web:...",
    "authDomain": "your-project-id.firebaseapp.com",
    "messagingSenderId": "935..."
  },
  "shopCode": "your-shop-prod-...",
  "cloudinary": {
    "cloudName": "your-cloud",
    "uploadPreset": "portal_unsigned"
  },
  "shop": {
    "display_name": "Your Shop",
    "admin_contact_email": "support@yourshop.example",
    "admin_contact_phone": "+91..."
  }
}`}</pre>
                <p className="mt-1.5 text-[11px]">
                  Keep this file outside of git. Each top-level block is optional &mdash;
                  include only the sections you want to overwrite.
                </p>
              </details>
              {importMsg && (
                <p
                  className={`text-xs mt-2 font-medium ${
                    importMsg.type === 'success' ? 'text-emerald-700' : 'text-rose-700'
                  }`}
                >
                  {importMsg.text}
                </p>
              )}
            </div>
            <input
              ref={importFileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) void handleImport(f);
              }}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => importFileRef.current?.click()}
              disabled={importing}
              className="flex-shrink-0"
            >
              {importing ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Importing
                </>
              ) : (
                <>
                  <Upload className="h-3.5 w-3.5" /> Choose JSON
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Firebase config card */}
      <Card className="mb-4">
        <div className="px-5 py-4 border-b bg-slate-50 rounded-t-xl flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-orange-500 to-amber-600 flex items-center justify-center text-white">
            <Flame className="h-5 w-5" />
          </div>
          <div>
            <p className="font-bold">Firebase Web App Config</p>
            <p className="text-xs text-muted-foreground">
              From Firebase Console → Project Settings → Your apps → register a <em>Web</em> app
            </p>
          </div>
        </div>
        <CardContent className="p-5 space-y-4">
          <div className="bg-sky-50 border border-sky-200 rounded-lg px-3 py-2 text-xs text-sky-900">
            <p className="font-semibold mb-1 flex items-center gap-1.5">
              <ExternalLink className="h-3.5 w-3.5" /> How to get these values
            </p>
            <ol className="list-decimal list-inside space-y-0.5 ml-1">
              <li>Open <a href="https://console.firebase.google.com" target="_blank" rel="noreferrer" className="underline font-semibold">Firebase Console</a> → your project (e.g. <span className="font-mono">your-project-id</span>)</li>
              <li>Click the gear icon → <strong>Project settings → General</strong></li>
              <li>Scroll to "Your apps". Click <strong>&lt;/&gt; Add app</strong> (web). Give it a nickname like "Portal".</li>
              <li>Firebase shows a <span className="font-mono">firebaseConfig</span> object. Copy <span className="font-mono">apiKey</span>, <span className="font-mono">projectId</span>, <span className="font-mono">appId</span> into the fields below.</li>
            </ol>
          </div>

          <div>
            <Label htmlFor="apiKey" className="mb-1.5">
              API Key <span className="text-rose-600 normal-case">*</span>
            </Label>
            <Input
              id="apiKey"
              value={draft.apiKey}
              onChange={e => setDraft(d => ({ ...d, apiKey: e.target.value }))}
              placeholder="AIzaSyDXziOi3zg24w..."
              className="font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="projectId" className="mb-1.5">
                Project ID <span className="text-rose-600 normal-case">*</span>
              </Label>
              <Input
                id="projectId"
                value={draft.projectId}
                onChange={e => setDraft(d => ({ ...d, projectId: e.target.value }))}
                placeholder="your-project-id"
                className="font-mono text-xs"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div>
              <Label htmlFor="appId" className="mb-1.5">
                App ID <span className="text-rose-600 normal-case">*</span>
              </Label>
              <Input
                id="appId"
                value={draft.appId}
                onChange={e => setDraft(d => ({ ...d, appId: e.target.value }))}
                placeholder="1:935...:web:abcdef"
                className="font-mono text-xs"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>

          <details className="text-xs">
            <summary className="cursor-pointer font-semibold text-muted-foreground hover:text-foreground select-none">
              Advanced — Auth Domain & Sender ID (optional)
            </summary>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
              <div>
                <Label htmlFor="authDomain" className="mb-1.5">Auth Domain</Label>
                <Input
                  id="authDomain"
                  value={draft.authDomain || ''}
                  onChange={e => setDraft(d => ({ ...d, authDomain: e.target.value }))}
                  placeholder="your-project-id.firebaseapp.com"
                  className="font-mono text-xs"
                />
                <p className="text-[10px] text-muted-foreground mt-1">Auto-derived from Project ID if blank.</p>
              </div>
              <div>
                <Label htmlFor="senderId" className="mb-1.5">Messaging Sender ID</Label>
                <Input
                  id="senderId"
                  value={draft.messagingSenderId || ''}
                  onChange={e => setDraft(d => ({ ...d, messagingSenderId: e.target.value }))}
                  placeholder="935278477119"
                  className="font-mono text-xs"
                />
                <p className="text-[10px] text-muted-foreground mt-1">Only needed if you'll use push notifications.</p>
              </div>
            </div>
          </details>
        </CardContent>
      </Card>

      {/* Cloudinary card — product images */}
      <Card className="mb-4">
        <div className="px-5 py-4 border-b bg-slate-50 rounded-t-xl flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-sky-500 to-indigo-600 flex items-center justify-center text-white">
            <Cloud className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-bold">Product Image Hosting</p>
              <Badge variant="secondary">Cloudinary</Badge>
              {imagesReady && <Badge variant="success">Ready</Badge>}
            </div>
            <p className="text-xs text-muted-foreground">
              Free tier: 25 credits/month (≈ 25 GB storage + 25 GB delivery). No credit card required. Independent from Firestore.
            </p>
          </div>
        </div>
        <CardContent className="p-5 space-y-4">
          <div className="bg-sky-50 border border-sky-200 rounded-lg px-3 py-2.5 text-xs text-sky-900">
            <p className="font-semibold mb-1 flex items-center gap-1.5">
              <ExternalLink className="h-3.5 w-3.5" /> One-time Cloudinary setup (~3 min)
            </p>
            <ol className="list-decimal list-inside space-y-1 ml-1">
              <li>
                Sign up free at{' '}
                <a href="https://cloudinary.com/users/register_free" target="_blank" rel="noreferrer" className="underline font-semibold">
                  cloudinary.com
                </a>{' '}
                (no card needed).
              </li>
              <li>
                In the dashboard, copy your <strong>Cloud name</strong> (top of the page, looks like <span className="font-mono">dwxyz1234</span>).
              </li>
              <li>
                Go to <strong>Settings (gear icon) → Upload → Upload presets → Add upload preset</strong>.
              </li>
              <li>
                Set <strong>Signing Mode = Unsigned</strong>. Name it something simple like <span className="font-mono">my-shop-uploads</span>. Click <strong>Save</strong>.
              </li>
              <li>
                Optional but recommended: in the same preset, under "Media analysis and AI" → enable <strong>auto-tagging</strong>, and under "Storage and access" → leave folder restrictions off (uploads will go to <span className="font-mono">shops/&lt;shopCode&gt;/products/&lt;id&gt;</span>).
              </li>
              <li>Paste both values below and save.</li>
            </ol>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="cloudinaryCloudName" className="mb-1.5">Cloud Name</Label>
              <Input
                id="cloudinaryCloudName"
                value={draft.cloudinaryCloudName || ''}
                onChange={e => setDraft(d => ({ ...d, cloudinaryCloudName: e.target.value }))}
                placeholder="dwxyz1234"
                className="font-mono text-xs"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-[10px] text-muted-foreground mt-1">From the top of your Cloudinary dashboard.</p>
            </div>
            <div>
              <Label htmlFor="cloudinaryUploadPreset" className="mb-1.5">Upload Preset</Label>
              <Input
                id="cloudinaryUploadPreset"
                value={draft.cloudinaryUploadPreset || ''}
                onChange={e => setDraft(d => ({ ...d, cloudinaryUploadPreset: e.target.value }))}
                placeholder="my-shop-uploads"
                className="font-mono text-xs"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-[10px] text-muted-foreground mt-1">The name of the <strong>unsigned</strong> preset you created.</p>
            </div>
          </div>

          <div className="bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2 text-[11px] text-emerald-900">
            <p className="font-semibold flex items-center gap-1.5">
              <ImageIcon className="h-3 w-3" /> What happens on upload
            </p>
            <p className="mt-0.5">
              Images are resized to 1600 px / WebP in your browser before upload (typically ~150 KB each), then served via Cloudinary's CDN with auto-format (<span className="font-mono">f_auto</span>) + auto-quality (<span className="font-mono">q_auto</span>) so each client gets the smallest format their browser supports.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Shop Code card */}
      <Card className="mb-4">
        <div className="px-5 py-4 border-b bg-slate-50 rounded-t-xl flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-primary to-secondary flex items-center justify-center text-white">
            <Store className="h-5 w-5" />
          </div>
          <div>
            <p className="font-bold">Shop Identifier</p>
            <p className="text-xs text-muted-foreground">Must match the Shop Code you set in Baniya mobile → Settings → My Business</p>
          </div>
        </div>
        <CardContent className="p-5">
          <div>
            <Label htmlFor="shopCode" className="mb-1.5">
              Shop Code <span className="text-rose-600 normal-case">*</span>
            </Label>
            <Input
              id="shopCode"
              value={draft.shopCode}
              onChange={e => setDraft(d => ({ ...d, shopCode: e.target.value }))}
              placeholder="e.g. my-shop-2026"
              className="font-mono text-sm"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
              All bills, customers, and payments are stored under the path{' '}
              <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">shops/{draft.shopCode || '<shopCode>'}/…</code>.
              Use the <strong>exact same string</strong> across mobile + web so they sync.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Save / Clear actions */}
      <div className="flex flex-col sm:flex-row gap-2 sticky bottom-4 bg-background/90 backdrop-blur p-2 rounded-lg border shadow-md">
        <Button
          variant="ghost"
          onClick={handleClear}
          disabled={!connected}
          className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
        >
          <Trash2 className="h-4 w-4" /> Clear
        </Button>
        <div className="flex-1" />
        <Button
          variant="outline"
          onClick={() => setDraft(getPortalConfig())}
          disabled={!dirty}
        >
          Discard changes
        </Button>
        <Button
          onClick={handleSave}
          disabled={!dirty || !valid}
        >
          Save configuration
        </Button>
      </div>

      {savedToast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-emerald-600 text-white text-sm font-semibold px-4 py-3 rounded-lg shadow-xl animate-fade-in">
          ✓ Configuration saved. Restart sync or refresh to apply.
        </div>
      )}

      {/* Shop contact info — shown to clients on the login page when they
          have no usable email configured ("Please contact <admin>") */}
      <Card className="mt-6">
        <div className="px-5 py-4 border-b bg-slate-50 rounded-t-xl flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-secondary to-accent flex items-center justify-center text-white">
            <Store className="h-5 w-5" />
          </div>
          <div>
            <p className="font-bold">Shop contact info</p>
            <p className="text-xs text-muted-foreground">
              Shown to clients on the login page if their account has no email. Optional.
            </p>
          </div>
        </div>
        <CardContent className="p-5 space-y-4">
          {!shopDraft ? (
            <div className="text-xs text-muted-foreground italic flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading shop record…
            </div>
          ) : (
            <>
              <div>
                <Label htmlFor="display_name" className="mb-1.5">
                  Display name
                </Label>
                <Input
                  id="display_name"
                  value={shopDraft.display_name || ''}
                  onChange={e => setShopDraft(d => d ? { ...d, display_name: e.target.value } : d)}
                  placeholder="Your Shop"
                  className="text-sm"
                  autoComplete="off"
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Human-readable name shown to clients (defaults to shop code if blank).
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="contact_email" className="mb-1.5 flex items-center gap-1.5">
                    <Mail className="h-3.5 w-3.5" /> Contact email
                  </Label>
                  <Input
                    id="contact_email"
                    type="email"
                    value={shopDraft.admin_contact_email || ''}
                    onChange={e => setShopDraft(d => d ? { ...d, admin_contact_email: e.target.value } : d)}
                    placeholder="admin@yourshop.example"
                    className="text-sm"
                    autoComplete="off"
                  />
                </div>
                <div>
                  <Label htmlFor="contact_phone" className="mb-1.5 flex items-center gap-1.5">
                    <PhoneIcon className="h-3.5 w-3.5" /> Contact phone
                  </Label>
                  <Input
                    id="contact_phone"
                    type="tel"
                    value={shopDraft.admin_contact_phone || ''}
                    onChange={e => setShopDraft(d => d ? { ...d, admin_contact_phone: e.target.value } : d)}
                    placeholder="+91 98765 43210"
                    className="text-sm"
                    autoComplete="off"
                  />
                </div>
              </div>

              {shopError && (
                <div className="bg-rose-50 border border-rose-200 rounded-md px-3 py-2 text-xs text-rose-800 flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <span>{shopError}</span>
                </div>
              )}

              <div className="flex items-center gap-2 justify-end">
                {shopSaved && (
                  <span className="text-xs text-emerald-700 font-semibold inline-flex items-center gap-1">
                    <ShieldCheck className="h-3.5 w-3.5" /> Saved
                  </span>
                )}
                <Button
                  variant="outline"
                  onClick={() => setShopDraft(shop)}
                  disabled={!shopDirty || shopSaving}
                >
                  Discard
                </Button>
                <Button
                  onClick={handleShopSave}
                  disabled={!shopDirty || shopSaving}
                >
                  {shopSaving ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : 'Save contact info'}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Maintenance — manual jobs admin can run on demand. */}
      <MaintenanceCard />
    </div>
  );
};


// ---------------------------------------------------------------------------
// Maintenance card — Reconcile + product search backfill + catalog cleanup.
// ---------------------------------------------------------------------------
type Phantom = { id: string; name: string; twinIds: string[]; score: number };

const MaintenanceCard: React.FC = () => {
  const [reconciling, setReconciling] = useState(false);
  const [reconcileResult, setReconcileResult] = useState<string | null>(null);
  const [reconcileError, setReconcileError] = useState<string | null>(null);

  // Backfill state — same pattern as reconcile
  const [backfilling, setBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);
  const [backfillError, setBackfillError] = useState<string | null>(null);

  // Backfill state for legacy customers/products updatedAt — used so the
  // mobile-canonical name registries can sync to Supabase and reach mobile
  // clients via Realtime. Independent state from the lastModified backfill.
  const [legacyBackfilling, setLegacyBackfilling] = useState(false);
  const [legacyBackfillResult, setLegacyBackfillResult] = useState<string | null>(null);
  const [legacyBackfillError, setLegacyBackfillError] = useState<string | null>(null);

  // Ack-meta → bills migration state
  const [migratingAck, setMigratingAck] = useState(false);
  const [migrateAckResult, setMigrateAckResult] = useState<string | null>(null);
  const [migrateAckError, setMigrateAckError] = useState<string | null>(null);
  const [purgingMeta, setPurgingMeta] = useState(false);
  const [purgeMetaResult, setPurgeMetaResult] = useState<string | null>(null);
  const [purgeMetaError, setPurgeMetaError] = useState<string | null>(null);
  const [consolidating, setConsolidating] = useState(false);
  const [consolidateResult, setConsolidateResult] = useState<ConsolidateResult | null>(null);
  const [consolidateError, setConsolidateError] = useState<string | null>(null);
  const [migratingPayments, setMigratingPayments] = useState(false);
  const [migratePaymentsResult, setMigratePaymentsResult] = useState<MigratePaymentsResult | null>(null);
  const [migratePaymentsError, setMigratePaymentsError] = useState<string | null>(null);

  // Schema audit + normalize state
  const [auditing, setAuditing] = useState(false);
  const [auditReport, setAuditReport] = useState<SchemaAuditReport | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [normalizing, setNormalizing] = useState(false);
  const [normalizeResult, setNormalizeResult] = useState<SchemaNormalizeResult | null>(null);
  const [normalizeError, setNormalizeError] = useState<string | null>(null);
  const [ghostScanning, setGhostScanning] = useState(false);
  const [ghostScanResult, setGhostScanResult] = useState<GhostBillScanResult | null>(null);
  const [ghostScanError, setGhostScanError] = useState<string | null>(null);
  const [ghostPurging, setGhostPurging] = useState(false);
  const [ghostPurgeResult, setGhostPurgeResult] = useState<{ deleted: number; errors: number } | null>(null);
  const [ghostPurgeError, setGhostPurgeError] = useState<string | null>(null);

  // --- Catalog cleanup state ---
  const [scanState, setScanState] = useState<'idle' | 'scanning' | 'scanned' | 'deleting' | 'done'>('idle');
  const [phantoms, setPhantoms] = useState<Phantom[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<string>('');
  const [deleteProgress, setDeleteProgress] = useState({ done: 0, total: 0 });
  const [deleteResult, setDeleteResult] = useState<string | null>(null);

  const normalizeProductName = (s: string): string =>
    (s || '').trim().toLowerCase().replace(/\s+/g, ' ');

  const enrichmentScore = (p: any): number => {
    const priceCount = Object.values(p.prices || {}).filter(v => Number(v) > 0).length;
    return (p.description?.length ? 10 : 0)
      + priceCount * 5
      + (p.images?.length || 0) * 3
      + (p.labelIds?.length || 0) * 2;
  };

  const handleScan = async () => {
    if (scanState === 'scanning' || scanState === 'deleting') return;
    setScanState('scanning');
    setScanError(null);
    setPhantoms([]);
    setDeleteResult(null);
    try {
      // Exhaust the older-products cursor so we see the full catalog before
      // grouping. Without this we'd only dedupe within the top-50 window.
      let pages = 0;
      setScanProgress('Loading full catalog…');
      while (areMorePortalProductsAvailable() && pages < 200) {
        const count = await loadMorePortalProducts();
        pages++;
        setScanProgress(`Loading full catalog… (${pages} pages, ${store.products.length} products)`);
        if (count === 0) break;
      }

      setScanProgress('Scanning for duplicates…');
      const groups = new Map<string, any[]>();
      for (const p of store.products) {
        const k = normalizeProductName(p.name);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(p);
      }
      const found: Phantom[] = [];
      for (const [, group] of groups) {
        if (group.length < 2) continue;
        group.sort((a, b) => enrichmentScore(b) - enrichmentScore(a));
        // group[0] is the keeper, slice(1) are the duplicates to delete
        for (const dup of group.slice(1)) {
          found.push({
            id: dup.id,
            name: dup.name,
            twinIds: group.filter(g => g.id !== dup.id).map(g => g.id),
            score: enrichmentScore(dup),
          });
        }
      }
      setPhantoms(found);
      setScanState('scanned');
      setScanProgress('');
    } catch (e: any) {
      setScanError(String(e?.message || e));
      setScanState('idle');
      setScanProgress('');
    }
  };

  const handleDelete = async () => {
    if (phantoms.length === 0) return;
    const msg =
      `Permanently delete ${phantoms.length} duplicate product${phantoms.length === 1 ? '' : 's'} ` +
      `from Firestore? The keeper copy of each name remains. Supabase will reconcile automatically.\n\n` +
      `This cannot be undone.`;
    if (!window.confirm(msg)) return;

    setScanState('deleting');
    setDeleteResult(null);
    setDeleteProgress({ done: 0, total: phantoms.length });
    try {
      const { deleted, failed, failedIds, slugsDeleted } = await bulkDeleteProducts(
        phantoms.map(p => p.id),
        (done, total) => setDeleteProgress({ done, total }),
      );

      // Fire an explicit reconcile sync so Supabase converges even if the user
      // closes the tab before the debounced auto-sync fires. Reconcile both
      // collections — portal_products (the keepers stay, phantoms gone) and
      // products (the slug docs we just nuked, so Supabase mirror matches).
      try {
        await Promise.all([
          authedFetch('/admin/sync/trigger/portal_products?mode=reconcile', { method: 'POST' }),
          authedFetch('/admin/sync/trigger/products?mode=reconcile', { method: 'POST' }),
        ]);
      } catch {
        // best-effort; the worker's weekly Sunday reconcile will catch any drift
      }

      const parts = [`Deleted ${deleted} duplicates`];
      if (slugsDeleted > 0) parts.push(`${slugsDeleted} slug docs cleaned`);
      if (failed > 0) parts.push(`${failed} failed`);
      parts.push('Supabase reconcile triggered');
      setDeleteResult(parts.join(' · ') + '.');
      setPhantoms(phantoms.filter(p => failedIds.includes(p.id))); // keep failures visible
      setScanState('done');
    } catch (e: any) {
      setScanError(String(e?.message || e));
      setScanState('scanned'); // let them retry
    }
  };

  const handleBackfillLastModified = async () => {
    if (backfilling) return;
    setBackfilling(true);
    setBackfillResult(null);
    setBackfillError(null);
    try {
      const { scanned, updated } = await backfillProductsLastModified();
      setBackfillResult(
        updated === 0
          ? `Scanned ${scanned} products · all already have lastModified`
          : `Scanned ${scanned} products · backfilled ${updated} legacy doc${updated === 1 ? '' : 's'}. They will appear in the catalog after next refresh.`,
      );
    } catch (e: any) {
      setBackfillError(String(e?.message || e));
    } finally {
      setBackfilling(false);
    }
  };

  // Stamps `updatedAt` on legacy `customers/<slug>` and `products/<slug>`
  // docs in Firestore. Required so the worker's incremental sync picks them
  // up and pushes them to Supabase, after which mobile clients receive them
  // via Realtime. One-shot — re-running is a no-op for already-stamped docs.
  const handleBackfillLegacyUpdatedAt = async () => {
    if (legacyBackfilling) return;
    setLegacyBackfilling(true);
    setLegacyBackfillResult(null);
    setLegacyBackfillError(null);
    try {
      const r = await authedFetch('/admin/sync/backfill-legacy-updatedat', { method: 'POST' });
      const body = await r.json().catch(() => null) as
        | { ok: boolean; result?: Record<string, { scanned: number; stamped: number; errors: number }>; error?: string; detail?: string }
        | null;
      if (!r.ok || !body?.ok) {
        setLegacyBackfillError(body?.detail || body?.error || `Failed (${r.status})`);
        return;
      }
      const c = body.result?.customers ?? { scanned: 0, stamped: 0, errors: 0 };
      const p = body.result?.products ?? { scanned: 0, stamped: 0, errors: 0 };
      const totalErrors = c.errors + p.errors;
      const errSuffix = totalErrors > 0 ? ` · ${totalErrors} error${totalErrors === 1 ? '' : 's'}` : '';
      setLegacyBackfillResult(
        `Customers ${c.stamped}/${c.scanned} · Products ${p.stamped}/${p.scanned}${errSuffix}. Mobile autocomplete picks up new names after next sync.`,
      );
    } catch (e: any) {
      setLegacyBackfillError(String(e?.message || e));
    } finally {
      setLegacyBackfilling(false);
    }
  };

  const handleAudit = async () => {
    if (auditing) return;
    setAuditing(true);
    setAuditError(null);
    setAuditReport(null);
    try {
      const report = await auditFirestoreSchemas();
      setAuditReport(report);
    } catch (e: any) {
      setAuditError(String(e?.message || e));
    } finally {
      setAuditing(false);
    }
  };

  const handleNormalize = async () => {
    if (normalizing) return;
    if (!window.confirm(
      'Backfill missing canonical fields on bills, customers, and payments? ' +
      'This will merge defaults (e.g. acknowledged: false on bills missing the ' +
      'field) onto existing docs. Idempotent — safe to re-run.\n\nContinue?'
    )) return;
    setNormalizing(true);
    setNormalizeError(null);
    setNormalizeResult(null);
    try {
      const result = await normalizeFirestoreSchemas();
      setNormalizeResult(result);
    } catch (e: any) {
      setNormalizeError(String(e?.message || e));
    } finally {
      setNormalizing(false);
    }
  };

  const handleGhostScan = async () => {
    if (ghostScanning) return;
    setGhostScanning(true);
    setGhostScanError(null);
    setGhostScanResult(null);
    setGhostPurgeResult(null);
    try {
      const r = await findGhostBills();
      setGhostScanResult(r);
    } catch (e: any) {
      setGhostScanError(String(e?.message || e));
    } finally {
      setGhostScanning(false);
    }
  };

  const handleGhostPurge = async () => {
    if (ghostPurging) return;
    if (!ghostScanResult || ghostScanResult.ghosts.length === 0) return;
    if (!window.confirm(
      `Permanently delete ${ghostScanResult.ghosts.length} ghost bill doc(s) ` +
      `from Firestore? These are docs with only ack metadata (no billNumber, ` +
      `customerName, or products). This cannot be undone.\n\nContinue?`
    )) return;
    setGhostPurging(true);
    setGhostPurgeError(null);
    setGhostPurgeResult(null);
    try {
      const r = await purgeGhostBills(ghostScanResult.ghosts);
      setGhostPurgeResult(r);
      setGhostScanResult(null);
    } catch (e: any) {
      setGhostPurgeError(String(e?.message || e));
    } finally {
      setGhostPurging(false);
    }
  };

  const handleMigrateAckMeta = async () => {
    if (migratingAck) return;
    setMigratingAck(true);
    setMigrateAckResult(null);
    setMigrateAckError(null);
    try {
      const { scanned, migrated, errors } = await migrateBillsAckMetaToBillDocs();
      const parts = [`Scanned ${scanned}`, `Migrated ${migrated}`];
      if (errors > 0) parts.push(`${errors} errors`);
      setMigrateAckResult(parts.join(' · ') + '. Once verified, click "Purge portal_bills_meta" to delete the legacy collection.');
    } catch (e: any) {
      setMigrateAckError(String(e?.message || e));
    } finally {
      setMigratingAck(false);
    }
  };

  const handleMigratePayments = async () => {
    if (migratingPayments) return;
    if (!window.confirm(
      'Backfill every bill\'s `payments[]` array from the separate payments ' +
      'collection?\n\nIdempotent — re-running is safe (arrayUnion dedupes). ' +
      'After this, the portal can read payments directly off bill docs. Continue?'
    )) return;
    setMigratingPayments(true);
    setMigratePaymentsError(null);
    setMigratePaymentsResult(null);
    try {
      const r = await migratePaymentsIntoBills();
      setMigratePaymentsResult(r);
    } catch (e: any) {
      setMigratePaymentsError(String(e?.message || e));
    } finally {
      setMigratingPayments(false);
    }
  };

  const handleConsolidate = async () => {
    if (consolidating) return;
    if (!window.confirm(
      'Consolidate portal_products to slug-as-id?\n\n' +
      'This scans every product, groups by normalized name, and collapses duplicates ' +
      'down to ONE canonical doc per name (id = slug of the name). The most-enriched ' +
      'doc in each group is kept; others are deleted.\n\n' +
      'After this runs, phantom-duplicate products become physically impossible.\n\n' +
      'Idempotent — safe to re-run. Continue?'
    )) return;
    setConsolidating(true);
    setConsolidateError(null);
    setConsolidateResult(null);
    try {
      const r = await consolidateProductsToSlugs();
      setConsolidateResult(r);
    } catch (e: any) {
      setConsolidateError(String(e?.message || e));
    } finally {
      setConsolidating(false);
    }
  };

  const handlePurgeMeta = async () => {
    if (purgingMeta) return;
    if (!window.confirm(
      'Permanently delete the ENTIRE portal_bills_meta collection from Firestore? ' +
      'Only proceed if:\n\n' +
      '  1. You have already clicked "Migrate ack data to bills" (or know the ' +
      'migration was run on a previous deploy), AND\n' +
      '  2. The auth-service has been redeployed with the client.ts change that ' +
      'reads ack from bills (not portal_bills_meta).\n\n' +
      'This cannot be undone. Continue?'
    )) return;
    setPurgingMeta(true);
    setPurgeMetaResult(null);
    setPurgeMetaError(null);
    try {
      const { scanned, deleted, errors } = await purgePortalBillsMeta();
      const parts = [`Scanned ${scanned}`, `Deleted ${deleted}`];
      if (errors > 0) parts.push(`${errors} errors`);
      setPurgeMetaResult(parts.join(' · '));
    } catch (e: any) {
      setPurgeMetaError(String(e?.message || e));
    } finally {
      setPurgingMeta(false);
    }
  };

  const handleReconcile = async () => {
    if (reconciling) return;
    setReconciling(true);
    setReconcileResult(null);
    setReconcileError(null);
    try {
      const r = await authedFetch('/admin/sync/reconcile', { method: 'POST' });
      const body = await r.json().catch(() => null) as any;
      if (!r.ok || !body?.ok) {
        setReconcileError(body?.detail || body?.error || `Failed (${r.status})`);
        return;
      }
      const colCount = body?.result?.collections?.length || 0;
      const total = (body?.result?.collections || []).reduce(
        (s: number, c: any) => s + (c.docCount || 0), 0,
      );
      const deleted = (body?.result?.collections || []).reduce(
        (s: number, c: any) => s + (c.deletedCount || 0), 0,
      );
      setReconcileResult(`Reconciled ${colCount} collection${colCount === 1 ? '' : 's'} · ${total} docs synced · ${deleted} stale removed`);
    } catch (e: any) {
      setReconcileError(String(e?.message || e));
    } finally {
      setReconciling(false);
    }
  };

  return (
    <Card>
      <CardContent className="p-5 sm:p-6 space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-50 border border-blue-200 flex items-center justify-center">
            <RotateCw className="h-5 w-5 text-blue-600" />
          </div>
          <div>
            <h2 className="text-lg font-bold">Maintenance</h2>
            <p className="text-sm text-muted-foreground">
              One-off jobs you can run when something looks off.
            </p>
          </div>
        </div>

        {/* --- Schema audit + normalize (THE source-of-truth tool) --- */}
        <div className="border-t pt-4">
          <p className="text-sm font-semibold mb-1">Firestore schema audit + normalize</p>
          <p className="text-xs text-muted-foreground mb-3 max-w-xl">
            Detects and fixes <strong>schema drift</strong> — docs that are missing fields current
            code expects (e.g. older bills without <code className="font-mono text-[10px]">acknowledged</code>,
            customers without <code className="font-mono text-[10px]">lastModified</code>). The canonical
            schemas are documented in{' '}
            <code className="font-mono text-[10px]">web-portal/docs/firestore-schema.md</code>.
          </p>
          <p className="text-xs text-muted-foreground mb-3 max-w-xl">
            <strong>Workflow:</strong> Click <em>Audit</em> first to see what's drifted. Then click <em>Normalize</em>
            to backfill missing fields with canonical defaults. Audit again to confirm zero gaps.
            Both are safe to re-run.
          </p>
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <Button
              onClick={handleAudit}
              disabled={auditing || normalizing}
              variant="outline"
            >
              {auditing
                ? <><Loader2 className="h-4 w-4 animate-spin" /> Auditing&hellip;</>
                : <><RotateCw className="h-4 w-4" /> Audit schemas</>}
            </Button>
            <Button
              onClick={handleNormalize}
              disabled={normalizing || auditing}
              variant="outline"
            >
              {normalizing
                ? <><Loader2 className="h-4 w-4 animate-spin" /> Normalizing&hellip;</>
                : <><RotateCw className="h-4 w-4" /> Normalize (backfill)</>}
            </Button>
            {auditError && (
              <span className="text-xs text-rose-700 font-semibold inline-flex items-center gap-1">
                <AlertCircle className="h-3.5 w-3.5" /> Audit: {auditError}
              </span>
            )}
            {normalizeError && (
              <span className="text-xs text-rose-700 font-semibold inline-flex items-center gap-1">
                <AlertCircle className="h-3.5 w-3.5" /> Normalize: {normalizeError}
              </span>
            )}
          </div>

          {auditReport && (
            <div className="border rounded-md p-3 mb-2 bg-slate-50 text-xs">
              <p className="font-bold mb-2">Audit Report</p>
              {(['bills', 'customers'] as const).map(coll => {
                const r = auditReport[coll];
                const missingEntries = Object.entries(r.missing) as Array<[string, number]>;
                return (
                  <div key={coll} className="mb-2">
                    <p className="font-mono">
                      <strong>{coll}</strong>: {r.total} doc(s) scanned
                      {missingEntries.length === 0 && <span className="text-emerald-700 ml-2">✓ all fields present</span>}
                    </p>
                    {missingEntries.length > 0 && (
                      <ul className="ml-4 mt-0.5 list-disc">
                        {missingEntries.map(([field, count]) => {
                          const samples = r.samples[field] || [];
                          return (
                            <li key={field} className="text-rose-700 font-mono">
                              {field} <span className="text-ink-soft">— {count} missing</span>
                              {samples.length > 0 && (
                                <span className="text-ink-soft/60 ml-1">
                                  (e.g. {samples.slice(0, 3).join(', ')}{samples.length > 3 ? '…' : ''})
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {normalizeResult && (
            <div className="border rounded-md p-3 mb-2 bg-emerald-50 text-xs">
              <p className="font-bold mb-2 text-emerald-900">Normalize Result</p>
              {(['bills', 'customers'] as const).map(coll => {
                const r = normalizeResult[coll];
                return (
                  <p key={coll} className="font-mono text-emerald-900">
                    <strong>{coll}</strong>: scanned {r.scanned}, normalized {r.normalized}
                    {r.errors > 0 && <span className="text-rose-700"> · {r.errors} errors</span>}
                  </p>
                );
              })}
              <p className="mt-2 text-emerald-800">
                Re-run audit to confirm zero gaps remain.
              </p>
            </div>
          )}

          {/* --- Ghost bills (only ack metadata, no real content) --- */}
          <div className="mt-4 pt-3 border-t border-dashed">
            <p className="text-xs font-semibold mb-1">Ghost bills</p>
            <p className="text-xs text-muted-foreground mb-2 max-w-xl">
              Bill docs that contain only ack metadata (no <code className="font-mono text-[10px]">billNumber</code>,
              <code className="font-mono text-[10px]"> customerName</code>, or <code className="font-mono text-[10px]">products</code>) —
              typically created when the ack-meta migration ran for a bill that was already
              deleted on mobile. Useless and safe to delete.
            </p>
            <div className="flex flex-wrap items-center gap-3 mb-2">
              <Button
                onClick={handleGhostScan}
                disabled={ghostScanning || ghostPurging}
                variant="outline"
              >
                {ghostScanning
                  ? <><Loader2 className="h-4 w-4 animate-spin" /> Scanning&hellip;</>
                  : <><RotateCw className="h-4 w-4" /> Scan ghost bills</>}
              </Button>
              {ghostScanResult && ghostScanResult.ghosts.length > 0 && (
                <Button
                  onClick={handleGhostPurge}
                  disabled={ghostPurging}
                  variant="destructive"
                >
                  {ghostPurging
                    ? <><Loader2 className="h-4 w-4 animate-spin" /> Deleting&hellip;</>
                    : <>Delete {ghostScanResult.ghosts.length} ghost bill{ghostScanResult.ghosts.length === 1 ? '' : 's'}</>}
                </Button>
              )}
              {ghostScanError && (
                <span className="text-xs text-rose-700 font-semibold inline-flex items-center gap-1">
                  <AlertCircle className="h-3.5 w-3.5" /> {ghostScanError}
                </span>
              )}
              {ghostPurgeError && (
                <span className="text-xs text-rose-700 font-semibold inline-flex items-center gap-1">
                  <AlertCircle className="h-3.5 w-3.5" /> {ghostPurgeError}
                </span>
              )}
            </div>
            {ghostScanResult && (
              <div className="border rounded-md p-2.5 mb-2 bg-slate-50 text-xs">
                <p className="font-mono">
                  Scanned <strong>{ghostScanResult.total}</strong> bills · found{' '}
                  <strong className={ghostScanResult.ghosts.length > 0 ? 'text-rose-700' : 'text-emerald-700'}>
                    {ghostScanResult.ghosts.length}
                  </strong> ghost{ghostScanResult.ghosts.length === 1 ? '' : 's'}
                  {ghostScanResult.capped && <span className="text-amber-700"> (capped at 1000)</span>}
                </p>
                {ghostScanResult.ghosts.length > 0 && (
                  <p className="font-mono text-ink-soft/70 mt-1 break-all">
                    e.g. {ghostScanResult.ghosts.slice(0, 5).join(', ')}
                    {ghostScanResult.ghosts.length > 5 && `… (+${ghostScanResult.ghosts.length - 5} more)`}
                  </p>
                )}
              </div>
            )}
            {ghostPurgeResult && (
              <div className="border rounded-md p-2.5 mb-2 bg-emerald-50 text-xs">
                <p className="font-mono text-emerald-900">
                  Deleted <strong>{ghostPurgeResult.deleted}</strong> ghost bill(s)
                  {ghostPurgeResult.errors > 0 && <span className="text-rose-700"> · {ghostPurgeResult.errors} errors</span>}
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="border-t pt-4">
          <p className="text-sm font-semibold mb-1">Reconcile from Firestore</p>
          <p className="text-xs text-muted-foreground mb-3 max-w-xl">
            Pulls a fresh copy of every collection from Firestore, removes any
            replica rows for docs that no longer exist (e.g. bills you deleted
            on mobile), and rebuilds the admin aggregates from scratch. Costs
            a few hundred Firestore reads — only press if you suspect drift.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={handleReconcile}
              disabled={reconciling}
              variant="outline"
            >
              {reconciling
                ? <><Loader2 className="h-4 w-4 animate-spin" /> Reconciling…</>
                : <><RotateCw className="h-4 w-4" /> Reconcile now</>}
            </Button>
            {reconcileResult && (
              <span className="text-xs text-emerald-700 font-semibold inline-flex items-center gap-1">
                <CheckCircle2 className="h-3.5 w-3.5" /> {reconcileResult}
              </span>
            )}
            {reconcileError && (
              <span className="text-xs text-rose-700 font-semibold inline-flex items-center gap-1">
                <AlertCircle className="h-3.5 w-3.5" /> {reconcileError}
              </span>
            )}
          </div>
        </div>

        {/* --- Backfill lastModified on legacy portal_products --- */}
        <div className="border-t pt-4">
          <p className="text-sm font-semibold mb-1">Backfill <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">lastModified</code> on legacy products</p>
          <p className="text-xs text-muted-foreground mb-3 max-w-xl">
            Older portal_products written before <code className="font-mono text-[10px]">pushPortalDoc</code> auto-stamped
            timestamps are <strong>invisible</strong> to the live products
            subscription (which orders by <code className="font-mono text-[10px]">lastModified</code>). On any fresh
            device or cleared cache the portal can't see them, which can re-spawn
            phantoms via the slug-doc loop. Adding the field makes them visible
            and stops the loop at its second known source.
          </p>
          <div className="bg-amber-50 border border-amber-200 rounded-md px-3 py-2 text-xs text-amber-900 mb-3 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <span>
              Run this <strong>once</strong> after deploy. Idempotent — re-running won't double-process docs that already have the field. Cost: 1 read per product + 1 write per legacy doc that needed the backfill.
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={handleBackfillLastModified}
              disabled={backfilling}
              variant="outline"
            >
              {backfilling
                ? <><Loader2 className="h-4 w-4 animate-spin" /> Backfilling…</>
                : <><RotateCw className="h-4 w-4" /> Backfill lastModified</>}
            </Button>
            {backfillResult && (
              <span className="text-xs text-emerald-700 font-semibold inline-flex items-center gap-1">
                <CheckCircle2 className="h-3.5 w-3.5" /> {backfillResult}
              </span>
            )}
            {backfillError && (
              <span className="text-xs text-rose-700 font-semibold inline-flex items-center gap-1">
                <AlertCircle className="h-3.5 w-3.5" /> {backfillError}
              </span>
            )}
          </div>
        </div>

        {/* --- Backfill updatedAt on legacy customers/products (mobile autocomplete fix) --- */}
        <div className="border-t pt-4">
          <p className="text-sm font-semibold mb-1">Backfill <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">updatedAt</code> on legacy customers &amp; products</p>
          <p className="text-xs text-muted-foreground mb-3 max-w-xl">
            The worker syncs the legacy <code className="font-mono text-[10px]">customers</code> and <code className="font-mono text-[10px]">products</code> name registries to Supabase
            using the <code className="font-mono text-[10px]">updatedAt</code> cursor (an ISO string stamped by every writer).
            Docs created before that auto-stamping was added are <strong>invisible</strong> to the incremental cron
            and never reach Supabase — which means mobile autocomplete doesn't show them via Realtime.
            This one-shot stamps <code className="font-mono text-[10px]">updatedAt</code> on every doc that's missing it.
          </p>
          <div className="bg-amber-50 border border-amber-200 rounded-md px-3 py-2 text-xs text-amber-900 mb-3 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <span>
              Run this <strong>once</strong> after deploying the synced-collections change. Idempotent — re-running
              is a no-op for already-stamped docs. Cost: 1 read per customer/product + 1 write per legacy doc that needed the backfill.
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={handleBackfillLegacyUpdatedAt}
              disabled={legacyBackfilling}
              variant="outline"
            >
              {legacyBackfilling
                ? <><Loader2 className="h-4 w-4 animate-spin" /> Backfilling…</>
                : <><RotateCw className="h-4 w-4" /> Backfill legacy updatedAt</>}
            </Button>
            {legacyBackfillResult && (
              <span className="text-xs text-emerald-700 font-semibold inline-flex items-center gap-1">
                <CheckCircle2 className="h-3.5 w-3.5" /> {legacyBackfillResult}
              </span>
            )}
            {legacyBackfillError && (
              <span className="text-xs text-rose-700 font-semibold inline-flex items-center gap-1">
                <AlertCircle className="h-3.5 w-3.5" /> {legacyBackfillError}
              </span>
            )}
          </div>
        </div>

        {/* --- Migrate bills_ack meta into bills (one-shot) --- */}
        <div className="border-t pt-4">
          <p className="text-sm font-semibold mb-1">Migrate <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">portal_bills_meta</code> into bill docs</p>
          <p className="text-xs text-muted-foreground mb-3 max-w-xl">
            Older portal versions stored each bill's <code className="font-mono text-[10px]">acknowledged</code> /
            <code className="font-mono text-[10px]">acknowledgedAt</code> in a separate collection
            (<code className="font-mono text-[10px]">portal_bills_meta/&lt;billId&gt;</code>). That collection grows forever and is
            re-read on every cold load. Bundling those fields into the bill doc itself eliminates the
            subscription entirely &mdash; <strong>~150&ndash;500 reads saved per cold load, permanently.</strong>
          </p>
          <div className="bg-amber-50 border border-amber-200 rounded-md px-3 py-2 text-xs text-amber-900 mb-3 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <span>
              Run this <strong>once</strong> after the new code is deployed. Idempotent &mdash; re-running just re-merges the same fields. After it completes, a follow-up deploy can safely remove the <code className="font-mono text-[10px]">portal_bills_meta</code> live subscription from <code className="font-mono text-[10px]">firestoreSync.ts</code>.
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={handleMigrateAckMeta}
              disabled={migratingAck || purgingMeta}
              variant="outline"
            >
              {migratingAck
                ? <><Loader2 className="h-4 w-4 animate-spin" /> Migrating ack data&hellip;</>
                : <><RotateCw className="h-4 w-4" /> 1. Migrate ack data to bills</>}
            </Button>
            <Button
              onClick={handlePurgeMeta}
              disabled={migratingAck || purgingMeta}
              variant="destructive"
            >
              {purgingMeta
                ? <><Loader2 className="h-4 w-4 animate-spin" /> Purging&hellip;</>
                : <>2. Purge portal_bills_meta</>}
            </Button>
            {migrateAckResult && (
              <span className="text-xs text-emerald-700 font-semibold inline-flex items-center gap-1">
                <CheckCircle2 className="h-3.5 w-3.5" /> {migrateAckResult}
              </span>
            )}
            {migrateAckError && (
              <span className="text-xs text-rose-700 font-semibold inline-flex items-center gap-1">
                <AlertCircle className="h-3.5 w-3.5" /> {migrateAckError}
              </span>
            )}
            {purgeMetaResult && (
              <span className="text-xs text-emerald-700 font-semibold inline-flex items-center gap-1">
                <CheckCircle2 className="h-3.5 w-3.5" /> {purgeMetaResult}
              </span>
            )}
            {purgeMetaError && (
              <span className="text-xs text-rose-700 font-semibold inline-flex items-center gap-1">
                <AlertCircle className="h-3.5 w-3.5" /> {purgeMetaError}
              </span>
            )}
          </div>
        </div>

        {/* --- Migrate payments into bills.payments[] (Deploy 5 Stage A) --- */}
        <div className="border-t pt-4">
          <p className="text-sm font-semibold mb-1">Migrate payments into bills.payments[]
            <span className="ml-1 text-[10px] bg-sky-100 text-sky-800 font-bold px-1.5 py-0.5 rounded uppercase">Deploy 5</span>
          </p>
          <p className="text-xs text-muted-foreground mb-3 max-w-xl">
            Reads every doc in the <code className="font-mono text-[10px]">payments</code> collection, groups by
            <code className="font-mono text-[10px] mx-0.5">billId</code>, and arrayUnion's them into the matching
            <code className="font-mono text-[10px] mx-0.5">bills/&lt;id&gt;.payments[]</code>. New payments from mobile
            are already dual-written; this backfills the historical ones.
            <strong> Idempotent</strong> — arrayUnion dedupes by deep equality, safe to re-run.
          </p>
          <div className="flex flex-wrap items-center gap-3 mb-2">
            <Button onClick={handleMigratePayments} disabled={migratingPayments} variant="outline">
              {migratingPayments
                ? <><Loader2 className="h-4 w-4 animate-spin" /> Migrating&hellip;</>
                : <><RotateCw className="h-4 w-4" /> Migrate payments into bills</>}
            </Button>
            {migratePaymentsError && (
              <span className="text-xs text-rose-700 font-semibold inline-flex items-center gap-1">
                <AlertCircle className="h-3.5 w-3.5" /> {migratePaymentsError}
              </span>
            )}
          </div>
          {migratePaymentsResult && (
            <div className="border rounded-md p-3 bg-emerald-50 text-xs">
              <p className="font-mono text-emerald-900">Scanned payments: <strong>{migratePaymentsResult.scannedPayments}</strong></p>
              <p className="font-mono text-emerald-900">Bills touched: <strong>{migratePaymentsResult.billsTouched}</strong></p>
              <p className="font-mono text-emerald-900">Payments backfilled into bills: <strong>{migratePaymentsResult.paymentsBackfilled}</strong></p>
              {migratePaymentsResult.orphans > 0 && (
                <>
                  <p className="font-mono text-amber-700">Orphan payments (billId has no bill doc): <strong>{migratePaymentsResult.orphans}</strong></p>
                  {migratePaymentsResult.sampleOrphans.length > 0 && (
                    <p className="font-mono text-amber-700/80 mt-1 break-all">
                      Sample orphan bill IDs: {migratePaymentsResult.sampleOrphans.join(', ')}
                    </p>
                  )}
                </>
              )}
              {migratePaymentsResult.errors > 0 && (
                <p className="font-mono text-rose-700">Errors: {migratePaymentsResult.errors}</p>
              )}
            </div>
          )}
        </div>

        {/* --- Consolidate products to slug-as-id (architectural fix) --- */}
        <div className="border-t pt-4">
          <p className="text-sm font-semibold mb-1">Consolidate products to productKey <span className="ml-1 text-[10px] bg-emerald-100 text-emerald-800 font-bold px-1.5 py-0.5 rounded uppercase">Root fix</span></p>
          <p className="text-xs text-muted-foreground mb-3 max-w-xl">
            Re-keys every <code className="font-mono text-[10px]">portal_products</code> doc so its id IS the
            <code className="font-mono text-[10px] mx-0.5">productKey(name)</code> (SHA-256 hex of normalized name).
            Groups duplicates by computed key, keeps the most-enriched doc per group, deletes the rest.
            <strong> After this runs, phantom duplicate products are physically impossible</strong> — two writes
            for the same name resolve to the same doc id (setDoc with merge = idempotent no-op).
          </p>
          <div className="bg-amber-50 border border-amber-200 rounded-md px-3 py-2 text-xs text-amber-900 mb-3 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <span>
              Run this <strong>once</strong> on each environment (non-prod first, then prod). Idempotent — safe to re-run.
              Costs ~1 read per product + 1 write per kept doc + 1 delete per duplicate.
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3 mb-2">
            <Button
              onClick={handleConsolidate}
              disabled={consolidating}
              variant="outline"
            >
              {consolidating
                ? <><Loader2 className="h-4 w-4 animate-spin" /> Consolidating&hellip;</>
                : <><RotateCw className="h-4 w-4" /> Consolidate to productKey</>}
            </Button>
            {consolidateError && (
              <span className="text-xs text-rose-700 font-semibold inline-flex items-center gap-1">
                <AlertCircle className="h-3.5 w-3.5" /> {consolidateError}
              </span>
            )}
          </div>
          {consolidateResult && (
            <div className="border rounded-md p-3 bg-emerald-50 text-xs">
              <p className="font-bold mb-2 text-emerald-900">Consolidation complete</p>
              <p className="font-mono text-emerald-900">Scanned: <strong>{consolidateResult.scanned}</strong></p>
              <p className="font-mono text-emerald-900">Groups consolidated: <strong>{consolidateResult.groupsConsolidated}</strong></p>
              <p className="font-mono text-emerald-900">Docs written: <strong>{consolidateResult.docsWritten}</strong></p>
              <p className="font-mono text-emerald-900">Docs deleted (duplicates): <strong>{consolidateResult.docsDeleted}</strong></p>
              {consolidateResult.errors > 0 && (
                <p className="font-mono text-rose-700">Errors: {consolidateResult.errors}</p>
              )}
              {consolidateResult.examples.length > 0 && (
                <>
                  <p className="font-bold text-[10px] uppercase tracking-wide mt-2 mb-1 text-emerald-900">Examples</p>
                  <ul className="ml-2 list-disc font-mono text-emerald-900/80">
                    {consolidateResult.examples.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </>
              )}
              <p className="mt-2 text-emerald-800">
                Phantom-duplicate products are now physically impossible. The disable-auto-create flag and
                fallback scan code can be safely removed in a follow-up.
              </p>
            </div>
          )}
        </div>

        {/* --- Phantom-creation safety toggle --- */}
        <div className="border-t pt-4">
          <p className="text-sm font-semibold mb-1">Auto-create product drafts from Baniya</p>
          <p className="text-xs text-muted-foreground mb-3 max-w-xl">
            When ON (default), product names that appear in mobile bills auto-create
            <code className="font-mono text-[10px] mx-0.5">portal_products</code> drafts you can then enrich.
            <strong> Turn OFF temporarily</strong> if you're recovering from phantom-duplicate spam:
            disable → run "Backfill nameLower" + "Backfill lastModified" → run Catalog Cleanup → turn back ON.
          </p>
          <div className="flex items-center gap-3">
            <Button
              variant={isEnsureProductsEnabled() ? 'destructive' : 'outline'}
              size="sm"
              onClick={() => {
                const next = !isEnsureProductsEnabled();
                setEnsureProductsEnabled(next);
                window.location.reload();
              }}
            >
              {isEnsureProductsEnabled() ? 'Disable auto-create' : 'Enable auto-create'}
            </Button>
            <span className={`text-xs font-semibold ${isEnsureProductsEnabled() ? 'text-emerald-700' : 'text-amber-700'}`}>
              Currently: {isEnsureProductsEnabled() ? 'ENABLED' : 'DISABLED'}
            </span>
          </div>
        </div>

        {/* --- Catalog cleanup (dedupe phantom drafts) --- */}
        <div className="border-t pt-4">
          <p className="text-sm font-semibold mb-1">Catalog cleanup — remove duplicate product drafts</p>
          <p className="text-xs text-muted-foreground mb-3 max-w-xl">
            Scans every product in the catalog and groups them by name (case- and whitespace-insensitive).
            For any group with 2+ entries, keeps the most-enriched copy (description, prices, images, labels)
            and lists the rest for deletion. Removes them from Firestore <strong>plus the matching
            <code className="font-mono text-[10px] mx-0.5">products/&lt;slug&gt;</code> docs</strong> so the
            loop that re-spawns the same phantoms on cold portal loads is permanently broken. Triggers a
            Supabase reconcile to keep the replica in sync.
          </p>
          <div className="bg-amber-50 border border-amber-200 rounded-md px-3 py-2 text-xs text-amber-900 mb-3 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <span>
              <strong>Only run this on a portal version that has the phantom-creation fix.</strong>
              Otherwise the loop will recreate duplicates faster than you can delete them.
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3 mb-3">
            <Button
              onClick={handleScan}
              disabled={scanState === 'scanning' || scanState === 'deleting'}
              variant="outline"
            >
              {scanState === 'scanning'
                ? <><Loader2 className="h-4 w-4 animate-spin" /> Scanning…</>
                : <><RotateCw className="h-4 w-4" /> Scan for duplicates</>}
            </Button>
            {scanState === 'scanned' && phantoms.length > 0 && (
              <Button
                onClick={handleDelete}
                disabled={scanState !== 'scanned'}
                className="bg-rose-600 hover:bg-rose-700 text-white"
              >
                <Trash2 className="h-4 w-4" /> Delete {phantoms.length} duplicate{phantoms.length === 1 ? '' : 's'}
              </Button>
            )}
            {scanProgress && (
              <span className="text-xs text-muted-foreground">{scanProgress}</span>
            )}
            {scanState === 'deleting' && (
              <span className="text-xs text-blue-700 font-semibold inline-flex items-center gap-1">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Deleting {deleteProgress.done} / {deleteProgress.total}
              </span>
            )}
            {scanError && (
              <span className="text-xs text-rose-700 font-semibold inline-flex items-center gap-1">
                <AlertCircle className="h-3.5 w-3.5" /> {scanError}
              </span>
            )}
            {deleteResult && (
              <span className="text-xs text-emerald-700 font-semibold inline-flex items-center gap-1">
                <CheckCircle2 className="h-3.5 w-3.5" /> {deleteResult}
              </span>
            )}
          </div>

          {scanState === 'scanned' && phantoms.length === 0 && (
            <p className="text-xs text-emerald-700 font-semibold inline-flex items-center gap-1">
              <CheckCircle2 className="h-3.5 w-3.5" /> No duplicate drafts found. Catalog is clean.
            </p>
          )}

          {phantoms.length > 0 && (
            <div className="border rounded-md overflow-hidden">
              <div className="bg-slate-50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center justify-between">
                <span>Duplicates to delete ({phantoms.length})</span>
                <span className="font-mono">keeper kept · twins removed</span>
              </div>
              <div className="max-h-72 overflow-auto text-xs">
                <table className="w-full">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b">
                      <th className="px-3 py-1.5 font-semibold">Name</th>
                      <th className="px-3 py-1.5 font-semibold font-mono">Phantom ID</th>
                      <th className="px-3 py-1.5 font-semibold font-mono">Keeper ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {phantoms.map(p => (
                      <tr key={p.id} className="border-b last:border-b-0 hover:bg-slate-50">
                        <td className="px-3 py-1.5">{p.name}</td>
                        <td className="px-3 py-1.5 font-mono text-[10.5px] text-rose-700">{p.id}</td>
                        <td className="px-3 py-1.5 font-mono text-[10.5px] text-emerald-700">{p.twinIds[0]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export default AdminSettings;
