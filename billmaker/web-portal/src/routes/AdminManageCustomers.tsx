import React, { useState, useEffect, useMemo } from 'react';
import { usePagination } from '../hooks/usePagination';

const PAGE_SIZE = 30;
import { Users, Link2, Unlink, AlertCircle, Search, Check, CloudOff, ChevronDown, Loader2 } from 'lucide-react';
import { Link as RouterLink } from 'react-router-dom';
import { store, onStoreChange, linkRawCustomers, createCanonicalFromRaw, unlinkRawCustomer, getActiveClassCodes, classDisplayName } from '../data/dummyData';
import { getSyncStatus, onSyncStatusChange, SyncStatus } from '../lib/firestoreSync';
import { CustomerClass } from '../types';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter,
} from '../components/ui/dialog';

const AdminManageCustomers: React.FC = () => {
  const [, force] = useState(0);
  const [sync, setSync] = useState<SyncStatus>(getSyncStatus());
  useEffect(() => onStoreChange(() => force(n => n + 1)), []);
  useEffect(() => onSyncStatusChange(setSync), []);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [showMerge, setShowMerge] = useState(false);

  const [canonicalName, setCanonicalName] = useState('');
  const [linkMode, setLinkMode] = useState<'new' | 'existing'>('new');
  const [linkExistingId, setLinkExistingId] = useState('');
  const [linkClass, setLinkClass] = useState<CustomerClass>('C');

  const filteredRaw = useMemo(() => {
    const list = store.rawCustomers.slice().sort((a, b) => {
      if (!a.linkedCustomerId && b.linkedCustomerId) return -1;
      if (a.linkedCustomerId && !b.linkedCustomerId) return 1;
      return a.rawName.toLowerCase().localeCompare(b.rawName.toLowerCase());
    });
    const s = search.trim().toLowerCase();
    return s ? list.filter(r => r.rawName.toLowerCase().includes(s)) : list;
  }, [search, store.rawCustomers.length, store.rawCustomers.map(r => r.linkedCustomerId).join(',')]); // eslint-disable-line

  const pager = usePagination(filteredRaw, {
    pageSize: PAGE_SIZE,
    resetKey: `${search}|${filteredRaw.length}`,
  });

  const toggleSelect = (name: string) => {
    // Defensive: never let an already-linked name slip into the selection set.
    const raw = store.rawCustomers.find(r => r.rawName === name);
    if (raw?.linkedCustomerId) return;
    setSelected(prev => {
      const n = new Set(prev);
      n.has(name) ? n.delete(name) : n.add(name);
      return n;
    });
  };

  const handleUnlink = (e: React.MouseEvent, rawName: string) => {
    e.stopPropagation();
    if (!window.confirm(`Unlink "${rawName}"? It'll show up as an unlinked raw name again so you can re-group it.`)) return;
    unlinkRawCustomer(rawName);
    setSelected(prev => {
      const n = new Set(prev);
      n.delete(rawName);
      return n;
    });
  };

  const startMerge = () => {
    const firstSelected = Array.from(selected)[0];
    setCanonicalName(firstSelected || '');
    setLinkMode('new');
    setLinkExistingId('');
    setLinkClass('C');
    setShowMerge(true);
  };

  const performMerge = () => {
    // Strip any already-linked names that somehow leaked in.
    const names = Array.from(selected).filter(n => {
      const r = store.rawCustomers.find(r => r.rawName === n);
      return r && !r.linkedCustomerId;
    });
    if (names.length === 0) {
      setShowMerge(false);
      return;
    }
    if (linkMode === 'new') {
      if (!canonicalName.trim()) return;
      createCanonicalFromRaw(names, canonicalName.trim(), linkClass);
    } else {
      if (!linkExistingId) return;
      const existing = store.customers.find(c => c.id === linkExistingId);
      if (!existing) return;
      linkRawCustomers(names, linkExistingId, existing.name);
    }
    setSelected(new Set());
    setShowMerge(false);
  };

  const unlinkedCount = store.rawCustomers.filter(r => !r.linkedCustomerId).length;

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight flex items-center gap-2">
          <Users className="h-7 w-7 text-secondary" /> Manage Customers
        </h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
          Customer names from <strong>BillMaker mobile</strong> bills appear here as raw entries.
          Duplicates like <em>"Raj"</em>, <em>"raj sharma"</em>, <em>"RAJ SHARMA"</em> can be grouped under one canonical
          customer so they show up unified across all bills.
        </p>
      </header>

      {!sync.initialized ? (
        <Card className="mb-4 border-amber-200 bg-amber-50">
          <CardContent className="p-4 flex items-start gap-3">
            <CloudOff className="h-5 w-5 text-amber-700 flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-bold text-amber-900">Firestore not configured</p>
              <p className="text-xs text-amber-800 mt-0.5">
                Customer names will appear here automatically once you set Firebase credentials + Shop Code in{' '}
                <RouterLink to="/admin/settings" className="underline font-semibold">Settings</RouterLink>.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : store.rawCustomers.length === 0 ? (
        <Card className="mb-4 border-sky-200 bg-sky-50">
          <CardContent className="p-4 flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-sky-700 flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-bold text-sky-900">Waiting for bills…</p>
              <p className="text-xs text-sky-800 mt-0.5">
                Connected to <span className="font-mono">{sync.projectId}</span> · shop{' '}
                <span className="font-mono">{sync.shopCode}</span>. No bills found yet — once BillMaker writes any bill,
                its customer name will show up here. Check the{' '}
                <RouterLink to="/admin/logs" className="underline font-semibold">Logs</RouterLink> tab for live sync status.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="mb-4 border-sky-200 bg-sky-50">
          <CardContent className="p-4 flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-sky-700 flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-bold text-sky-900">
                {unlinkedCount} unlinked raw name{unlinkedCount === 1 ? '' : 's'}
                {store.rawCustomers.length !== unlinkedCount && ` · ${store.rawCustomers.length - unlinkedCount} already linked`}
              </p>
              <p className="text-xs text-sky-800 mt-0.5">
                Pulled from <strong>{store.bills.length} bill{store.bills.length === 1 ? '' : 's'}</strong> in shop{' '}
                <span className="font-mono">{sync.shopCode}</span>. Names that already match a canonical customer were auto-linked.
                Select 2+ to merge variations under one customer.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <div className="p-3 sm:p-4 border-b flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search raw names…" className="pl-9" />
          </div>
          {selected.size > 0 && (
            <Button onClick={startMerge} variant="default">
              <Link2 className="h-4 w-4" /> Merge {selected.size} selected →
            </Button>
          )}
        </div>

        <div className="divide-y">
          {filteredRaw.length === 0 ? (
            <div className="p-12 text-center text-sm text-muted-foreground">No raw customers match.</div>
          ) : pager.page.map(r => {
            const linked = r.linkedCustomerId
              ? store.customers.find(c => c.id === r.linkedCustomerId)
              : null;
            const isSelected = selected.has(r.rawName);
            return (
              <div
                key={r.rawName}
                onClick={() => !linked && toggleSelect(r.rawName)}
                className={`px-4 py-3 flex items-center gap-3 transition ${
                  linked
                    ? 'bg-emerald-50/40 cursor-default'
                    : 'cursor-pointer hover:bg-muted/40'
                } ${isSelected ? 'bg-sky-50' : ''}`}
              >
                {linked ? (
                  <div className="w-5 h-5 rounded-md bg-emerald-100 border border-emerald-200 flex items-center justify-center flex-shrink-0" title="Already linked — use the Unlink button to free this name">
                    <Link2 className="h-3 w-3 text-emerald-700" />
                  </div>
                ) : (
                  <div className={`w-5 h-5 rounded-md flex items-center justify-center transition flex-shrink-0 ${
                    isSelected ? 'bg-primary border-primary text-primary-foreground' : 'bg-background border border-input'
                  }`}>
                    {isSelected && <Check className="h-3.5 w-3.5" />}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className={`font-semibold truncate ${linked ? 'text-slate-700' : ''}`}>{r.rawName}</p>
                  <p className="text-xs text-muted-foreground">
                    {r.billCount} bill{r.billCount === 1 ? '' : 's'}
                    {linked && (
                      <span className="ml-2 text-emerald-700">
                        → linked to <strong>{linked.name}</strong>
                      </span>
                    )}
                  </p>
                </div>
                {linked ? (
                  <>
                    <Badge variant="success" className="flex-shrink-0">Linked</Badge>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={e => handleUnlink(e, r.rawName)}
                      className="text-rose-600 hover:bg-rose-50 hover:text-rose-700 flex-shrink-0"
                    >
                      <Unlink className="h-3.5 w-3.5" /> Unlink
                    </Button>
                  </>
                ) : null}
              </div>
            );
          })}

          {/* Skeleton rows while loading next page */}
          {pager.loadingMore && Array.from({ length: pager.skeletonCount }, (_, i) => (
            <div key={`sk-${i}`} className="px-4 py-3 flex items-center gap-3 animate-pulse">
              <div className="w-5 h-5 rounded-md bg-slate-200 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="h-4 w-44 bg-slate-200 rounded mb-1.5" />
                <div className="h-3 w-24 bg-slate-100 rounded" />
              </div>
              <div className="h-5 w-14 bg-slate-200 rounded-full flex-shrink-0" />
            </div>
          ))}
        </div>

        {pager.hasMore && (
          <div className="border-t bg-muted/20 flex items-center justify-center py-3 px-4 gap-3 text-xs text-muted-foreground">
            <span>Showing {pager.showing} of {pager.total}</span>
            <Button variant="outline" size="sm" onClick={pager.loadMore} disabled={pager.loadingMore}>
              {pager.loadingMore
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</>
                : <><ChevronDown className="h-3.5 w-3.5" /> Load more</>}
            </Button>
          </div>
        )}
      </Card>

      {/* Sentinel for auto-load when user scrolls near the bottom */}
      {pager.hasMore && <div ref={pager.sentinelRef} aria-hidden className="h-1" />}

      <Dialog open={showMerge} onOpenChange={o => { if (!o) setShowMerge(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Merge {selected.size} customer{selected.size === 1 ? '' : 's'}</DialogTitle>
            <DialogDescription>
              All future bills mentioning these names will be unified under one canonical customer record.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="bg-muted/30 rounded-lg p-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Selected raw names</p>
              <div className="flex flex-wrap gap-1.5">
                {Array.from(selected).map(n => (
                  <span key={n} className="text-xs font-semibold px-2 py-1 rounded bg-background border">
                    {n}
                  </span>
                ))}
              </div>
            </div>

            <div className="flex gap-1 bg-muted rounded-lg p-1">
              <button
                type="button"
                onClick={() => setLinkMode('new')}
                className={`flex-1 py-2 text-xs font-semibold rounded-md transition ${
                  linkMode === 'new' ? 'bg-background text-primary shadow' : 'text-muted-foreground'
                }`}
              >
                Create new customer
              </button>
              <button
                type="button"
                onClick={() => setLinkMode('existing')}
                className={`flex-1 py-2 text-xs font-semibold rounded-md transition ${
                  linkMode === 'existing' ? 'bg-background text-primary shadow' : 'text-muted-foreground'
                }`}
              >
                Link to existing
              </button>
            </div>

            {linkMode === 'new' ? (
              <>
                <div>
                  <label className="text-xs font-semibold uppercase tracking-wider mb-1.5 block">Canonical name</label>
                  <Input value={canonicalName} onChange={e => setCanonicalName(e.target.value)} placeholder="e.g. Raj Sharma" required />
                  <p className="text-[11px] text-muted-foreground mt-1">
                    All matching bills will be rewritten to use this name.
                  </p>
                </div>
                <div>
                  <label className="text-xs font-semibold uppercase tracking-wider mb-1.5 block">Initial class</label>
                  <select
                    value={linkClass}
                    onChange={e => setLinkClass(e.target.value as CustomerClass)}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm"
                  >
                    {getActiveClassCodes().map(code => (
                      <option key={code} value={code}>Class {code} — {classDisplayName(code)}</option>
                    ))}
                  </select>
                </div>
              </>
            ) : (
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider mb-1.5 block">Existing customer</label>
                <select
                  value={linkExistingId}
                  onChange={e => setLinkExistingId(e.target.value)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm"
                >
                  <option value="">— Select customer —</option>
                  {store.customers.map(c => (
                    <option key={c.id} value={c.id}>{c.name} · Class {c.class}</option>
                  ))}
                </select>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Bills will be rewritten under the selected customer's name. Existing aliases are preserved.
                </p>
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setShowMerge(false)}>Cancel</Button>
            <Button
              type="button"
              onClick={performMerge}
              disabled={linkMode === 'new' ? !canonicalName.trim() : !linkExistingId}
            >
              Merge {selected.size}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AdminManageCustomers;
