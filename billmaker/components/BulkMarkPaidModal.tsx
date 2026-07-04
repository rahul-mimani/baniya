import React, { useEffect, useState, useMemo } from 'react';
import { Bill, Payment } from '../types';
import { CloseIcon, CashIcon, CheckIcon } from './Icons';
import { formatINR } from '../utils/billTotal';
import { billBalance, customerOutstanding } from '../utils/paymentMath';
import { getBills } from '../storage/storage';
import { getPayments, addPayment } from '../storage/paymentStorage';
import { getActiveProfileId, getProfiles } from '../storage/profileStorage';
import { log } from '../utils/diagnostics';

interface BulkMarkPaidModalProps {
  onClose: () => void;
  onChanged: () => void;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

interface CustomerRow {
  name: string;
  outstanding: number;
  billCount: number;
}

const BulkMarkPaidModal: React.FC<BulkMarkPaidModalProps> = ({ onClose, onChanged, showToast }) => {
  const [bills, setBills] = useState<Bill[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [activeProfileName, setActiveProfileName] = useState<string | null>(null);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    (async () => {
      const [b, p, profiles, activeId] = await Promise.all([
        getBills(),
        getPayments(),
        getProfiles(),
        getActiveProfileId(),
      ]);
      setBills(b);
      setPayments(p);
      const active = profiles.find(prof => prof.id === activeId);
      setActiveProfileId(active?.id || null);
      setActiveProfileName(active?.name || null);
    })();
  }, []);

  const customerRows: CustomerRow[] = useMemo(() => {
    const map = new Map<string, CustomerRow>();
    for (const b of bills) {
      const bal = billBalance(b, payments);
      if (bal <= 0.005) continue;
      const cur = map.get(b.customerName) || { name: b.customerName, outstanding: 0, billCount: 0 };
      cur.outstanding += bal;
      cur.billCount += 1;
      map.set(b.customerName, cur);
    }
    const list = Array.from(map.values()).sort((a, b) => b.outstanding - a.outstanding);
    const f = filter.trim().toLowerCase();
    return f ? list.filter(r => r.name.toLowerCase().includes(f)) : list;
  }, [bills, payments, filter]);

  const selectedTotal = useMemo(() => {
    return customerRows
      .filter(r => selected.has(r.name))
      .reduce((s, r) => s + r.outstanding, 0);
  }, [customerRows, selected]);

  const selectedBillCount = useMemo(() => {
    return customerRows
      .filter(r => selected.has(r.name))
      .reduce((s, r) => s + r.billCount, 0);
  }, [customerRows, selected]);

  const toggle = (name: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const selectAll = () => {
    setSelected(new Set(customerRows.map(r => r.name)));
  };

  const handleConfirm = async () => {
    if (busy || selected.size === 0) return;
    setBusy(true);
    let billsProcessed = 0;
    let totalRecorded = 0;
    try {
      for (const customerName of selected) {
        const customerBills = bills.filter(b => b.customerName === customerName);
        for (const b of customerBills) {
          const bal = billBalance(b, payments);
          if (bal <= 0.005) continue;
          const payment: Payment = {
            id: `pay-bulk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            billId: b.id,
            amount: bal,
            receivedAt: new Date(),
            method: 'other',
            note: 'Bulk settlement',
            createdByProfileId: activeProfileId || undefined,
            createdByProfileName: activeProfileName || undefined,
          };
          await addPayment(payment);
          billsProcessed++;
          totalRecorded += bal;
        }
      }
      log('info', 'storage', `Bulk mark-paid: ${billsProcessed} bills, ${formatINR(totalRecorded)} recorded`);
      onChanged();
      showToast(`Settled ${billsProcessed} bills · ${formatINR(totalRecorded)}`);
      onClose();
    } catch (e: any) {
      log('error', 'storage', 'Bulk mark-paid failed', e);
      showToast(`Bulk action failed: ${String(e?.message || e).slice(0, 80)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4 no-print">
      <div
        className="bg-white w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[95vh]"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 8px)' }}
      >
        <div className="px-5 py-4 border-b flex items-center justify-between bg-sky-50">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-sky-100 text-sky-600 flex items-center justify-center flex-shrink-0">
              <CashIcon />
            </div>
            <div className="min-w-0">
              <h2 className="font-bold text-slate-800 leading-tight">Bulk Mark Paid</h2>
              <p className="text-[11px] text-slate-500 leading-tight">
                Settle all outstanding bills for selected customers
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-500 active:text-slate-800 p-1" aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        <div className="px-5 py-3 border-b">
          <input
            type="text"
            placeholder="Filter customers…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-md focus:ring-sky-500 focus:border-sky-500 bg-white text-sm"
          />
          <div className="flex items-center justify-between mt-2 text-xs">
            <button onClick={selectAll} className="text-sky-600 font-semibold active:text-sky-800">
              Select all visible
            </button>
            <button onClick={() => setSelected(new Set())} className="text-slate-500 font-semibold active:text-slate-700">
              Clear selection
            </button>
          </div>
        </div>

        <div className="overflow-y-auto flex-1 max-h-72">
          {customerRows.length === 0 ? (
            <div className="text-center py-8 text-sm text-slate-400 px-5">
              {filter ? 'No customers match the filter.' : 'No customers with outstanding bills. Everyone is paid up.'}
            </div>
          ) : (
            customerRows.map(r => {
              const isSelected = selected.has(r.name);
              return (
                <button
                  key={r.name}
                  onClick={() => toggle(r.name)}
                  className={`w-full px-5 py-3 flex items-center gap-3 border-b border-slate-100 text-left transition ${
                    isSelected ? 'bg-sky-50' : 'active:bg-slate-50'
                  }`}
                >
                  <div className={`w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 transition ${
                    isSelected ? 'bg-sky-600 text-white' : 'bg-slate-100 border border-slate-300'
                  }`}>
                    {isSelected && <CheckIcon />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-slate-800 truncate">{r.name}</p>
                    <p className="text-xs text-slate-500">{r.billCount} bill{r.billCount === 1 ? '' : 's'} outstanding</p>
                  </div>
                  <span className="text-sm font-bold text-rose-600 whitespace-nowrap">
                    {formatINR(r.outstanding)}
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div className="px-5 py-3 border-t bg-slate-50 space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-600">
              {selected.size} customer{selected.size === 1 ? '' : 's'} · {selectedBillCount} bill{selectedBillCount === 1 ? '' : 's'}
            </span>
            <span className="font-bold text-slate-800">{formatINR(selectedTotal)}</span>
          </div>

          {selected.size > 0 && (
            <label className="flex items-start gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={e => setConfirmed(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
              />
              <span>
                I confirm: record a settlement payment for every outstanding bill above. Each payment shows as method <em>Other</em> with note <em>Bulk settlement</em>.
              </span>
            </label>
          )}

          <button
            onClick={handleConfirm}
            disabled={selected.size === 0 || !confirmed || busy}
            className="w-full bg-sky-600 text-white font-bold py-2.5 rounded-md active:bg-sky-700 transition disabled:bg-slate-300 disabled:cursor-not-allowed"
          >
            {busy ? '…' : `Record ${selectedBillCount} settlement payment${selectedBillCount === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
};

export default BulkMarkPaidModal;
