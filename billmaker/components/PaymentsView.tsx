import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Bill, Payment, Profile } from '../types';
import { SearchIcon, CashIcon, ReceiptIcon, ArrowLeftIcon, TrashIcon, PlusIcon, CheckIcon } from './Icons';
import { MoreVertical } from 'lucide-react';
import { formatINR } from '../utils/billTotal';
import {
  billTotal,
  billBalance,
  billPaidAmount,
  billStatus,
  paymentsForBill,
  totalOutstanding,
  paidThisMonth,
  lastPaymentDate,
  dailyPaymentTotals,
  topOutstandingCustomers,
  PaymentStatus,
} from '../utils/paymentMath';
import { setBackHandler } from '../utils/backHandler';
import AddPaymentModal from './AddPaymentModal';
import { addPayment as addPaymentStorage, deletePayment as deletePaymentStorage } from '../storage/paymentStorage';
import { log } from '../utils/diagnostics';

interface PaymentsViewProps {
  bills: Bill[];
  payments: Payment[];
  activeProfile: Profile | null;
  onPaymentsChanged: () => void;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

type Filter = 'all' | 'outstanding' | 'partial' | 'paid';

const PaymentsView: React.FC<PaymentsViewProps> = ({
  bills,
  payments,
  activeProfile,
  onPaymentsChanged,
  showToast,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedBillId, setSelectedBillId] = useState<string | null>(null);
  const [showAddPayment, setShowAddPayment] = useState(false);
  // Dashboard (chart + top outstanding) is hidden behind a 3-dot menu so the
  // default Payments tab is fast to scan — chart only renders on demand.
  const [showDashboard, setShowDashboard] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setBackHandler(() => {
      if (menuOpen) { setMenuOpen(false); return true; }
      if (showAddPayment) { setShowAddPayment(false); return true; }
      if (selectedBillId) { setSelectedBillId(null); return true; }
      return false;
    });
    return () => setBackHandler(null);
  }, [menuOpen, showAddPayment, selectedBillId]);

  // Close the menu when the user taps outside it. Without this an open menu
  // would persist when the user taps a bill row or the search field.
  useEffect(() => {
    if (!menuOpen) return;
    const onDocPointer = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onDocPointer);
    return () => document.removeEventListener('pointerdown', onDocPointer);
  }, [menuOpen]);

  const stats = useMemo(() => ({
    outstanding: totalOutstanding(bills, payments),
    receivedThisMonth: paidThisMonth(payments),
  }), [bills, payments]);

  const filteredBills = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    let list = bills.slice();

    if (term) {
      list = list.filter(b =>
        b.billNumber.toLowerCase().includes(term) ||
        b.customerName.toLowerCase().includes(term),
      );
    }

    if (filter !== 'all') {
      list = list.filter(b => {
        const s = billStatus(b, payments);
        if (filter === 'outstanding') return s === 'unpaid' || s === 'partial';
        return s === filter;
      });
    }

    // Sort by createdAt DESC — newest bills surface at the top so recently
    // generated bills (the most likely candidates for receiving a payment)
    // are reachable without scrolling. Status colouring is still visible
    // via the badge / balance highlight.
    list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return list;
  }, [bills, payments, searchTerm, filter]);

  const selectedBill = selectedBillId ? bills.find(b => b.id === selectedBillId) || null : null;

  const handleAddPayment = async (payment: Payment) => {
    try {
      await addPaymentStorage(payment);
      log('info', 'storage', `Payment added for bill ${payment.billId}: ${payment.amount}`);
      onPaymentsChanged();
      showToast(`Payment of ${formatINR(payment.amount)} recorded`);
    } catch (e: any) {
      log('error', 'storage', 'Add payment failed', e);
      showToast(`Couldn't save payment: ${String(e?.message || e).slice(0, 100)}`, 'error');
    }
  };

  const handleDeletePayment = async (paymentId: string) => {
    if (!window.confirm('Delete this payment?')) return;
    try {
      await deletePaymentStorage(paymentId);
      log('info', 'storage', `Payment deleted: ${paymentId}`);
      onPaymentsChanged();
      showToast('Payment deleted');
    } catch (e: any) {
      log('error', 'storage', 'Delete payment failed', e);
      showToast(`Couldn't delete: ${String(e?.message || e).slice(0, 100)}`, 'error');
    }
  };

  if (selectedBill) {
    return (
      <>
        <BillPaymentDetail
          bill={selectedBill}
          allPayments={payments}
          onBack={() => setSelectedBillId(null)}
          onAddPaymentClick={() => setShowAddPayment(true)}
          onDeletePayment={handleDeletePayment}
        />
        {showAddPayment && (
          <AddPaymentModal
            bill={selectedBill}
            existingPayments={payments}
            activeProfile={activeProfile}
            onClose={() => setShowAddPayment(false)}
            onSave={handleAddPayment}
          />
        )}
      </>
    );
  }

  return (
    <div className="max-w-4xl mx-auto pb-12">
      {/* Header with 3-dot overflow menu. The dashboard (chart + top
          outstanding) lives behind the menu so the default tab is fast and
          uncluttered — users who want analytics tap to reveal them. */}
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-slate-800">Payments</h2>
          <p className="text-xs text-slate-500 mt-0.5">Record received payments and track customer balances</p>
        </div>
        <div className="relative flex-shrink-0" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen(o => !o)}
            aria-label="More options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="w-9 h-9 flex items-center justify-center rounded-full text-slate-700 bg-white border border-slate-200 active:bg-slate-100 shadow-sm"
          >
            <MoreVertical className="w-5 h-5" strokeWidth={2.5} />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full mt-1 w-48 bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden z-20"
            >
              <button
                role="menuitem"
                onClick={() => { setShowDashboard(d => !d); setMenuOpen(false); }}
                className="w-full text-left px-3 py-2.5 text-sm font-semibold text-slate-700 active:bg-sky-50 flex items-center justify-between gap-2"
              >
                <span>{showDashboard ? 'Hide dashboard' : 'Show dashboard'}</span>
                <span className="text-[10px] text-slate-500 uppercase tracking-wide">
                  {showDashboard ? 'On' : 'Off'}
                </span>
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-4">
        <SummaryCard label="Outstanding" value={formatINR(stats.outstanding)} accent="rose" />
        <SummaryCard label="Received this month" value={formatINR(stats.receivedThisMonth)} accent="sky" />
      </div>

      {showDashboard && <AnalysisSection bills={bills} payments={payments} />}

      <div className="relative mb-3">
        <span className="absolute inset-y-0 left-0 flex items-center pl-3">
          <SearchIcon />
        </span>
        <input
          type="text"
          placeholder="Search by bill number or customer name…"
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          className="w-full py-3 pl-10 pr-4 border border-slate-300 rounded-lg focus:ring-sky-500 focus:border-sky-500 bg-white"
        />
      </div>

      <div className="flex gap-1.5 mb-4 overflow-x-auto">
        <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} label="All" />
        <FilterChip active={filter === 'outstanding'} onClick={() => setFilter('outstanding')} label="Outstanding" />
        <FilterChip active={filter === 'partial'} onClick={() => setFilter('partial')} label="Partial" />
        <FilterChip active={filter === 'paid'} onClick={() => setFilter('paid')} label="Paid" />
      </div>

      {filteredBills.length === 0 ? (
        <div className="bg-white rounded-lg shadow-sm p-8 text-center text-slate-500">
          {bills.length === 0 ? 'No bills yet. Create a bill to start tracking payments.' : 'No bills match your filters.'}
        </div>
      ) : (
        <div className="space-y-2">
          {filteredBills.map(bill => {
            const total = billTotal(bill);
            const paid = billPaidAmount(bill.id, payments);
            const balance = billBalance(bill, payments);
            const status = billStatus(bill, payments);
            const lastPaid = lastPaymentDate(bill.id, payments);
            return (
              <button
                key={bill.id}
                onClick={() => setSelectedBillId(bill.id)}
                className="w-full bg-white rounded-lg shadow-sm p-4 active:bg-slate-50 transition text-left"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                      <p className="font-mono font-bold text-sky-700 text-sm truncate">{bill.billNumber}</p>
                      <StatusBadge status={status} />
                    </div>
                    <p className="font-semibold text-slate-800 truncate">{bill.customerName}</p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {formatINR(paid)} of {formatINR(total)} paid
                    </p>
                    <p className="text-[11px] text-slate-500 mt-0.5 flex flex-wrap gap-x-2">
                      <span>Created: <span className="text-slate-700 font-medium">{bill.createdAt.toLocaleDateString()}</span></span>
                      <span>
                        Last paid:{' '}
                        {lastPaid ? (
                          <span className="text-slate-700 font-medium">{lastPaid.toLocaleDateString()}</span>
                        ) : (
                          <span className="text-slate-400 italic">never</span>
                        )}
                      </span>
                    </p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-[10px] uppercase tracking-wider font-bold text-slate-500">Balance</p>
                    <p className={`text-lg font-bold ${balance > 0 ? 'text-rose-600' : 'text-slate-400'}`}>
                      {formatINR(balance)}
                    </p>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

const SummaryCard: React.FC<{ label: string; value: string; accent: 'rose' | 'sky' }> = ({ label, value, accent }) => {
  const ring = accent === 'rose' ? 'border-rose-300 bg-rose-50' : 'border-sky-300 bg-sky-50';
  const text = accent === 'rose' ? 'text-rose-700' : 'text-sky-700';
  return (
    <div className={`rounded-lg border px-4 py-3 ${ring}`}>
      <p className="text-[10px] uppercase tracking-wider font-bold text-slate-500">{label}</p>
      <p className={`text-2xl font-bold leading-none mt-1 ${text}`}>{value}</p>
    </div>
  );
};

const FilterChip: React.FC<{ active: boolean; onClick: () => void; label: string }> = ({ active, onClick, label }) => (
  <button
    onClick={onClick}
    className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold transition ${
      active ? 'bg-sky-600 text-white' : 'bg-white text-slate-700 border border-slate-300'
    }`}
  >
    {label}
  </button>
);

const StatusBadge: React.FC<{ status: PaymentStatus }> = ({ status }) => {
  const map = {
    paid: { bg: 'bg-sky-100', text: 'text-sky-700', label: 'Paid' },
    partial: { bg: 'bg-amber-100', text: 'text-amber-700', label: 'Partial' },
    unpaid: { bg: 'bg-rose-100', text: 'text-rose-700', label: 'Unpaid' },
  } as const;
  const s = map[status];
  return (
    <span className={`px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-full ${s.bg} ${s.text}`}>
      {s.label}
    </span>
  );
};

// ---------- Bill detail (payment history + add payment) ----------

interface BillPaymentDetailProps {
  bill: Bill;
  allPayments: Payment[];
  onBack: () => void;
  onAddPaymentClick: () => void;
  onDeletePayment: (id: string) => void;
}

const BillPaymentDetail: React.FC<BillPaymentDetailProps> = ({
  bill,
  allPayments,
  onBack,
  onAddPaymentClick,
  onDeletePayment,
}) => {
  const total = billTotal(bill);
  const paid = billPaidAmount(bill.id, allPayments);
  const balance = billBalance(bill, allPayments);
  const status = billStatus(bill, allPayments);
  const history = paymentsForBill(bill.id, allPayments).sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());

  return (
    <div className="max-w-3xl mx-auto pb-32">
      <button onClick={onBack} className="flex items-center gap-1 text-sky-600 active:text-sky-800 font-semibold mb-4">
        <ArrowLeftIcon />
        Back to payments
      </button>

      <div className="bg-white rounded-xl shadow-sm p-5 mb-4">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <p className="font-mono font-bold text-sky-700">{bill.billNumber}</p>
            <p className="font-bold text-slate-800 text-lg truncate">{bill.customerName}</p>
            <p className="text-xs text-slate-500 mt-0.5">{bill.createdAt.toLocaleDateString()}</p>
          </div>
          <StatusBadge status={status} />
        </div>

        <div className="grid grid-cols-3 gap-2 pt-3 border-t border-slate-200">
          <Stat label="Bill total" value={formatINR(total)} />
          <Stat label="Paid" value={formatINR(paid)} />
          <Stat label="Balance" value={formatINR(balance)} highlight={balance > 0} />
        </div>

        <button
          onClick={onAddPaymentClick}
          disabled={balance <= 0.005}
          className="w-full mt-4 flex items-center justify-center gap-2 bg-sky-600 text-white font-bold py-3 rounded-md active:bg-sky-700 transition disabled:bg-slate-300 disabled:cursor-not-allowed"
        >
          {balance <= 0.005 ? <CheckIcon /> : <PlusIcon />}
          {balance <= 0.005 ? 'Bill fully paid' : 'Record payment received'}
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        <header className="px-5 py-3 bg-slate-50 border-b flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-sky-100 text-sky-600 flex items-center justify-center">
            <ReceiptIcon />
          </div>
          <div>
            <h3 className="font-bold text-slate-800 leading-tight">Payment history</h3>
            <p className="text-[11px] text-slate-500 leading-tight">
              {history.length} payment{history.length === 1 ? '' : 's'} recorded
            </p>
          </div>
        </header>
        {history.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-400">
            No payments recorded yet for this bill.
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {history.map(p => (
              <div key={p.id} className="px-5 py-3 flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-slate-800">{formatINR(p.amount)}</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {p.receivedAt.toLocaleDateString()}
                    {p.method && <> · <span className="uppercase">{p.method}</span></>}
                    {p.createdByProfileName && <> · {p.createdByProfileName}</>}
                  </p>
                  {p.note && <p className="text-xs text-slate-600 mt-1 italic">"{p.note}"</p>}
                </div>
                <button
                  onClick={() => onDeletePayment(p.id)}
                  className="text-slate-400 active:text-rose-600 p-1.5"
                  aria-label="Delete payment"
                >
                  <TrashIcon />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string; highlight?: boolean }> = ({ label, value, highlight }) => (
  <div className={`rounded-md border px-2 py-2 ${highlight ? 'bg-rose-50 border-rose-200' : 'bg-slate-50 border-slate-200'}`}>
    <p className="text-[9px] uppercase tracking-wider font-bold text-slate-500">{label}</p>
    <p className={`text-sm font-bold mt-0.5 truncate ${highlight ? 'text-rose-700' : 'text-slate-800'}`}>{value}</p>
  </div>
);

// ---------- Analysis (daily collections chart + top outstanding customers) ----------

interface AnalysisSectionProps {
  bills: Bill[];
  payments: Payment[];
}

const CHART_DAYS = 14;

const formatINRCompact = (n: number): string => {
  if (n >= 10_000_000) return `${(n / 10_000_000).toFixed(1)}Cr`;
  if (n >= 100_000) return `${(n / 100_000).toFixed(1)}L`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
};

const AnalysisSection: React.FC<AnalysisSectionProps> = ({ bills, payments }) => {
  const daily = useMemo(() => dailyPaymentTotals(payments, CHART_DAYS), [payments]);
  const top = useMemo(() => topOutstandingCustomers(bills, payments, 5), [bills, payments]);

  const totalCollected14 = daily.reduce((s, b) => s + b.total, 0);
  const peakDay = daily.reduce((a, b) => (b.total > a.total ? b : a), daily[0]);

  return (
    <div className="space-y-3 mb-4">
      <div className="bg-white rounded-lg shadow-sm p-4">
        <div className="flex items-baseline justify-between mb-2">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Daily collections</p>
            <p className="text-[11px] text-slate-400">Last {CHART_DAYS} days</p>
          </div>
          <div className="text-right">
            <p className="text-[10px] text-slate-500 uppercase tracking-wider font-bold">Total in window</p>
            <p className="text-base font-bold text-sky-700">{formatINR(totalCollected14)}</p>
          </div>
        </div>
        <DailyChart buckets={daily} peakDate={peakDay?.date} />
      </div>

      {top.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm p-4">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
            Top outstanding customers
          </p>
          <TopOutstandingList rows={top} />
        </div>
      )}
    </div>
  );
};

interface DailyChartProps {
  buckets: { date: Date; total: number }[];
  peakDate?: Date;
}

const DailyChart: React.FC<DailyChartProps> = ({ buckets, peakDate }) => {
  const max = Math.max(...buckets.map(b => b.total), 1);
  const W = 320;
  const H = 110;
  const PADL = 36;
  const PADR = 6;
  const PADT = 10;
  const PADB = 22;
  const innerW = W - PADL - PADR;
  const innerH = H - PADT - PADB;
  const slot = innerW / buckets.length;
  const barW = slot * 0.7;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="xMidYMid meet">
      {/* Y-axis */}
      <line x1={PADL} y1={PADT} x2={PADL} y2={PADT + innerH} stroke="#e2e8f0" strokeWidth="1" />
      <line x1={PADL} y1={PADT + innerH} x2={W - PADR} y2={PADT + innerH} stroke="#cbd5e1" strokeWidth="1" />

      {/* Y labels */}
      <text x={PADL - 4} y={PADT + 6} fontSize="8" fill="#64748b" textAnchor="end">
        {formatINRCompact(max)}
      </text>
      <text x={PADL - 4} y={PADT + innerH / 2 + 3} fontSize="8" fill="#94a3b8" textAnchor="end">
        {formatINRCompact(max / 2)}
      </text>
      <text x={PADL - 4} y={PADT + innerH + 3} fontSize="8" fill="#64748b" textAnchor="end">0</text>

      {/* Mid grid */}
      <line
        x1={PADL}
        y1={PADT + innerH / 2}
        x2={W - PADR}
        y2={PADT + innerH / 2}
        stroke="#f1f5f9"
        strokeWidth="1"
        strokeDasharray="2 2"
      />

      {/* Bars */}
      {buckets.map((b, i) => {
        const h = (b.total / max) * innerH;
        const x = PADL + slot * i + (slot - barW) / 2;
        const y = PADT + innerH - h;
        const isPeak = peakDate && b.total > 0 && b.date.getTime() === peakDate.getTime();
        return (
          <g key={i}>
            <rect
              x={x}
              y={y}
              width={barW}
              height={Math.max(h, 1)}
              rx="1.5"
              fill={isPeak ? '#0369a1' : '#0ea5e9'}
              opacity={b.total === 0 ? 0.15 : 1}
            />
          </g>
        );
      })}

      {/* X labels: first, middle, last */}
      {[0, Math.floor(buckets.length / 2), buckets.length - 1].map(i => {
        const b = buckets[i];
        if (!b) return null;
        const x = PADL + slot * i + slot / 2;
        return (
          <text key={`xl-${i}`} x={x} y={H - 6} fontSize="8" fill="#64748b" textAnchor="middle">
            {b.date.getDate()}/{b.date.getMonth() + 1}
          </text>
        );
      })}
    </svg>
  );
};

const TopOutstandingList: React.FC<{
  rows: { customerName: string; outstanding: number; billCount: number }[];
}> = ({ rows }) => {
  const max = rows[0]?.outstanding || 1;
  return (
    <div className="space-y-2.5">
      {rows.map(r => (
        <div key={r.customerName}>
          <div className="flex justify-between items-baseline gap-2 mb-1">
            <span className="text-sm font-semibold text-slate-800 truncate min-w-0 flex-1">
              {r.customerName}
              <span className="text-[11px] text-slate-500 font-normal ml-1.5">
                ({r.billCount} bill{r.billCount === 1 ? '' : 's'})
              </span>
            </span>
            <span className="text-sm font-bold text-rose-600 flex-shrink-0">{formatINR(r.outstanding)}</span>
          </div>
          <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-rose-500 rounded-full"
              style={{ width: `${Math.max(2, (r.outstanding / max) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
};

export default PaymentsView;
