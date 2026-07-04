import React, { useMemo, useState, useCallback } from 'react';
import { ChevronRight, Receipt } from 'lucide-react';
import { Bill, Profile } from '../types';
import BillViewer from './BillViewer';
import { calcBillTotal, formatINR } from '../utils/billTotal';
import { Card, EmptyState, Pill } from './ui';

interface HomeViewProps {
  bills: Bill[];
  activeProfile: Profile | null;
  onSaveBill: (bill: Partial<Bill>) => Promise<Bill>;
  onSaveDraft?: (bill: Partial<Bill>) => Promise<Bill>;
  onSyncDraft?: (draftId: string) => Promise<Bill>;
}

const HomeView: React.FC<HomeViewProps> = ({ bills, activeProfile, onSaveBill, onSaveDraft, onSyncDraft }) => {
  // The bill currently shown in BillViewer. Always opens in 'view' mode —
  // user taps the Edit button inside the viewer to switch to edit.
  const [openBill, setOpenBill] = useState<Bill | null>(null);

  const { todayBills, todayRevenue, monthBills, monthRevenue, uniqueCustomers, recentBills } = useMemo(() => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

    let todayCount = 0;
    let todaySum = 0;
    let monthCount = 0;
    let monthSum = 0;
    const customers = new Set<string>();

    for (const b of bills) {
      // Drafts aren't finalised bills — they shouldn't inflate revenue
      // totals. Counted only after the user syncs them.
      if (b.isDraft === true) continue;
      const t = b.createdAt.getTime();
      const total = calcBillTotal(b.products);
      customers.add(b.customerName);
      if (t >= monthStart) {
        monthCount++;
        monthSum += total;
        if (t >= todayStart) {
          todayCount++;
          todaySum += total;
        }
      }
    }

    const recent = [...bills]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 5);

    return {
      todayBills: todayCount,
      todayRevenue: todaySum,
      monthBills: monthCount,
      monthRevenue: monthSum,
      uniqueCustomers: customers.size,
      recentBills: recent,
    };
  }, [bills]);

  // Share a bill via Capacitor's native share sheet. Plain-text summary —
  // PDF sharing lives in the dedicated print/preview flow.
  const handleShare = useCallback(async (bill: Bill) => {
    try {
      const { Share } = await import('@capacitor/share');
      const lines = [
        `Bill ${bill.billNumber}`,
        `Customer: ${bill.customerName}`,
        `Date: ${bill.createdAt.toLocaleDateString()}`,
        '',
        'Items:',
        ...bill.products.map(p => `  • ${p.name} — ${p.quantity} ${p.prefix} × ${formatINR(parseFloat(p.price) || 0)}`),
        '',
        `Total: ${formatINR(calcBillTotal(bill.products))}`,
      ];
      await Share.share({
        title: `Bill ${bill.billNumber}`,
        text: lines.join('\n'),
        dialogTitle: 'Share bill',
      });
    } catch (e: any) {
      // User-cancelled share or share unavailable — silent fail is fine.
      if (e?.message && !/cancel/i.test(e.message)) {
        console.warn('Share failed:', e);
      }
    }
  }, []);

  // Find the live bill object from the latest `bills` array so updates after
  // an edit show through immediately.
  const liveOpenBill = openBill ? bills.find(b => b.id === openBill.id) || openBill : null;

  return (
    <div className="max-w-4xl mx-auto space-y-5 py-3">
      {activeProfile && (
        <Card padded className="flex items-center justify-between">
          <div>
            <p className="text-[10px] text-slate-500 uppercase tracking-wide font-semibold">Signed in as</p>
            <p className="font-semibold text-slate-800">{activeProfile.name}</p>
          </div>
          <div className="w-10 h-10 rounded-full bg-sky-900 text-white flex items-center justify-center font-bold ring-2 ring-sky-100">
            {activeProfile.name.slice(0, 1).toUpperCase()}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Today" primary={String(todayBills)} secondary={formatINR(todayRevenue)} accent="sky" />
        <StatCard label="This Month" primary={String(monthBills)} secondary={formatINR(monthRevenue)} accent="navy" />
        <StatCard
          label="All Bills"
          primary={String(bills.filter(b => b.isDraft !== true).length)}
          secondary={(() => {
            const drafts = bills.filter(b => b.isDraft === true).length;
            return drafts > 0 ? `${drafts} draft${drafts === 1 ? '' : 's'}` : undefined;
          })()}
          accent="slate"
        />
        <StatCard label="Customers" primary={String(uniqueCustomers)} accent="amber" />
      </div>

      {recentBills.length > 0 ? (
        <div>
          <h2 className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-2 px-1">
            Recent Bills
          </h2>
          <div className="space-y-2">
            {recentBills.map(bill => {
              const draft = bill.isDraft === true;
              return (
                <button
                  key={bill.id}
                  onClick={() => setOpenBill(bill)}
                  // Drafts get a subtle amber border so they stand out in the
                  // list — easy for the user to spot "this one isn't synced yet".
                  className={`w-full p-3.5 rounded-xl border shadow-sm active:bg-slate-50 transition text-left flex items-center gap-3 ${
                    draft ? 'bg-amber-50 border-amber-300' : 'bg-white border-slate-200'
                  }`}
                >
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${
                    draft ? 'bg-amber-200 text-amber-800' : 'bg-sky-100 text-sky-700'
                  }`}>
                    <Receipt className="w-4 h-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-semibold text-slate-900 truncate">{bill.customerName}</p>
                      {draft && (
                        <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-amber-200 text-amber-900 border border-amber-400 flex-shrink-0">
                          Draft
                        </span>
                      )}
                      {!draft && bill.acknowledged && <Pill tone="success">Released</Pill>}
                    </div>
                    <p className="text-[11px] text-slate-500 mt-0.5 truncate">
                      <span className="font-mono">{draft ? '— not synced —' : bill.billNumber}</span>
                      <span className="mx-1.5">•</span>
                      {bill.createdAt.toLocaleDateString()}
                      {bill.createdByProfileName && (
                        <>
                          <span className="mx-1.5">•</span>
                          {bill.createdByProfileName}
                        </>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className={`font-bold whitespace-nowrap text-sm ${
                      draft ? 'text-amber-800' : 'text-sky-900'
                    }`}>
                      {formatINR(calcBillTotal(bill.products))}
                    </span>
                    <ChevronRight className="w-4 h-4 text-slate-300 flex-shrink-0" />
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <EmptyState
          icon={<Receipt />}
          title="No bills yet"
          description="Tap the + button below to create your first bill."
        />
      )}

      <BillViewer
        isOpen={!!liveOpenBill}
        initialMode="view"
        bill={liveOpenBill ?? undefined}
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

interface StatCardProps {
  label: string;
  primary: string;
  secondary?: string;
  accent: 'sky' | 'navy' | 'slate' | 'amber';
}

const accentMap: Record<StatCardProps['accent'], { bar: string; text: string }> = {
  sky:    { bar: 'bg-sky-600',    text: 'text-sky-700' },
  navy:   { bar: 'bg-sky-900',    text: 'text-sky-900' },
  slate:  { bar: 'bg-slate-400',  text: 'text-slate-700' },
  amber:  { bar: 'bg-amber-500',  text: 'text-amber-700' },
};

const StatCard: React.FC<StatCardProps> = ({ label, primary, secondary, accent }) => {
  const c = accentMap[accent];
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-3.5 relative overflow-hidden">
      <div className={`absolute left-0 top-0 bottom-0 w-1 ${c.bar}`} />
      <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${c.text}`}>{primary}</p>
      {secondary && <p className="text-[11px] text-slate-500 mt-0.5">{secondary}</p>}
    </div>
  );
};

export default HomeView;
