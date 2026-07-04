import React, { useState, useEffect, useMemo } from 'react';
import { UserPlus, Pencil, Search, ArrowUpDown, ArrowUp, ArrowDown, Archive, Undo2, Trash2, ChevronDown, Loader2 } from 'lucide-react';
import { usePagination } from '../hooks/usePagination';

const PAGE_SIZE = 20;
import {
  store,
  updateCustomerClass,
  onStoreChange,
  fmtINR,
  classDisplayName,
  classBadgeClasses,
  getActiveClassCodes,
  restoreCustomer,
  purgeArchivedCustomer,
} from '../data/dummyData';
import { useAdminAggregates } from '../lib/adminAggregates';
import { InlineSkeleton } from '../components/client/Skeletons';
import { ALL_CLASS_CODES } from '../types';
import { Customer, CustomerClass } from '../types';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter,
} from '../components/ui/dialog';
import CustomerModal from '../components/modals/CustomerModal';

type SortKey = 'name' | 'class' | 'createdAt' | 'outstanding';
type SortDir = 'asc' | 'desc';

const AdminCustomers: React.FC = () => {
  const [, force] = useState(0);
  useEffect(() => onStoreChange(() => force(n => n + 1)), []);
  const [modal, setModal] = useState<{ mode: 'add' | 'edit'; customer?: Customer } | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const handleRestore = (customerId: string, name: string) => {
    const ok = restoreCustomer(customerId);
    if (ok) showToast(`Restored "${name}".`);
    else showToast(`Could not restore "${name}" — a customer with that name already exists.`);
  };

  const handlePurge = (customerId: string, name: string) => {
    if (!window.confirm(`Permanently delete archived "${name}" and all its bills? This cannot be undone.`)) return;
    if (purgeArchivedCustomer(customerId)) showToast(`Permanently deleted "${name}".`);
  };

  // Per-customer outstanding has two sources:
  //   1. customer.outstanding on the portal_customer doc itself — written by
  //      the worker after every aggregate recompute (Deploy 3). When present,
  //      we render it immediately (no skeleton) even if the aggregate doc
  //      hasn't loaded yet.
  //   2. agg.perCustomerOutstanding from the admin_aggregates doc — used as a
  //      fallback for customers whose .outstanding hasn't been backfilled yet
  //      (e.g. a fresh customer added since the last cron run).
  const { value: agg, loaded: aggLoaded } = useAdminAggregates();
  const aggReady = aggLoaded && agg !== null;
  const outstandingByCustomer = useMemo(() => {
    const m = new Map<string, number>();
    if (agg) {
      for (const [key, entry] of Object.entries(agg.perCustomerOutstanding)) {
        m.set(key, entry.outstanding);
      }
    }
    return m;
  }, [agg]); // eslint-disable-line

  const resolveOutstanding = (c: typeof store.customers[number]): { value: number; ready: boolean } => {
    // Trust customer.outstanding only when the worker has stamped
    // lastOutstandingUpdate. Without that timestamp, the field is just the
    // schema default (0) from Normalize, not a real worker recompute.
    if (typeof c.outstanding === 'number' && c.lastOutstandingUpdate) {
      return { value: c.outstanding, ready: true };
    }
    if (aggReady) {
      return { value: outstandingByCustomer.get(c.id) || outstandingByCustomer.get(c.name) || 0, ready: true };
    }
    return { value: 0, ready: false };
  };

  const visibleCustomers = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = store.customers.slice();
    if (q) {
      list = list.filter(c =>
        c.name.toLowerCase().includes(q) ||
        (c.phone || '').toLowerCase().includes(q) ||
        (c.gstNumber || '').toLowerCase().includes(q) ||
        (c.email || '').toLowerCase().includes(q),
      );
    }
    const classOrder = Object.fromEntries(ALL_CLASS_CODES.map((c, i) => [c, i])) as Record<CustomerClass, number>;
    const dir = sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'name') cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      else if (sortKey === 'class') cmp = classOrder[a.class] - classOrder[b.class];
      else if (sortKey === 'createdAt') cmp = a.createdAt.localeCompare(b.createdAt);
      else if (sortKey === 'outstanding') {
        const oa = resolveOutstanding(a).value;
        const ob = resolveOutstanding(b).value;
        cmp = oa - ob;
      }
      return cmp * dir;
    });
    return list;
  }, [search, sortKey, sortDir, store.customers.length, store.customers.map(c => c.name + c.class).join('|'), outstandingByCustomer]); // eslint-disable-line

  const pager = usePagination(visibleCustomers, {
    pageSize: PAGE_SIZE,
    resetKey: `${search}|${sortKey}|${sortDir}|${visibleCustomers.length}`,
    loadDelayMs: 0,
  });

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const sortIcon = (key: SortKey) => {
    if (sortKey !== key) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
    return sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Customers</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage who can log into the client portal and which pricing class they get.
          </p>
        </div>
        <div className="flex gap-2">
          {store.archive.length > 0 && (
            <Button variant="outline" onClick={() => setArchiveOpen(true)}>
              <Archive className="h-4 w-4" /> Archive ({store.archive.length})
            </Button>
          )}
          <Button onClick={() => setModal({ mode: 'add' })}>
            <UserPlus className="h-4 w-4" /> Add customer
          </Button>
        </div>
      </header>

      {/* Class summary cards — one per active class, colors driven from classDefs */}
      <div className={`grid gap-2 sm:gap-3 mb-4 ${
        store.classDefs.length <= 3 ? 'grid-cols-3' : store.classDefs.length === 4 ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-2 sm:grid-cols-5'
      }`}>
        {getActiveClassCodes().map(cls => {
          const count = store.customers.filter(c => c.class === cls).length;
          return (
            <Card key={cls} className={`border ${classBadgeClasses(cls)}`}>
              <CardContent className="p-3 sm:p-4">
                <p className="text-[10px] uppercase tracking-widest font-bold opacity-70">Class {cls}</p>
                <p className="text-2xl sm:text-3xl font-bold mt-1">{count}</p>
                <p className="text-xs opacity-70 truncate">{classDisplayName(cls)} · {count === 1 ? 'customer' : 'customers'}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Search */}
      <div className="relative mb-3">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by name, phone, GST, email…"
          className="pl-9"
        />
      </div>

      {/* Desktop table */}
      <Card className="hidden md:block overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 border-b">
              <tr className="text-left text-[10px] uppercase tracking-widest text-muted-foreground">
                <SortableTh label="Name" onClick={() => toggleSort('name')} icon={sortIcon('name')} className="px-5 py-3" />
                <th className="px-3 py-3 font-bold">Contact</th>
                <th className="px-3 py-3 font-bold">GST</th>
                <SortableTh label="Class" onClick={() => toggleSort('class')} icon={sortIcon('class')} className="px-3 py-3" />
                <SortableTh label="Joined" onClick={() => toggleSort('createdAt')} icon={sortIcon('createdAt')} className="px-3 py-3" />
                <SortableTh label="Outstanding" onClick={() => toggleSort('outstanding')} icon={sortIcon('outstanding')} className="px-3 py-3" align="right" />
                <th className="px-5 py-3 font-bold w-20"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {visibleCustomers.length === 0 ? (
                <tr><td colSpan={7} className="px-5 py-12 text-center text-muted-foreground">
                  {store.customers.length === 0 ? 'No customers yet.' : 'No customers match your search.'}
                </td></tr>
              ) : pager.page.map(c => {
                const { value: outstanding, ready: outstandingReady } = resolveOutstanding(c);
                return (
                  <tr key={c.id} className="hover:bg-muted/40 transition">
                    <td className="px-5 py-3">
                      <p className="font-semibold">{c.name}</p>
                      <p className="text-xs text-muted-foreground">Since {new Date(c.createdAt).toLocaleDateString()}</p>
                    </td>
                    <td className="px-3 py-3">
                      <p>{c.phone || <span className="text-muted-foreground italic">—</span>}</p>
                      {c.email && <p className="text-xs text-muted-foreground">{c.email}</p>}
                    </td>
                    <td className="px-3 py-3 text-xs font-mono">
                      {c.gstNumber || <span className="text-muted-foreground italic">—</span>}
                    </td>
                    <td className="px-3 py-3">
                      <select
                        value={c.class}
                        onChange={e => updateCustomerClass(c.id, e.target.value as CustomerClass)}
                        className={`text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full border cursor-pointer ${classBadgeClasses(c.class)}`}
                      >
                        {getActiveClassCodes().map(code => (
                          <option key={code} value={code}>{`Class ${code} — ${classDisplayName(code)}`}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">
                      {new Date(c.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-3 text-right">
                      {outstandingReady ? (
                        <span className={`font-bold ${outstanding > 0 ? 'text-rose-600' : 'text-muted-foreground'}`}>
                          {fmtINR(outstanding)}
                        </span>
                      ) : (
                        <InlineSkeleton width="4em" />
                      )}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <Button variant="ghost" size="sm" onClick={() => setModal({ mode: 'edit', customer: c })}>
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </Button>
                    </td>
                  </tr>
                );
              })}
              {pager.loadingMore && Array.from({ length: pager.skeletonCount }, (_, i) => (
                <CustomerRowSkeleton key={`sk-${i}`} />
              ))}
            </tbody>
          </table>
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

      {/* Mobile cards */}
      <div className="md:hidden space-y-3">
        {visibleCustomers.length === 0 && (
          <Card className="p-8 text-center text-sm text-muted-foreground">
            {store.customers.length === 0 ? 'No customers yet.' : 'No customers match your search.'}
          </Card>
        )}
        {pager.page.map(c => {
          const { value: outstanding, ready: outstandingReady } = resolveOutstanding(c);
          return (
            <Card key={c.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold truncate">{c.name}</p>
                    <p className="text-xs text-muted-foreground">{c.phone}</p>
                    {c.gstNumber && <p className="text-xs font-mono text-muted-foreground">GST: {c.gstNumber}</p>}
                  </div>
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full border ${classBadgeClasses(c.class)}`}>
                    Class {c.class}
                  </span>
                </div>
                <div className="flex items-center justify-between pt-3 border-t">
                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold">Outstanding</p>
                    {outstandingReady ? (
                      <p className={`font-bold text-sm ${outstanding > 0 ? 'text-rose-600' : 'text-muted-foreground'}`}>
                        {fmtINR(outstanding)}
                      </p>
                    ) : (
                      <p className="font-bold text-sm"><InlineSkeleton width="4em" /></p>
                    )}
                  </div>
                  <Button variant="outline" size="sm" onClick={() => setModal({ mode: 'edit', customer: c })}>
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
        {pager.loadingMore && Array.from({ length: pager.skeletonCount }, (_, i) => (
          <CustomerCardSkeleton key={`sk-${i}`} />
        ))}
        {pager.hasMore && (
          <div className="flex items-center justify-center py-3 gap-3 text-xs text-muted-foreground">
            <span>Showing {pager.showing} of {pager.total}</span>
            <Button variant="outline" size="sm" onClick={pager.loadMore} disabled={pager.loadingMore}>
              {pager.loadingMore
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</>
                : <><ChevronDown className="h-3.5 w-3.5" /> Load more</>}
            </Button>
          </div>
        )}
      </div>

      {/* Single sentinel after both view variants. IntersectionObserver fires
          loadMore() when the user scrolls to the bottom — works for both the
          desktop table and the mobile card list. */}
      {pager.hasMore && <div ref={pager.sentinelRef} aria-hidden className="h-1" />}

      {/* Always-mounted: Radix Dialog handles open/close transitions cleanly
          via the `open` prop. Unmounting it via `{modal && …}` while still
          open could leave the overlay visible and the form stuck. */}
      <CustomerModal
        mode={modal?.mode || 'add'}
        customer={modal?.customer}
        open={!!modal}
        onClose={() => setModal(null)}
      />

      {/* Archive viewer — list of soft-deleted customers, each with restore / purge actions */}
      <Dialog open={archiveOpen} onOpenChange={o => { if (!o) setArchiveOpen(false); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Archive className="h-5 w-5 text-muted-foreground" /> Archived customers
            </DialogTitle>
            <DialogDescription>
              Soft-deleted customers and their bills, kept here for recovery. <strong>Restore</strong> brings the customer +
              bills back into the active store. <strong>Purge</strong> removes them permanently.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {store.archive.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                Archive is empty.
              </div>
            ) : (
              <div className="border rounded-lg divide-y max-h-[60vh] overflow-y-auto">
                {store.archive
                  .slice()
                  .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt))
                  .map(entry => (
                    <div key={entry.customer.id} className="flex items-start gap-3 px-3 py-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-semibold truncate">{entry.customer.name}</p>
                          <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${classBadgeClasses(entry.customer.class)}`}>
                            Class {entry.customer.class}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Archived {new Date(entry.archivedAt).toLocaleString()} ·{' '}
                          {entry.bills.length} bill{entry.bills.length === 1 ? '' : 's'} saved
                        </p>
                        {entry.reason && (
                          <p className="text-[11px] italic text-muted-foreground mt-0.5 truncate">
                            "{entry.reason}"
                          </p>
                        )}
                      </div>
                      <div className="flex gap-1 flex-shrink-0">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleRestore(entry.customer.id, entry.customer.name)}
                        >
                          <Undo2 className="h-3.5 w-3.5" /> Restore
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handlePurge(entry.customer.id, entry.customer.name)}
                          className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setArchiveOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-emerald-600 text-white text-sm font-semibold px-4 py-3 rounded-lg shadow-xl">
          ✓ {toast}
        </div>
      )}
    </div>
  );
};

interface SortableThProps {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
  className?: string;
  align?: 'left' | 'right';
}
const SortableTh: React.FC<SortableThProps> = ({ label, onClick, icon, className = '', align = 'left' }) => (
  <th className={`${className} font-bold ${align === 'right' ? 'text-right' : ''}`}>
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 hover:text-foreground transition select-none ${align === 'right' ? 'flex-row-reverse' : ''}`}
    >
      <span>{label}</span>
      {icon}
    </button>
  </th>
);

// Skeleton placeholders shown while the next page of customers is loading.
const CustomerRowSkeleton: React.FC = () => (
  <tr className="animate-pulse">
    <td className="px-5 py-3">
      <div className="h-4 w-32 bg-slate-200 rounded mb-1.5" />
      <div className="h-3 w-24 bg-slate-100 rounded" />
    </td>
    <td className="px-3 py-3"><div className="h-3 w-24 bg-slate-200 rounded" /></td>
    <td className="px-3 py-3"><div className="h-3 w-20 bg-slate-100 rounded" /></td>
    <td className="px-3 py-3"><div className="h-5 w-16 bg-slate-200 rounded-full" /></td>
    <td className="px-3 py-3"><div className="h-3 w-16 bg-slate-100 rounded" /></td>
    <td className="px-3 py-3 text-right"><div className="h-4 w-16 bg-slate-200 rounded ml-auto" /></td>
    <td className="px-5 py-3"><div className="h-6 w-12 bg-slate-100 rounded ml-auto" /></td>
  </tr>
);

const CustomerCardSkeleton: React.FC = () => (
  <Card className="animate-pulse">
    <CardContent className="p-4">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex-1">
          <div className="h-4 w-36 bg-slate-200 rounded mb-1.5" />
          <div className="h-3 w-24 bg-slate-100 rounded" />
        </div>
        <div className="h-5 w-14 bg-slate-200 rounded-full" />
      </div>
      <div className="flex items-center justify-between pt-3 border-t">
        <div>
          <div className="h-2.5 w-16 bg-slate-100 rounded mb-1.5" />
          <div className="h-4 w-20 bg-slate-200 rounded" />
        </div>
        <div className="h-7 w-16 bg-slate-100 rounded" />
      </div>
    </CardContent>
  </Card>
);

export default AdminCustomers;
