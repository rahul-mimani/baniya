import React, { useState } from 'react';
import { Bill, Payment, PaymentMethod, Profile } from '../types';
import { CloseIcon, CashIcon } from './Icons';
import { formatINR } from '../utils/billTotal';
import { billTotal, billBalance } from '../utils/paymentMath';

interface AddPaymentModalProps {
  bill: Bill;
  existingPayments: Payment[];
  activeProfile: Profile | null;
  onClose: () => void;
  onSave: (payment: Payment) => Promise<void>;
}

const METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'card', label: 'Card' },
  { value: 'bank', label: 'Bank' },
  { value: 'other', label: 'Other' },
];

const todayISO = () => new Date().toISOString().slice(0, 10);

// Combine the user's selected date (YYYY-MM-DD) with the CURRENT time of day.
// `new Date('2026-05-20')` would produce midnight UTC — which collapses every
// same-day payment to the same instant and breaks the auth-service's
// incremental sync cursor on `receivedAt`. By layering current hh:mm:ss onto
// the chosen date, consecutive payments same-day get unique, sortable timestamps.
const buildReceivedAt = (yyyyMmDd: string): Date => {
  const now = new Date();
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  if (!y || !m || !d) return now;
  return new Date(
    y,
    m - 1,
    d,
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
    now.getMilliseconds(),
  );
};

const AddPaymentModal: React.FC<AddPaymentModalProps> = ({
  bill,
  existingPayments,
  activeProfile,
  onClose,
  onSave,
}) => {
  const total = billTotal(bill);
  const outstanding = billBalance(bill, existingPayments);

  const [amount, setAmount] = useState<string>(outstanding > 0 ? outstanding.toFixed(2) : '');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [date, setDate] = useState<string>(todayISO());
  const [note, setNote] = useState<string>('');
  const [saving, setSaving] = useState(false);

  const amountNum = parseFloat(amount);
  const overpay = !isNaN(amountNum) && amountNum > outstanding + 0.005;
  const valid = !isNaN(amountNum) && amountNum > 0 && !!date;

  const handleSave = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      const payment: Payment = {
        id: `pay-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        billId: bill.id,
        amount: amountNum,
        receivedAt: buildReceivedAt(date),
        method,
        note: note.trim() || undefined,
        createdByProfileId: activeProfile?.id,
        createdByProfileName: activeProfile?.name,
      };
      await onSave(payment);
      onClose();
    } catch {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4 no-print">
      <div
        className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[95vh]"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 8px)' }}
      >
        <div className="px-5 py-4 border-b flex items-center justify-between bg-sky-50">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-sky-100 text-sky-600 flex items-center justify-center flex-shrink-0">
              <CashIcon />
            </div>
            <div className="min-w-0">
              <h2 className="font-bold text-slate-800 leading-tight">Add payment</h2>
              <p className="text-[11px] text-slate-500 leading-tight truncate">
                <span className="font-mono">{bill.billNumber}</span> · {bill.customerName}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-500 active:text-slate-800 p-1" aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 overflow-y-auto">
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Bill total" value={formatINR(total)} />
            <Stat label="Paid" value={formatINR(total - outstanding)} />
            <Stat label="Balance" value={formatINR(outstanding)} highlight />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
              Amount received
            </label>
            <div className="relative">
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={e => {
                  const v = e.target.value;
                  if (/^\d*\.?\d*$/.test(v)) setAmount(v);
                }}
                onFocus={e => e.target.select()}
                placeholder="0.00"
                className="w-full pl-3 pr-12 py-3 border border-slate-300 rounded-md focus:ring-sky-500 focus:border-sky-500 bg-white text-slate-900 text-lg font-bold text-right"
              />
              <span className="absolute inset-y-0 right-0 flex items-center pr-3 text-slate-500 text-sm font-semibold">INR</span>
            </div>
            {overpay && (
              <p className="text-xs text-amber-700 mt-1">
                Amount is greater than the outstanding balance. The bill will be marked paid in full.
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
              Method
            </label>
            <div className="grid grid-cols-5 gap-1.5">
              {METHODS.map(m => (
                <button
                  key={m.value}
                  onClick={() => setMethod(m.value)}
                  className={`py-2 px-1 rounded-md text-xs font-semibold transition ${
                    method === m.value
                      ? 'bg-sky-500 text-white'
                      : 'bg-white text-slate-700 border border-slate-300'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
              Date received
            </label>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-md focus:ring-sky-500 focus:border-sky-500 bg-white text-slate-900"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
              Note (optional)
            </label>
            <textarea
              rows={2}
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="e.g. partial payment, cheque number, etc."
              className="w-full px-3 py-2 border border-slate-300 rounded-md focus:ring-sky-500 focus:border-sky-500 bg-white text-slate-900 resize-none"
            />
          </div>
        </div>

        <div className="px-5 py-3 border-t bg-white flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 bg-white text-slate-700 border border-slate-300 font-semibold py-2.5 rounded-md active:bg-slate-50 transition"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!valid || saving}
            className="flex-1 bg-sky-600 text-white font-bold py-2.5 rounded-md active:bg-sky-700 transition disabled:bg-slate-300 disabled:cursor-not-allowed"
          >
            {saving ? '…' : 'Save payment'}
          </button>
        </div>
      </div>
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string; highlight?: boolean }> = ({ label, value, highlight }) => (
  <div className={`rounded-md border px-2 py-2 ${highlight ? 'bg-sky-50 border-sky-300' : 'bg-slate-50 border-slate-200'}`}>
    <p className="text-[9px] uppercase tracking-wider font-bold text-slate-500">{label}</p>
    <p className={`text-sm font-bold mt-0.5 truncate ${highlight ? 'text-sky-700' : 'text-slate-800'}`}>{value}</p>
  </div>
);

export default AddPaymentModal;
