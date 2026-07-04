import React, { useMemo, useState } from 'react';
import {
  ChevronDown, FileDown, RefreshCcw, Receipt as ReceiptIcon,
  Search, ArrowUpDown, Loader2, X, IndianRupee, Clock, Share2,
} from 'lucide-react';
import { downloadBillPdf, shareBillOnWhatsApp } from '../lib/billPdf';
import { useT } from '../lib/i18n';
import { fmtINR, fmtINRCompact } from '../data/dummyData';
import { useClientMe, useClientBills, requestReprint, type ClientBusinessInfo } from '../lib/clientData';
import { ClientBillsSkeleton, InlineSkeleton } from '../components/client/Skeletons';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { usePagination } from '../hooks/usePagination';
import { cn } from '../lib/utils';
import type { Bill } from '../types';

const PAGE_SIZE = 10;

type SortKey = 'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc' | 'due_desc';

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'date_desc',   label: 'Newest first' },
  { key: 'date_asc',    label: 'Oldest first' },
  { key: 'amount_desc', label: 'Highest amount' },
  { key: 'amount_asc',  label: 'Lowest amount' },
  { key: 'due_desc',    label: 'Most outstanding' },
];

const ClientBills: React.FC = () => {
  const { me, business, loading: meLoading } = useClientMe();
  const { bills, pendingReprintIds, loading: billsLoading, error: billsError, refetch } = useClientBills();
  const { t } = useT();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reprintBusyId, setReprintBusyId] = useState<string | null>(null);
  const [pdfBusyId, setPdfBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const handleReprint = async (billId: string) => {
    setReprintBusyId(billId);
    try {
      await requestReprint(billId);
      showToast('Reprint requested. Admin will get back to you.');
      await refetch();
    } catch (e: any) {
      const msg = (e as Error)?.message === 'already_pending'
        ? 'A reprint is already requested for this bill.'
        : "Couldn't request a reprint right now.";
      showToast(msg);
    } finally {
      setReprintBusyId(null);
    }
  };

  const handleDownloadPdf = async (bill: Bill) => {
    setPdfBusyId(bill.id);
    try {
      await downloadBillPdf(bill, business);
    } catch {
      showToast("Couldn't generate PDF. Please try again.");
    } finally {
      setPdfBusyId(null);
    }
  };

  const [shareBusyId, setShareBusyId] = useState<string | null>(null);
  const handleShare = async (bill: Bill) => {
    setShareBusyId(bill.id);
    try {
      const { method } = await shareBillOnWhatsApp(bill, business);
      if (method === 'fallback-download') {
        showToast('Bill downloaded. Attach it in the WhatsApp chat we just opened.');
      }
    } catch {
      showToast("Couldn't share the bill. Try downloading and sharing manually.");
    } finally {
      setShareBusyId(null);
    }
  };
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('date_desc');

  // Filter + sort BEFORE pagination so the user sees all matching bills, not
  // just whatever happens to be on the first page.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = bills.slice();
    if (q) {
      list = list.filter(b =>
        b.billNumber.toLowerCase().includes(q) ||
        b.items.some(it => it.productName.toLowerCase().includes(q)),
      );
    }
    switch (sort) {
      case 'date_asc':    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt)); break;
      case 'amount_desc': list.sort((a, b) => b.total - a.total); break;
      case 'amount_asc':  list.sort((a, b) => a.total - b.total); break;
      case 'due_desc':    list.sort((a, b) => (b.total - b.paid) - (a.total - a.paid)); break;
      case 'date_desc':
      default:            list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    return list;
  }, [bills, search, sort]);

  const pager = usePagination(filtered, {
    pageSize: PAGE_SIZE,
    resetKey: `${search}|${sort}|${filtered.length}`,
  });

  if ((meLoading || billsLoading) && !me) {
    return <ClientBillsSkeleton />;
  }
  if (billsError) {
    return <div className="p-8 text-center text-sm text-rose-600">Couldn't load bills — {billsError}</div>;
  }
  if (!me) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        No customer profile is linked to this login.
      </div>
    );
  }

  const totalDue = bills.reduce((s, b) => s + (b.total - b.paid), 0);
  const totalPaid = bills.reduce((s, b) => s + b.paid, 0);
  const totalSpent = bills.reduce((s, b) => s + b.total, 0);

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto">
      {/* Header */}
      <header className="mb-5">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{t('bills.title')}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {billsLoading
            ? <InlineSkeleton width="9em" />
            : `${bills.length} ${bills.length === 1 ? t('bills.subtitleOne') : t('bills.subtitle')}`}
        </p>
      </header>

      {/* Summary stats — render even while loading so the layout stays
          stable. InlineSkeleton replaces values until data lands. */}
      {(billsLoading || bills.length > 0) && (
        <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-5">
          <StatCard label={t('bills.totalBilled')} amount={totalSpent} tone="primary" loading={billsLoading} />
          <StatCard label={t('bills.totalPaid')}   amount={totalPaid}  tone="emerald" loading={billsLoading} />
          <StatCard label={t('bills.outstanding')} amount={totalDue}   tone={totalDue > 0 ? 'rose' : 'muted'} loading={billsLoading} />
        </div>
      )}

      {/* Search + sort */}
      {bills.length > 0 && (
        <div className="flex flex-col sm:flex-row gap-2 mb-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('bills.search')}
              className="pl-9 pr-9"
              inputMode="search"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="relative sm:w-56">
            <ArrowUpDown className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
            <select
              value={sort}
              onChange={e => setSort(e.target.value as SortKey)}
              className="w-full h-9 pl-9 pr-3 rounded-md border border-input bg-background text-sm font-medium focus:outline-none focus:ring-2 focus:ring-blue-400/40 focus:border-blue-400 transition appearance-none"
            >
              {SORTS.map(s => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* List */}
      {billsLoading && bills.length === 0 ? (
        // Bills are still loading — show skeleton rows in place of the empty
        // state so the user doesn't see "No bills yet" flash before data lands.
        <div className="space-y-3">
          {Array.from({ length: 4 }, (_, i) => <BillRowLoading key={`sk-${i}`} />)}
        </div>
      ) : bills.length === 0 ? (
        <Card className="p-8 sm:p-12 text-center">
          <ReceiptIcon className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
          <p className="text-lg font-semibold mb-1">{t('bills.empty.title')}</p>
          <p className="text-sm text-muted-foreground">
            {t('bills.empty.subtitle')}
          </p>
        </Card>
      ) : filtered.length === 0 ? (
        <Card className="p-8 text-center">
          <Search className="h-10 w-10 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm font-semibold">{t('bills.noMatch')} "{search}"</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => setSearch('')}>
            {t('common.clear')}
          </Button>
        </Card>
      ) : (
        <>
          <div className="space-y-3">
            {pager.page.map(b => (
              <BillRow
                key={b.id}
                b={b}
                expanded={expandedId === b.id}
                onToggle={() => setExpandedId(expandedId === b.id ? null : b.id)}
                reprintPending={pendingReprintIds.has(b.id)}
                reprintBusy={reprintBusyId === b.id}
                pdfBusy={pdfBusyId === b.id}
                shareBusy={shareBusyId === b.id}
                onRequestReprint={() => handleReprint(b.id)}
                onDownloadPdf={() => handleDownloadPdf(b)}
                onShare={() => handleShare(b)}
              />
            ))}
            {pager.loadingMore && Array.from({ length: pager.skeletonCount }, (_, i) => (
              <BillRowLoading key={`sk-${i}`} />
            ))}
          </div>

          {pager.hasMore && <div ref={pager.sentinelRef} aria-hidden className="h-1 mt-4" />}

          {pager.hasMore && (
            <div className="flex items-center justify-center mt-5 gap-3 text-xs text-muted-foreground">
              <span>Showing {pager.showing} of {pager.total}</span>
              <Button variant="outline" size="sm" onClick={pager.loadMore} disabled={pager.loadingMore}>
                {pager.loadingMore
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</>
                  : <><ChevronDown className="h-3.5 w-3.5" /> Load more</>}
              </Button>
            </div>
          )}
        </>
      )}

      {/* Toast for reprint + PDF actions */}
      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-blue-700 text-white text-sm font-semibold px-4 py-3 rounded-lg shadow-xl max-w-[90vw]">
          {toast}
        </div>
      )}
    </div>
  );
};


// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------
const StatCard: React.FC<{
  label: string;
  amount: number;
  tone: 'primary' | 'emerald' | 'rose' | 'muted';
  loading?: boolean;
}> = ({ label, amount, tone, loading }) => {
  const toneClass: Record<string, string> = {
    primary: 'from-sky-50 to-blue-50 border-blue-200 text-blue-700',
    emerald: 'from-emerald-50 to-emerald-100 border-emerald-200 text-emerald-700',
    rose: 'from-rose-50 to-rose-100 border-rose-200 text-rose-700',
    muted: 'from-slate-50 to-slate-100 border-slate-200 text-slate-600',
  };

  // Show the compact form (₹85k, ₹1.2L, ₹2 Cr) prominently and the exact
  // value beneath in smaller text. Falls back to a single line for small
  // amounts where compact == exact (e.g. ₹500).
  const compact = fmtINRCompact(amount);
  const exact = fmtINR(amount);
  const showExactBelow = !loading && compact !== `₹${Math.round(amount)}`;

  return (
    <Card className={cn('bg-gradient-to-br border-2', toneClass[tone])}>
      <CardContent className="p-3 sm:p-4">
        <p className="text-[10px] uppercase tracking-widest font-bold opacity-80">{label}</p>
        {loading ? (
          <p className="text-base sm:text-xl font-bold mt-1 text-foreground">
            <InlineSkeleton width="4em" />
          </p>
        ) : (
          <div className="mt-1">
            <p className="text-base sm:text-xl font-bold text-foreground inline-flex items-center leading-tight">
              <IndianRupee className="h-3.5 w-3.5 mr-0.5 flex-shrink-0" />
              <span className="truncate">{compact.replace('₹', '').trim()}</span>
            </p>
            {showExactBelow && (
              <p
                className="text-[10px] text-foreground/55 font-medium mt-0.5 truncate"
                title={exact}
              >
                {exact}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
};


interface BillRowProps {
  b: Bill;
  expanded: boolean;
  onToggle: () => void;
  reprintPending: boolean;
  reprintBusy: boolean;
  pdfBusy: boolean;
  shareBusy: boolean;
  onRequestReprint: () => void;
  onDownloadPdf: () => void;
  onShare: () => void;
}

const BillRow: React.FC<BillRowProps> = ({ b, expanded, onToggle, reprintPending, reprintBusy, pdfBusy, shareBusy, onRequestReprint, onDownloadPdf, onShare }) => {
  const { t } = useT();
  const due = b.total - b.paid;
  return (
    <Card className="overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full p-4 sm:p-5 flex items-center justify-between gap-3 hover:bg-muted/40 transition text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono font-bold text-primary text-sm">{b.billNumber}</span>
            {due === 0 ? (
              <Badge variant="success">{t('bills.paid')}</Badge>
            ) : b.paid > 0 ? (
              <Badge variant="warning">{t('bills.partial')}</Badge>
            ) : (
              <Badge variant="destructive">{t('bills.unpaid')}</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {new Date(b.createdAt).toLocaleString()} · {b.items.length} item{b.items.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="text-right flex-shrink-0">
          <p className="font-bold text-foreground">{fmtINR(b.total)}</p>
          {due > 0 && <p className="text-xs text-rose-600 font-semibold">{fmtINR(due)} due</p>}
        </div>
        <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition', expanded && 'rotate-180')} />
      </button>

      {expanded && (
        <div className="px-4 sm:px-5 pb-4 sm:pb-5 border-t bg-muted/30">
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
          <div className="flex justify-end mt-3 gap-2 flex-wrap">
            <div className="text-right text-sm flex-1 min-w-[180px]">
              <div className="space-y-1">
                <div className="flex justify-between gap-8">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span className="font-semibold">{fmtINR(b.total)}</span>
                </div>
                <div className="flex justify-between gap-8">
                  <span className="text-muted-foreground">Paid</span>
                  <span className="font-semibold">{fmtINR(b.paid)}</span>
                </div>
                <div className="flex justify-between gap-8 pt-1 border-t">
                  <span className="font-bold">Balance</span>
                  <span className={cn('font-bold', due > 0 ? 'text-rose-600' : 'text-emerald-700')}>
                    {fmtINR(due)}
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 justify-end mt-3">
            <Button
              variant="outline"
              size="sm"
              disabled={pdfBusy}
              type="button"
              onClick={e => { e.stopPropagation(); onDownloadPdf(); }}
            >
              {pdfBusy
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('bills.generating')}</>
                : <><FileDown className="h-3.5 w-3.5" /> {t('bills.downloadPdf')}</>}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={shareBusy}
              type="button"
              onClick={e => { e.stopPropagation(); onShare(); }}
              className="border-emerald-200 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
            >
              {shareBusy
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('bills.sharing')}</>
                : <><Share2 className="h-3.5 w-3.5" /> {t('bills.shareWhatsapp')}</>}
            </Button>
            {reprintPending ? (
              <Button variant="secondary" size="sm" disabled type="button" className="cursor-not-allowed opacity-80">
                <Clock className="h-3.5 w-3.5" /> {t('bills.reprintRequested')}
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                type="button"
                disabled={reprintBusy}
                onClick={e => { e.stopPropagation(); onRequestReprint(); }}
              >
                {reprintBusy
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('bills.requesting')}</>
                  : <><RefreshCcw className="h-3.5 w-3.5" /> {t('bills.requestReprint')}</>}
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
};


const BillRowLoading: React.FC = () => (
  <Card className="overflow-hidden animate-pulse">
    <div className="p-4 sm:p-5 flex items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="h-4 w-20 bg-slate-200 rounded" />
          <div className="h-5 w-14 bg-slate-100 rounded-full" />
        </div>
        <div className="h-3 w-40 bg-slate-100 rounded mt-2" />
      </div>
      <div className="text-right">
        <div className="h-4 w-20 bg-slate-200 rounded ml-auto" />
        <div className="h-3 w-14 bg-slate-100 rounded mt-1.5 ml-auto" />
      </div>
      <div className="h-4 w-4 bg-slate-100 rounded" />
    </div>
  </Card>
);

export default ClientBills;
