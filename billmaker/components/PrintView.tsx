import React, { useState, useMemo, useEffect } from 'react';
import { Bill } from '../types';
import { SearchIcon, PrintIcon, CheckIcon, StatementIcon } from './Icons';
import PrintPreview from './PrintPreview';
import PrintOptionsModal, { PaperSize, PrintAction } from './PrintOptionsModal';
import BlotterModal from './BlotterModal';
import BlotterPreview from './BlotterPreview';
import { calcBillTotal, formatINR } from '../utils/billTotal';
import { setBackHandler } from '../utils/backHandler';
import { useUsbPrinter } from '../hooks/useUsbPrinter';
import UsbPrinterStatus from './UsbPrinterStatus';

interface PrintViewProps {
  bills: Bill[];
  showToast: (message: string, type?: 'success' | 'error') => void;
}

interface PreviewConfig {
  bills: Bill[];
  action: PrintAction;
  paperSize: PaperSize;
}

interface BlotterPreviewConfig {
  bills: Bill[];
  customerName: string;
  startDate: Date;
  endDate: Date;
}

const PrintView: React.FC<PrintViewProps> = ({ bills, showToast }) => {
  const [previewConfig, setPreviewConfig] = useState<PreviewConfig | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedBillIds, setSelectedBillIds] = useState<Set<string>>(new Set());
  const [showOptions, setShowOptions] = useState(false);
  const [showBlotter, setShowBlotter] = useState(false);
  const [blotterPreview, setBlotterPreview] = useState<BlotterPreviewConfig | null>(null);
  const usb = useUsbPrinter();

  // Hardware back: close preview > close options > clear selection
  useEffect(() => {
    setBackHandler(() => {
      if (previewConfig) {
        setPreviewConfig(null);
        return true;
      }
      if (blotterPreview) {
        setBlotterPreview(null);
        return true;
      }
      if (showBlotter) {
        setShowBlotter(false);
        return true;
      }
      if (showOptions) {
        setShowOptions(false);
        return true;
      }
      if (selectedBillIds.size > 0) {
        setSelectedBillIds(new Set());
        return true;
      }
      return false;
    });
    return () => setBackHandler(null);
  }, [previewConfig, showOptions, showBlotter, blotterPreview, selectedBillIds]);

  const handleToggleSelection = (billId: string) => {
    setSelectedBillIds(prev => {
      const next = new Set(prev);
      if (next.has(billId)) next.delete(billId); else next.add(billId);
      return next;
    });
  };

  const groupedBills = useMemo(() => {
    let filtered = [...bills];
    if (searchTerm.trim()) {
      filtered = filtered.filter(b => b.customerName.toLowerCase().includes(searchTerm.toLowerCase()));
    }
    filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const groups: { [key: string]: Bill[] } = {};
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);

    const isSameDay = (d1: Date, d2: Date) =>
      d1.getFullYear() === d2.getFullYear() &&
      d1.getMonth() === d2.getMonth() &&
      d1.getDate() === d2.getDate();

    for (const bill of filtered) {
      let groupName: string;
      if (isSameDay(bill.createdAt, today)) groupName = 'Today';
      else if (isSameDay(bill.createdAt, yesterday)) groupName = 'Yesterday';
      else groupName = bill.createdAt.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

      if (!groups[groupName]) groups[groupName] = [];
      groups[groupName].push(bill);
    }
    return groups;
  }, [bills, searchTerm]);

  const orderedGroupKeys = useMemo(() => {
    const fixed = ['Today', 'Yesterday'];
    const dateKeys = Object.keys(groupedBills)
      .filter(k => !fixed.includes(k))
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
    return [...fixed.filter(k => groupedBills[k]), ...dateKeys];
  }, [groupedBills]);

  const selectionStats = useMemo(() => {
    const selected = bills.filter(b => selectedBillIds.has(b.id));
    const total = selected.reduce((s, b) => s + calcBillTotal(b.products), 0);
    return { selected, total };
  }, [bills, selectedBillIds]);

  const handleSelectAllInGroup = (groupKey: string) => {
    const groupBills = groupedBills[groupKey] || [];
    const allSelected = groupBills.every(b => selectedBillIds.has(b.id));
    setSelectedBillIds(prev => {
      const next = new Set(prev);
      if (allSelected) groupBills.forEach(b => next.delete(b.id));
      else groupBills.forEach(b => next.add(b.id));
      return next;
    });
  };

  const handleConfirmPrint = (action: PrintAction, paperSize: PaperSize) => {
    const selected = bills
      .filter(b => selectedBillIds.has(b.id))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    setShowOptions(false);
    if (selected.length > 0) setPreviewConfig({ bills: selected, action, paperSize });
  };

  if (previewConfig) {
    return (
      <PrintPreview
        bills={previewConfig.bills}
        action={previewConfig.action}
        paperSize={previewConfig.paperSize}
        onBack={() => setPreviewConfig(null)}
        showToast={showToast}
      />
    );
  }

  if (blotterPreview) {
    return (
      <BlotterPreview
        bills={blotterPreview.bills}
        customerName={blotterPreview.customerName}
        startDate={blotterPreview.startDate}
        endDate={blotterPreview.endDate}
        onBack={() => setBlotterPreview(null)}
        showToast={showToast}
      />
    );
  }

  const hasSelection = selectedBillIds.size > 0;

  return (
    <div className="max-w-4xl mx-auto pb-32">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800">Print Bills</h2>
          <p className="text-xs text-slate-500 mt-0.5">Pick the bills you want to print or save as PDF</p>
        </div>
      </div>

      <div className="mb-4">
        <UsbPrinterStatus printers={usb.printers} supported={usb.supported} />
      </div>

      <button
        onClick={() => setShowBlotter(true)}
        className="w-full mb-4 bg-white border border-sky-200 rounded-lg shadow-sm p-3 flex items-center gap-3 active:bg-sky-50 transition text-left"
      >
        <div className="w-10 h-10 rounded-lg bg-sky-100 text-sky-600 flex items-center justify-center flex-shrink-0">
          <StatementIcon />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-slate-800 leading-tight">Customer Statement</p>
          <p className="text-xs text-slate-500 leading-tight mt-0.5">
            Cumulative bill by customer + date range • A4 with page numbers
          </p>
        </div>
        <span className="text-sky-600 font-bold text-xl flex-shrink-0">›</span>
      </button>

      <div className="relative mb-4">
        <span className="absolute inset-y-0 left-0 flex items-center pl-3">
          <SearchIcon />
        </span>
        <input
          type="text"
          placeholder="Search by customer name..."
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          className="w-full py-3 pl-10 pr-4 border border-slate-300 rounded-lg focus:ring-sky-500 focus:border-sky-500 bg-white"
        />
      </div>

      <div className="space-y-6">
        {orderedGroupKeys.length > 0 ? (
          orderedGroupKeys.map(groupName => {
            const groupBills = groupedBills[groupName];
            const allSelected = groupBills.every(b => selectedBillIds.has(b.id));
            const groupTotal = groupBills.reduce((s, b) => s + calcBillTotal(b.products), 0);
            return (
              <div key={groupName}>
                <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-200">
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                      groupName === 'Today' ? 'bg-sky-100 text-sky-700' :
                      groupName === 'Yesterday' ? 'bg-amber-100 text-amber-700' :
                      'bg-slate-100 text-slate-600'
                    }`}>
                      {groupName}
                    </span>
                    <span className="text-xs text-slate-500">
                      {groupBills.length} bill{groupBills.length === 1 ? '' : 's'} · {formatINR(groupTotal)}
                    </span>
                  </div>
                  <button
                    onClick={() => handleSelectAllInGroup(groupName)}
                    className="text-xs font-semibold text-sky-600 active:text-sky-700"
                  >
                    {allSelected ? 'Clear' : 'Select all'}
                  </button>
                </div>
                <div className="space-y-2">
                  {groupBills.map(bill => {
                    const isSelected = selectedBillIds.has(bill.id);
                    return (
                      <div
                        key={bill.id}
                        onClick={() => handleToggleSelection(bill.id)}
                        className={`relative bg-white rounded-lg transition cursor-pointer flex items-center gap-3 p-3 border-2 ${
                          isSelected
                            ? 'border-sky-500 shadow-md'
                            : 'border-transparent shadow-sm active:bg-slate-50'
                        }`}
                      >
                        <div className={`w-6 h-6 rounded-md flex-shrink-0 flex items-center justify-center transition ${
                          isSelected ? 'bg-sky-500 text-white' : 'bg-slate-100 border border-slate-300'
                        }`}>
                          {isSelected && <CheckIcon />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-slate-800 truncate">{bill.customerName}</p>
                          <p className="text-xs text-slate-500 mt-0.5">
                            <span className="font-mono">{bill.billNumber}</span>
                            <span className="mx-1.5">·</span>
                            {bill.products.length} item{bill.products.length === 1 ? '' : 's'}
                            {bill.createdByProfileName && (
                              <>
                                <span className="mx-1.5">·</span>
                                {bill.createdByProfileName}
                              </>
                            )}
                          </p>
                        </div>
                        <span className={`font-bold whitespace-nowrap ${isSelected ? 'text-sky-700' : 'text-slate-800'}`}>
                          {formatINR(calcBillTotal(bill.products))}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })
        ) : (
          <div className="text-center py-12 bg-white rounded-lg shadow-sm">
            <p className="text-slate-500">No bills found.</p>
          </div>
        )}
      </div>

      {hasSelection && (
        <div className="bottom-fab no-print">
          <button
            onClick={() => setShowOptions(true)}
            className="flex items-center gap-3 bg-sky-600 text-white font-bold py-3 px-5 rounded-full shadow-lg active:bg-sky-700 active:scale-95 transition"
          >
            <PrintIcon />
            <span>
              Print ({selectedBillIds.size})
              <span className="ml-2 opacity-80 text-sm font-semibold">{formatINR(selectionStats.total)}</span>
            </span>
          </button>
        </div>
      )}

      {showOptions && (
        <PrintOptionsModal
          count={selectionStats.selected.length}
          totalAmount={selectionStats.total}
          onClose={() => setShowOptions(false)}
          onConfirm={handleConfirmPrint}
        />
      )}

      {showBlotter && (
        <BlotterModal
          bills={bills}
          onClose={() => setShowBlotter(false)}
          showToast={showToast}
          onPrint={args => setBlotterPreview(args)}
        />
      )}
    </div>
  );
};

export default PrintView;
