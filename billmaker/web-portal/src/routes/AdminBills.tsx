import React, { useState, useMemo, useEffect } from 'react';
import { Search, ChevronDown, Eye, EyeOff, Loader2 } from 'lucide-react';
import { store, fmtINR, toggleBillAcknowledged, acknowledgeBills, onStoreChange } from '../data/dummyData';
import { useAdminAggregates } from '../lib/adminAggregates';
import { useCollectionLoaded } from '../lib/syncHooks';
import { loadBillsForDateRange } from '../lib/firestoreSync';
import { InlineSkeleton } from '../components/client/Skeletons';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Switch } from '../components/ui/switch';
import { Input } from '../components/ui/input';
import { usePagination } from '../hooks/usePagination';
import { cn } from '../lib/utils';

const PAGE_SIZE = 20;

const AdminBills: React.FC = () => {
  const [, force] = useState(0);
  useEffect(() => onStoreChange(() => force(n => n + 1)), []);

  const [filter, setFilter] = useState<'all' | 'pending' | 'released'>('pending');
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // On-demand lookback state. We load the most recent 30 days via the live
  // subscription; older months only load when the user explicitly scrolls
  // past the end of what's currently shown. Caps at 12 lookbacks (= 1 year
  // past) to bound runaway cost.
  const [lookbackEarliestMs, setLookbackEarliestMs] = useState(
    () => Date.now() - 30 * 24 * 60 * 60 * 1000,
  );
  const [lookbackInFlight, setLookbackInFlight] = useState(false);
  const [lookbackExhausted, setLookbackExhausted] = useState(false);
  const lookbackTriggersRef = React.useRef(0);
  const MAX_LOOKBACKS = 12;

  // Wait for the bills snapshot — payments are now embedded in each bill, so
  // a single subscription tells us when paid totals are accurate.
  const listReady = useCollectionLoaded('bills');

  // Bill counts read directly from admin_aggregates (atomic-incremented by
  // portal + worker — see lib/adminAggregates.ts). Zero extra reads per
  // mount; rides the existing aggregate subscription. Earlier this was a
  // pair of getCountFromServer queries (2 reads/mount).
  const { value: agg, loaded: aggReady } = useAdminAggregates();
  const total = agg?.totalBillCount ?? null;
  const pendingCount = agg?.pendingCount ?? 0;
  const ackedCount = (agg && typeof agg.totalBillCount === 'number' && typeof agg.pendingCount === 'number')
    ? agg.totalBillCount - agg.pendingCount
    : null;

  const filtered = useMemo(() => {
    let list = store.bills.slice();
    if (filter === 'pending') list = list.filter(b => !b.acknowledged);
    else if (filter === 'released') list = list.filter(b => b.acknowledged);
    if (search.trim()) {
      const s = search.toLowerCase();
      list = list.filter(b => b.billNumber.toLowerCase().includes(s) || b.customerName.toLowerCase().includes(s));
    }
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [filter, search, store.bills.length, store.bills.map(b => b.acknowledged).join(',')]); // eslint-disable-line

  // Reset the lookback counter whenever the filter or search changes — a
  // fresh view starts with its own budget.
  useEffect(() => {
    lookbackTriggersRef.current = 0;
    setLookbackExhausted(false);
  }, [filter, search]);

  // Manual one-month-back loader, invoked by the "Load older bills" button
  // OR by the scroll sentinel below when the user reaches the end of what's
  // currently shown. We never trigger this on initial render — the page
  // always starts at "last 30 days" for consistent behaviour.
  const loadOlderBills = async () => {
    if (lookbackInFlight || lookbackExhausted) return;
    if (lookbackTriggersRef.current >= MAX_LOOKBACKS) {
      setLookbackExhausted(true);
      return;
    }
    lookbackTriggersRef.current += 1;
    const STEP_MS = 30 * 24 * 60 * 60 * 1000;
    const toMs = lookbackEarliestMs;
    const fromMs = toMs - STEP_MS;
    setLookbackInFlight(true);
    try {
      const count = await loadBillsForDateRange(
        new Date(fromMs).toISOString(),
        new Date(toMs).toISOString(),
      );
      setLookbackEarliestMs(fromMs);
      if (count === 0) setLookbackExhausted(true);
    } finally {
      setLookbackInFlight(false);
    }
  };

  // Reset pagination whenever the filter set changes. loadDelayMs=0 because
  // pagination is purely client-side here — there's no server fetch to mask
  // with a synthetic "loading next page" skeleton, so any delay just creates
  // a flicker when the sentinel auto-fires on initial render.
  const pager = usePagination(filtered, {
    pageSize: PAGE_SIZE,
    resetKey: `${filter}|${search}|${filtered.length}`,
    loadDelayMs: 0,
  });

  const toggleSelect = (id: string) =>
    setSelectedIds(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const releaseSelected = () => {
    acknowledgeBills(Array.from(selectedIds));
    setSelectedIds(new Set());
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
      <header className="mb-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Bills</h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
              Bills entered in Baniya mobile sync here. Toggle <strong>Release</strong> to make a bill visible in the client portal.
            </p>
          </div>
          {!aggReady ? (
            <Badge variant="warning" className="text-xs px-3 py-1.5">
              <InlineSkeleton width="2em" /> pending acknowledge
            </Badge>
          ) : pendingCount > 0 ? (
            <Badge variant="warning" className="text-xs px-3 py-1.5">
              {pendingCount} pending acknowledge
            </Badge>
          ) : null}
        </div>
      </header>

      <Card>
        <div className="p-3 sm:p-4 border-b flex flex-col sm:flex-row gap-3">
          <div className="flex gap-1 bg-muted rounded-lg p-1">
            {(['pending', 'released', 'all'] as const).map(f => {
              // Tab counts read from admin_aggregates (atomic counters).
              // Released = total - pending. Skeleton while aggregate doc loads.
              const count =
                f === 'pending'  ? pendingCount :
                f === 'released' ? ackedCount :
                                   total;
              return (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={cn(
                    'flex-1 sm:flex-none px-3 py-1.5 text-xs font-semibold rounded-md transition capitalize inline-flex items-center gap-1.5',
                    filter === f ? 'bg-background text-primary shadow' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {f}
                  <span className={cn(
                    'inline-flex items-center justify-center min-w-[1.5em] px-1.5 py-0.5 rounded-full text-[10px] font-bold',
                    filter === f
                      ? 'bg-primary/10 text-primary'
                      : 'bg-muted-foreground/15 text-muted-foreground',
                  )}>
                    {count !== null ? count : <InlineSkeleton width="1.5em" />}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="relative flex-1">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search bill # or customer…"
              className="pl-9"
            />
          </div>
          {selectedIds.size > 0 && (
            <Button onClick={releaseSelected} variant="default">
              <Eye className="h-4 w-4" /> Release {selectedIds.size}
            </Button>
          )}
        </div>

        <div className="divide-y">
          {!listReady ? (
            Array.from({ length: 6 }, (_, i) => <BillRowSkeleton key={`sk-${i}`} />)
          ) : filtered.length === 0 ? (
            <div className="p-12 text-center text-sm text-muted-foreground">
              <p>
                No {filter === 'all' ? '' : filter + ' '}bills
                {' '}from {new Date(lookbackEarliestMs).toLocaleDateString()}
                {' '}to now.
              </p>
              {!lookbackExhausted && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={loadOlderBills}
                  disabled={lookbackInFlight}
                  className="mt-3"
                >
                  {lookbackInFlight
                    ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading older bills…</>
                    : <><ChevronDown className="h-3.5 w-3.5" /> Load older bills</>}
                </Button>
              )}
              {lookbackExhausted && (
                <p className="text-xs text-muted-foreground mt-2 italic">
                  No older bills found.
                </p>
              )}
            </div>
          ) : (
            pager.page.map(b => {
              const isExpanded = expandedId === b.id;
              const due = b.total - b.paid;
              return (
                <div key={b.id} className="hover:bg-muted/40 transition">
                  <div className="p-3 sm:p-4 flex items-start gap-3">
                    {!b.acknowledged && (
                      <input
                        type="checkbox"
                        checked={selectedIds.has(b.id)}
                        onChange={() => toggleSelect(b.id)}
                        className="mt-1.5 w-4 h-4 rounded border-input text-primary focus:ring-primary"
                      />
                    )}

                    <button
                      onClick={() => setExpandedId(isExpanded ? null : b.id)}
                      className="flex-1 min-w-0 text-left"
                    >
                      {/* Mobile: stacked. Desktop: grid */}
                      <div className="flex flex-col sm:grid sm:grid-cols-[1fr,1.5fr,auto,auto] sm:items-center gap-2 sm:gap-4">
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono font-bold text-primary text-sm">{b.billNumber}</span>
                            <Badge variant={b.acknowledged ? 'success' : 'warning'}>
                              {b.acknowledged ? 'Released' : 'Pending'}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {new Date(b.createdAt).toLocaleString()}
                          </p>
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold truncate">{b.customerName}</p>
                          <p className="text-xs text-muted-foreground">{b.items.length} item{b.items.length === 1 ? '' : 's'}</p>
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-foreground">{fmtINR(b.total)}</p>
                          {due > 0 ? (
                            <p className="text-xs text-rose-600 font-semibold">{fmtINR(due)} due</p>
                          ) : (
                            <p className="text-xs text-emerald-700 font-semibold">Paid</p>
                          )}
                        </div>
                        <div className="hidden sm:flex items-center justify-end gap-2">
                          <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition', isExpanded && 'rotate-180')} />
                        </div>
                      </div>
                    </button>

                    <div className="flex flex-col items-end gap-2 flex-shrink-0">
                      <Switch
                        checked={b.acknowledged}
                        onCheckedChange={() => toggleBillAcknowledged(b.id)}
                        aria-label="Release to client"
                      />
                      <span className="text-[9px] uppercase tracking-wider font-bold text-muted-foreground flex items-center gap-1">
                        {b.acknowledged ? <Eye className="h-2.5 w-2.5" /> : <EyeOff className="h-2.5 w-2.5" />}
                        {b.acknowledged ? 'Visible' : 'Hidden'}
                      </span>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="px-4 sm:px-6 pb-4 bg-muted/30 border-t">
                      <div className="overflow-x-auto pt-3">
                        <table className="w-full text-sm min-w-[400px]">
                          <thead>
                            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground border-b">
                              <th className="text-left py-2">Item</th>
                              <th className="text-right py-2 w-20">Qty</th>
                              <th className="text-right py-2 w-24">Rate</th>
                              <th className="text-right py-2 w-28">Amount</th>
                            </tr>
                          </thead>
                          <tbody>
                            {b.items.map((it, i) => (
                              <tr key={i} className="border-b border-border/50">
                                <td className="py-2">{it.productName}</td>
                                <td className="py-2 text-right">{it.quantity} {it.unit}</td>
                                <td className="py-2 text-right">{fmtINR(it.rate)}</td>
                                <td className="py-2 text-right font-semibold">{fmtINR(it.amount)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}

          {/* Skeleton rows shown while the next batch reveals */}
          {pager.loadingMore && Array.from({ length: pager.skeletonCount }, (_, i) => (
            <BillRowSkeleton key={`sk-${i}`} />
          ))}
        </div>

        {/* Sentinel for auto-load + manual "Load more" fallback */}
        {pager.hasMore && (
          <div className="border-t bg-muted/20">
            <div ref={pager.sentinelRef} aria-hidden className="h-1" />
            <div className="flex items-center justify-center py-3 px-4 gap-3 text-xs text-muted-foreground">
              <span>Showing {pager.showing} of {pager.total}</span>
              <Button variant="outline" size="sm" onClick={pager.loadMore} disabled={pager.loadingMore}>
                {pager.loadingMore
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</>
                  : <><ChevronDown className="h-3.5 w-3.5" /> Load more</>}
              </Button>
            </div>
          </div>
        )}

        {/* End of local data — offer to fetch the previous month from
            Firestore. Single click = one month older, repeatable. Always
            user-initiated (no auto-trigger) so the page behaviour stays
            predictable. */}
        {listReady && filtered.length > 0 && !pager.hasMore && !lookbackExhausted && (
          <div className="border-t bg-muted/20 flex items-center justify-center py-4 px-4 gap-3 text-xs text-muted-foreground">
            <span>Showing bills since {new Date(lookbackEarliestMs).toLocaleDateString()}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={loadOlderBills}
              disabled={lookbackInFlight}
            >
              {lookbackInFlight
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Fetching older bills…</>
                : <><ChevronDown className="h-3.5 w-3.5" /> Load previous month</>}
            </Button>
          </div>
        )}
        {listReady && filtered.length > 0 && !pager.hasMore && lookbackExhausted && (
          <div className="border-t bg-muted/20 py-3 px-4 text-center text-xs italic text-muted-foreground">
            No older bills found.
          </div>
        )}
      </Card>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Skeleton row — matches the real bill-row layout so the transition is stable.
// ---------------------------------------------------------------------------
const BillRowSkeleton: React.FC = () => (
  <div className="p-3 sm:p-4 flex items-start gap-3 animate-pulse">
    <div className="w-4 h-4 rounded bg-slate-200 mt-1.5 flex-shrink-0 hidden sm:block" />
    <div className="flex-1 min-w-0">
      <div className="flex flex-col sm:grid sm:grid-cols-[1fr,1.5fr,auto,auto] sm:items-center gap-2 sm:gap-4">
        <div>
          <div className="h-4 w-20 bg-slate-200 rounded mb-1.5" />
          <div className="h-3 w-32 bg-slate-100 rounded" />
        </div>
        <div>
          <div className="h-4 w-40 bg-slate-200 rounded mb-1.5" />
          <div className="h-3 w-16 bg-slate-100 rounded" />
        </div>
        <div className="text-right">
          <div className="h-4 w-20 bg-slate-200 rounded ml-auto" />
        </div>
        <div className="hidden sm:block w-4 h-4 bg-slate-200 rounded" />
      </div>
    </div>
    <div className="w-10 h-5 bg-slate-200 rounded-full flex-shrink-0" />
  </div>
);

export default AdminBills;
