import React, { useMemo, useState } from 'react';
import { Bill } from '../types';
import { CloseIcon, CalendarIcon, DownloadIcon, ShareIcon, StatementIcon, PrintIcon } from './Icons';
import CustomerInput from './CustomerInput';
import { calcBillTotal, formatINR } from '../utils/billTotal';
import { generateBlotterPDF } from '../utils/generateBlotterPDF';
import { FileOpener } from '@capacitor-community/file-opener';

interface BlotterPreviewArgs {
  bills: Bill[];
  customerName: string;
  startDate: Date;
  endDate: Date;
}

interface BlotterModalProps {
  bills: Bill[];
  onClose: () => void;
  showToast: (message: string, type?: 'success' | 'error') => void;
  onPrint: (args: BlotterPreviewArgs) => void;
}

const todayISO = () => new Date().toISOString().slice(0, 10);
const firstOfMonthISO = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
};

const BlotterModal: React.FC<BlotterModalProps> = ({ bills, onClose, showToast, onPrint }) => {
  const [customerName, setCustomerName] = useState('');
  const [startDate, setStartDate] = useState<string>(firstOfMonthISO());
  const [endDate, setEndDate] = useState<string>(todayISO());
  const [busy, setBusy] = useState(false);

  const { matching, total } = useMemo(() => {
    const c = customerName.trim().toLowerCase();
    if (!c || !startDate || !endDate) return { matching: [] as Bill[], total: 0 };
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    const m = bills.filter(b => {
      if (b.customerName.toLowerCase() !== c) return false;
      const t = b.createdAt.getTime();
      return t >= start.getTime() && t <= end.getTime();
    });
    return { matching: m, total: m.reduce((s, b) => s + calcBillTotal(b.products), 0) };
  }, [customerName, startDate, endDate, bills]);

  const canGenerate = matching.length > 0 && !busy;

  const setQuickRange = (kind: 'thisMonth' | 'lastMonth' | 'last30' | 'last90') => {
    const now = new Date();
    let s: Date, e: Date;
    switch (kind) {
      case 'thisMonth':
        s = new Date(now.getFullYear(), now.getMonth(), 1);
        e = now;
        break;
      case 'lastMonth':
        s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        e = new Date(now.getFullYear(), now.getMonth(), 0);
        break;
      case 'last30':
        s = new Date(now);
        s.setDate(s.getDate() - 30);
        e = now;
        break;
      case 'last90':
        s = new Date(now);
        s.setDate(s.getDate() - 90);
        e = now;
        break;
    }
    setStartDate(s.toISOString().slice(0, 10));
    setEndDate(e.toISOString().slice(0, 10));
  };

  const buildArgs = () => ({
    bills: matching,
    customerName: customerName.trim(),
    startDate: new Date(startDate),
    endDate: new Date(endDate),
  });

  const handleSave = async () => {
    if (!canGenerate) return;
    setBusy(true);
    try {
      const { uri } = await generateBlotterPDF(buildArgs());
      await FileOpener.open({ filePath: uri, contentType: 'application/pdf' });
      showToast('Statement generated');
    } catch (e: any) {
      showToast(e?.message || 'Failed to generate statement', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleShare = async () => {
    if (!canGenerate) return;
    setBusy(true);
    try {
      const { uri, fileName } = await generateBlotterPDF(buildArgs());
      const { Share } = await import('@capacitor/share');
      await Share.share({
        title: `${customerName.trim()} - Statement`,
        text: `Statement for ${customerName.trim()} (${matching.length} bills, ${formatINR(total)})`,
        url: uri,
        dialogTitle: `Share ${fileName}`,
      });
    } catch (e: any) {
      if (e?.message && !/cancel/i.test(e.message)) {
        showToast(e.message, 'error');
      }
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
              <StatementIcon />
            </div>
            <div className="min-w-0">
              <h2 className="font-bold text-slate-800 leading-tight">Customer Statement</h2>
              <p className="text-[11px] text-slate-500 leading-tight">Cumulative bill report (A4)</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-500 active:text-slate-800 p-1" aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        <div className="px-5 py-4 space-y-5 overflow-y-auto">
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
              Customer name
            </label>
            <CustomerInput value={customerName} onChange={setCustomerName} />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
              Date range
            </label>
            <div className="grid grid-cols-2 gap-2">
              <div className="relative">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400">
                  <CalendarIcon />
                </span>
                <input
                  type="date"
                  value={startDate}
                  onChange={e => setStartDate(e.target.value)}
                  className="w-full pl-9 pr-2 py-2 border border-slate-300 rounded-md focus:ring-sky-500 focus:border-sky-500 bg-white text-slate-900"
                />
              </div>
              <div className="relative">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400">
                  <CalendarIcon />
                </span>
                <input
                  type="date"
                  value={endDate}
                  onChange={e => setEndDate(e.target.value)}
                  className="w-full pl-9 pr-2 py-2 border border-slate-300 rounded-md focus:ring-sky-500 focus:border-sky-500 bg-white text-slate-900"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-2">
              <QuickRangeChip label="This month" onClick={() => setQuickRange('thisMonth')} />
              <QuickRangeChip label="Last month" onClick={() => setQuickRange('lastMonth')} />
              <QuickRangeChip label="Last 30 days" onClick={() => setQuickRange('last30')} />
              <QuickRangeChip label="Last 90 days" onClick={() => setQuickRange('last90')} />
            </div>
          </div>

          <div className={`rounded-lg p-4 border ${
            matching.length > 0
              ? 'bg-sky-600 border-sky-700 text-white'
              : 'bg-slate-50 border-slate-200 text-slate-600'
          }`}>
            <div className="flex justify-between items-end">
              <div>
                <p className="text-[10px] uppercase tracking-wider font-bold opacity-80">Bills found</p>
                <p className="text-2xl font-bold leading-none mt-1">{matching.length}</p>
              </div>
              <div className="text-right">
                <p className="text-[10px] uppercase tracking-wider font-bold opacity-80">Total</p>
                <p className="text-xl font-bold leading-none mt-1">{formatINR(total)}</p>
              </div>
            </div>
            {customerName.trim() && matching.length === 0 && (
              <p className="text-xs mt-3 opacity-90">
                No bills for "{customerName.trim()}" in the selected range.
              </p>
            )}
          </div>
        </div>

        <div className="px-5 py-3 border-t bg-white flex gap-2">
          <button
            onClick={handleShare}
            disabled={!canGenerate}
            className="flex-1 flex items-center justify-center gap-2 bg-sky-500 text-white font-semibold py-2.5 rounded-md active:bg-sky-600 transition disabled:bg-slate-300 disabled:cursor-not-allowed"
          >
            <ShareIcon />
            Share
          </button>
          <button
            onClick={handleSave}
            disabled={!canGenerate}
            className="flex-1 flex items-center justify-center gap-2 bg-white text-slate-700 border border-slate-300 font-semibold py-2.5 rounded-md active:bg-slate-50 transition disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <DownloadIcon />
            {busy ? '…' : 'Save'}
          </button>
          <button
            onClick={() => {
              if (!canGenerate) return;
              onPrint({
                bills: matching,
                customerName: customerName.trim(),
                startDate: new Date(startDate),
                endDate: new Date(endDate),
              });
              onClose();
            }}
            disabled={!canGenerate}
            className="flex-1 flex items-center justify-center gap-2 bg-sky-600 text-white font-bold py-2.5 rounded-md active:bg-sky-700 transition disabled:bg-slate-300 disabled:cursor-not-allowed"
          >
            <PrintIcon />
            Print
          </button>
        </div>
      </div>
    </div>
  );
};

const QuickRangeChip: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button
    onClick={onClick}
    className="px-2.5 py-1 text-[11px] font-semibold rounded-full bg-slate-100 text-slate-700 active:bg-slate-200 transition"
  >
    {label}
  </button>
);

export default BlotterModal;
