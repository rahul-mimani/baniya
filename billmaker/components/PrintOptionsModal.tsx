import React, { useState } from 'react';
import { CloseIcon, PrintIcon, DownloadIcon } from './Icons';
import { formatINR } from '../utils/billTotal';
import { useUsbPrinter } from '../hooks/useUsbPrinter';
import UsbPrinterStatus from './UsbPrinterStatus';

export type PaperSize = 'A4' | 'QUARTER';
export type PrintAction = 'system' | 'pdf';

interface PrintOptionsModalProps {
  count: number;
  totalAmount: number;
  onClose: () => void;
  onConfirm: (action: PrintAction, paperSize: PaperSize) => void;
}

const PrintOptionsModal: React.FC<PrintOptionsModalProps> = ({ count, totalAmount, onClose, onConfirm }) => {
  const [paperSize, setPaperSize] = useState<PaperSize>('A4');
  const usb = useUsbPrinter();

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4 no-print">
      <div
        className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 8px)' }}
      >
        <div className="px-5 py-4 border-b flex items-center justify-between">
          <h2 className="font-bold text-slate-800 text-lg">Print options</h2>
          <button onClick={onClose} className="text-slate-400 active:text-slate-700 p-1" aria-label="Close">
            <CloseIcon />
          </button>
        </div>

        <div className="px-5 py-4 space-y-5">
          <div className="bg-slate-50 rounded-lg px-4 py-3 flex items-center justify-between">
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wide">Selected</p>
              <p className="font-bold text-slate-800">{count} bill{count === 1 ? '' : 's'}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Total</p>
              <p className="font-bold text-sky-700">{formatINR(totalAmount)}</p>
            </div>
          </div>

          <UsbPrinterStatus printers={usb.printers} supported={usb.supported} />

          <div>
            <p className="text-sm font-semibold text-slate-700 mb-2">Paper size</p>
            <div className="grid grid-cols-2 gap-2">
              <PaperOption
                active={paperSize === 'A4'}
                onClick={() => setPaperSize('A4')}
                title="A4"
                hint="210 × 297 mm"
              />
              <PaperOption
                active={paperSize === 'QUARTER'}
                onClick={() => setPaperSize('QUARTER')}
                title="Quarter A4"
                hint="4 bills per A4"
              />
            </div>
          </div>

          <div className="space-y-2 pt-2">
            <button
              onClick={() => onConfirm('system', paperSize)}
              className="w-full flex items-center justify-center gap-2 bg-sky-500 text-white font-bold py-3 rounded-md active:bg-sky-600 transition"
            >
              <PrintIcon />
              Print — choose printer
            </button>
            <button
              onClick={() => onConfirm('pdf', paperSize)}
              className="w-full flex items-center justify-center gap-2 bg-white text-slate-700 font-semibold py-3 rounded-md border border-slate-300 active:bg-slate-50 transition"
            >
              <DownloadIcon />
              Save PDF to device
            </button>
          </div>

          <p className="text-xs text-slate-500 leading-relaxed">
            "Print" opens Android's system print dialog where you can pick any installed printer, save as PDF, or send to a connected device.
          </p>
        </div>
      </div>
    </div>
  );
};

interface PaperOptionProps {
  active: boolean;
  onClick: () => void;
  title: string;
  hint: string;
}

const PaperOption: React.FC<PaperOptionProps> = ({ active, onClick, title, hint }) => (
  <button
    onClick={onClick}
    className={`p-3 rounded-md border-2 text-left transition ${
      active ? 'border-sky-500 bg-sky-50' : 'border-slate-200 bg-white active:bg-slate-50'
    }`}
  >
    <p className={`font-semibold ${active ? 'text-sky-700' : 'text-slate-800'}`}>{title}</p>
    <p className="text-xs text-slate-500 mt-0.5">{hint}</p>
  </button>
);

export default PrintOptionsModal;
