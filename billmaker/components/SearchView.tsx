import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { Bill, Payment, Profile } from '../types';
import BillViewer from './BillViewer';
import { SearchIcon } from './Icons';
import { calcBillTotal, formatINR } from '../utils/billTotal';
import { setBackHandler } from '../utils/backHandler';

interface SearchViewProps {
  bills: Bill[];
  payments: Payment[];
  activeProfile: Profile | null;
  onSaveBill: (bill: Partial<Bill>) => Promise<Bill>;
  onSaveDraft?: (bill: Partial<Bill>) => Promise<Bill>;
  onSyncDraft?: (draftId: string) => Promise<Bill>;
}

// Aggregated view per customer used on the search list. Replaces the old
// "name + count + total" tile with a denser row showing recent activity
// and money owed at a glance.
interface CustomerSummary {
  name: string;
  billCount: number;
  totalPurchase: number;
  totalPaid: number;
  outstanding: number;
  lastBill?: Bill;
}

type ViewState =
  | { type: 'SEARCH_LIST' }
  | { type: 'CUSTOMER_BILLS', customerName: string };

const SearchView: React.FC<SearchViewProps> = ({ bills, payments, activeProfile, onSaveBill, onSaveDraft, onSyncDraft }) => {
  const [viewState, setViewState] = useState<ViewState>({ type: 'SEARCH_LIST' });
  const [searchTerm, setSearchTerm] = useState('');
  // The bill currently shown in BillViewer (replaces old SummaryModal +
  // BillDetailView). Always opens in 'view' mode; the user taps Edit
  // inside the viewer to switch to editing.
  const [openBill, setOpenBill] = useState<Bill | null>(null);


  // State for filtering and sorting
  const [sortOption, setSortOption] = useState('createdAt_desc');
  const [dateFilter, setDateFilter] = useState('all');
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');

  // Hardware back navigation through view stack
  useEffect(() => {
    setBackHandler(() => {
      if (openBill) { setOpenBill(null); return true; }
      if (viewState.type === 'CUSTOMER_BILLS') {
        setViewState({ type: 'SEARCH_LIST' });
        return true;
      }
      return false;
    });
    return () => setBackHandler(null);
  }, [viewState, openBill]);

  // Native share via Capacitor — mirrors HomeView so the share icon
  // inside BillViewer pops the OS share sheet.
  const handleShare = useCallback(async (bill: Bill) => {
    try {
      const { Share } = await import('@capacitor/share');
      const total = calcBillTotal(bill.products);
      const lines = bill.products
        .filter(p => p.name?.trim())
        .map(p => `${p.name} x${p.quantity} — ${formatINR(Number(p.price) * Number(p.quantity))}`)
        .join('\n');
      const text =
        `Bill ${bill.billNumber}\n` +
        `${bill.customerName}\n` +
        `${bill.createdAt.toLocaleDateString()}\n\n` +
        `${lines}\n\n` +
        `Total: ${formatINR(total)}`;
      await Share.share({ title: `Bill ${bill.billNumber}`, text });
    } catch {
      /* user cancelled or share unavailable */
    }
  }, []);

  const customerBills = useMemo(() => {
    const customerMap = new Map<string, Bill[]>();
    bills.forEach(bill => {
      const existing = customerMap.get(bill.customerName) || [];
      customerMap.set(bill.customerName, [...existing, bill]);
    });
    return customerMap;
  }, [bills]);

  // Bill-id → sum of payments. Computed once per payments change so the
  // per-customer outstanding tally is O(bills) not O(bills × payments).
  const paidByBillId = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of payments) {
      map.set(p.billId, (map.get(p.billId) || 0) + p.amount);
    }
    return map;
  }, [payments]);

  // Pre-compute one summary per customer: bill count, total purchase,
  // total paid, outstanding (purchase − paid, clamped at 0), and the most
  // recent bill so the row can show "Last: LE-0042 (12 Jun)". Drafts are
  // excluded from MONEY totals (purchase, paid, outstanding) but ARE
  // counted toward the bill count and the lastBill probe — so a customer
  // who only has a draft still surfaces in search and the user can find it.
  const customerSummaries = useMemo<CustomerSummary[]>(() => {
    const out: CustomerSummary[] = [];
    for (const [name, allList] of customerBills.entries()) {
      const nonDraftList = allList.filter(b => b.isDraft !== true);
      let totalPurchase = 0;
      let totalPaid = 0;
      // Money totals exclude drafts. The lastBill probe scans BOTH so a
      // recently-saved draft still updates the customer's "last activity"
      // ordering on the search list.
      for (const b of nonDraftList) {
        totalPurchase += calcBillTotal(b.products);
        totalPaid += paidByBillId.get(b.id) || 0;
      }
      let lastBill: Bill | undefined;
      for (const b of allList) {
        if (!lastBill || b.createdAt.getTime() > lastBill.createdAt.getTime()) {
          lastBill = b;
        }
      }
      out.push({
        name,
        billCount: allList.length,
        totalPurchase,
        totalPaid,
        outstanding: Math.max(0, totalPurchase - totalPaid),
        lastBill,
      });
    }
    // Sort by most-recent activity so active customers float to the top.
    out.sort((a, b) => {
      const at = a.lastBill?.createdAt.getTime() ?? 0;
      const bt = b.lastBill?.createdAt.getTime() ?? 0;
      return bt - at;
    });
    return out;
  }, [customerBills, paidByBillId]);

  const filteredCustomers = useMemo(() => {
    if (!searchTerm) return customerSummaries;
    const q = searchTerm.toLowerCase();
    return customerSummaries.filter(c => c.name.toLowerCase().includes(q));
  }, [searchTerm, customerSummaries]);
  
  const processedBillsForCustomer = useMemo(() => {
    if (viewState.type !== 'CUSTOMER_BILLS') return [];

    let billsToProcess = [...(customerBills.get(viewState.customerName) || [])];

    // 1. Filter by date
    if (dateFilter !== 'all') {
      const now = new Date();
      let start: Date | null = null;
      let end: Date | null = null;

      if (dateFilter === 'last_month') {
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
        end = now;
      } else if (dateFilter === 'custom' && customStartDate && customEndDate) {
        start = new Date(customStartDate);
        end = new Date(customEndDate);
        end.setHours(23, 59, 59, 999); // Include the whole end day
      }

      if (start && end) {
        const startTime = start.getTime();
        const endTime = end.getTime();
        billsToProcess = billsToProcess.filter(b => {
          const billTime = b.createdAt.getTime();
          return billTime >= startTime && billTime <= endTime;
        });
      }
    }

    // 2. Sort
    return billsToProcess.sort((a, b) => {
      switch (sortOption) {
        case 'createdAt_asc':
          return a.createdAt.getTime() - b.createdAt.getTime();
        case 'updatedAt_desc':
          return b.updatedAt.getTime() - a.updatedAt.getTime();
        case 'createdAt_desc':
        default:
          return b.createdAt.getTime() - a.createdAt.getTime();
      }
    });
  }, [viewState, customerBills, dateFilter, customStartDate, customEndDate, sortOption]);


  const renderContent = () => {
    switch (viewState.type) {
      case 'SEARCH_LIST':
        return (
          <div className="space-y-3">
            <div className="relative">
              <span className="absolute inset-y-0 left-0 flex items-center pl-3">
                <SearchIcon />
              </span>
              <input
                type="text"
                placeholder="Search by customer name..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full py-2.5 pl-10 pr-4 border border-slate-300 rounded-lg focus:ring-sky-500 focus:border-sky-500 transition bg-white text-sm"
              />
            </div>
            {/* Loose rows. List view shows ONLY serial + name + bill count
                + an explicit open arrow. Totals and outstanding live on the
                customer detail screen (opens on tap). Each row is its own
                card with breathing room between them. */}
            <div className="space-y-2">
              {filteredCustomers.map((c, idx) => {
                const open = () => setViewState({ type: 'CUSTOMER_BILLS', customerName: c.name });
                return (
                  <div
                    key={c.name}
                    onClick={open}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') open(); }}
                    className="bg-white border border-slate-200 rounded-xl px-3 py-3 flex items-center gap-3 active:bg-sky-50 active:border-sky-300 transition cursor-pointer"
                  >
                    {/* Serial number — fixed-width chip so names align. */}
                    <span className="w-7 h-7 shrink-0 flex items-center justify-center text-[11px] font-mono font-bold text-sky-700 bg-sky-50 rounded-full">
                      {idx + 1}
                    </span>

                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-slate-900 truncate">{c.name}</p>
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        {c.billCount} bill{c.billCount === 1 ? '' : 's'}
                      </p>
                    </div>

                    {/* Open button — no background, just a thick chevron in
                        sky-blue. Click target is still 36px square for thumbs;
                        stopPropagation prevents the parent row's onClick from
                        firing twice. */}
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); open(); }}
                      aria-label={`Open ${c.name}`}
                      className="flex items-center justify-center w-9 h-9 text-sky-600 active:text-sky-800"
                    >
                      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9 18l6-6-6-6" />
                      </svg>
                    </button>
                  </div>
                );
              })}
              {filteredCustomers.length === 0 && (
                <p className="text-slate-500 text-center py-8 text-sm">No customers found.</p>
              )}
            </div>
          </div>
        );

      case 'CUSTOMER_BILLS': {
        // Pull the pre-computed aggregate for the header summary. Search list
        // intentionally omits these numbers; they only show here.
        const summary = customerSummaries.find(c => c.name === viewState.customerName);

        return (
          <div className="space-y-3">
            <button
              onClick={() => setViewState({ type: 'SEARCH_LIST' })}
              className="text-sky-600 text-sm font-semibold inline-flex items-center gap-1"
            >
              &larr; Back to search
            </button>
            <h2 className="text-xl font-bold text-slate-900 truncate">{viewState.customerName}</h2>

            {/* Summary card — totals live ONLY on this detail screen, never
                on the search list. Three stat columns: bills, purchase, due. */}
            {summary && (
              <div className="bg-white border border-slate-200 rounded-xl p-3 grid grid-cols-3 gap-2 divide-x divide-slate-100">
                <div className="px-1">
                  <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Bills</p>
                  <p className="text-lg font-bold text-slate-900 mt-0.5">{summary.billCount}</p>
                </div>
                <div className="px-2">
                  <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Total</p>
                  <p className="text-lg font-bold text-sky-900 mt-0.5">{formatINR(summary.totalPurchase)}</p>
                </div>
                <div className="px-2">
                  <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">Due</p>
                  <p className={`text-lg font-bold mt-0.5 ${summary.outstanding > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                    {summary.outstanding > 0 ? formatINR(summary.outstanding) : '✓'}
                  </p>
                </div>
              </div>
            )}

            {/* Compact filter row — sort + date filter on ONE line on phones.
                Selects shrink to share the row equally; custom-range inputs
                wrap to their own row only when chosen. */}
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-2 space-y-2">
              <div className="flex items-center gap-2 text-xs">
                <select
                  aria-label="Sort by"
                  value={sortOption}
                  onChange={e => setSortOption(e.target.value)}
                  className="flex-1 min-w-0 px-2 py-1.5 border border-slate-300 rounded-md bg-white focus:ring-sky-500 focus:border-sky-500"
                >
                  <option value="createdAt_desc">Newest first</option>
                  <option value="createdAt_asc">Oldest first</option>
                  <option value="updatedAt_desc">Last updated</option>
                </select>
                <select
                  aria-label="Date filter"
                  value={dateFilter}
                  onChange={e => setDateFilter(e.target.value)}
                  className="flex-1 min-w-0 px-2 py-1.5 border border-slate-300 rounded-md bg-white focus:ring-sky-500 focus:border-sky-500"
                >
                  <option value="all">All time</option>
                  <option value="last_month">Last month</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
              {dateFilter === 'custom' && (
                <div className="flex items-center gap-2 text-xs">
                  <input type="date" value={customStartDate} onChange={e => setCustomStartDate(e.target.value)} className="flex-1 min-w-0 px-2 py-1.5 border border-slate-300 rounded-md bg-white focus:ring-sky-500 focus:border-sky-500" />
                  <span className="text-slate-500">to</span>
                  <input type="date" value={customEndDate} onChange={e => setCustomEndDate(e.target.value)} className="flex-1 min-w-0 px-2 py-1.5 border border-slate-300 rounded-md bg-white focus:ring-sky-500 focus:border-sky-500" />
                </div>
              )}
            </div>

            <div className="space-y-2">
              {processedBillsForCustomer.map(bill => {
                const draft = bill.isDraft === true;
                return (
                  <div
                    key={bill.id}
                    onClick={() => setOpenBill(bill)}
                    className={`p-3 rounded-xl border transition cursor-pointer ${
                      draft
                        ? 'bg-amber-50 border-amber-300 active:bg-amber-100'
                        : 'bg-white border-slate-200 active:bg-sky-50 active:border-sky-300'
                    }`}
                  >
                    <div className="flex justify-between items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className={`font-semibold text-sm font-mono ${draft ? 'text-amber-800' : 'text-sky-700'}`}>
                            {draft ? '— not synced —' : bill.billNumber}
                          </p>
                          {draft && (
                            <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-amber-200 text-amber-900 border border-amber-400">
                              Draft
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-slate-500 mt-0.5">{bill.products.length} item{bill.products.length === 1 ? '' : 's'} • {bill.createdAt.toLocaleDateString()}</p>
                      </div>
                      <span className={`font-bold text-base whitespace-nowrap ${draft ? 'text-amber-800' : 'text-sky-900'}`}>
                        {formatINR(calcBillTotal(bill.products))}
                      </span>
                    </div>
                  </div>
                );
              })}
              {processedBillsForCustomer.length === 0 && <p className="text-center text-slate-500 py-8 text-sm">No bills match the current filters.</p>}
            </div>
          </div>
        );
      }

    }
  };

  return (
    <div className="max-w-4xl mx-auto">
      {renderContent()}
      {/* Pick the live bill from props by id so an external edit (e.g. the
          viewer's own save callback) reflects immediately without closing. */}
      <BillViewer
        isOpen={!!openBill}
        initialMode="view"
        bill={openBill ? (bills.find(b => b.id === openBill.id) ?? openBill) : undefined}
        activeProfile={activeProfile}
        onClose={() => setOpenBill(null)}
        onSave={onSaveBill}
        onSaveDraft={onSaveDraft}
        onSyncDraft={onSyncDraft}
        onShare={handleShare}
        allBills={bills}
      />
    </div>
  );
};

export default SearchView;