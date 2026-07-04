import React, { useEffect, useState } from 'react';
import { Bill, BusinessInfo } from '../types';
import { PrintIcon, ArrowLeftIcon, DownloadIcon, ShareIcon } from './Icons';
import { generateBlotterPDF } from '../utils/generateBlotterPDF';
import { getBusinessInfo } from '../storage/businessStorage';
import { calcBillTotal, formatINR } from '../utils/billTotal';
import { setBackHandler } from '../utils/backHandler';
import { numberToIndianWords } from '../utils/numberToWords';
import { log } from '../utils/diagnostics';

interface BlotterPreviewProps {
  bills: Bill[];
  customerName: string;
  startDate: Date;
  endDate: Date;
  onBack: () => void;
  showToast?: (message: string, type?: 'success' | 'error') => void;
}

const BlotterPreview: React.FC<BlotterPreviewProps> = ({ bills, customerName, startDate, endDate, onBack, showToast }) => {
  const toast = (msg: string, t: 'success' | 'error' = 'error') => showToast?.(msg, t);
  const [business, setBusiness] = useState<BusinessInfo | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { getBusinessInfo().then(setBusiness); }, []);
  useEffect(() => {
    setBackHandler(() => { onBack(); return true; });
    return () => setBackHandler(null);
  }, [onBack]);

  const sorted = [...bills].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const cumulative = sorted.reduce((s, b) => s + calcBillTotal(b.products), 0);

  const args = { bills, customerName, startDate, endDate };

  const handlePrint = async () => {
    if (busy) return;
    setBusy(true);
    log('info', 'print', `Blotter print (${bills.length} bill(s))`);

    // Preferred: route the generated PDF to NokoPrint / Canon plugin / Mopria via explicit Intent.
    try {
      const { UsbPrinter } = await import('../plugins/usbPrinter');
      const candidates = [
        { pkg: 'com.nokoprint', name: 'NokoPrint' },
        { pkg: 'jp.co.canon.android.printservice.plugin', name: 'Canon Print Service' },
        { pkg: 'com.hp.android.printservice', name: 'HP Print Service' },
        { pkg: 'org.mopria.printplugin', name: 'Mopria' },
      ];
      let target: { pkg: string; name: string } | null = null;
      for (const c of candidates) {
        try {
          const { installed } = await UsbPrinter.isAppInstalled({ packageName: c.pkg });
          if (installed) { target = c; break; }
        } catch {/* ignore */}
      }
      if (target) {
        log('info', 'print', `Blotter → ${target.name} (${target.pkg})`);
        try {
          const { uri } = await generateBlotterPDF(args);
          await UsbPrinter.openPdfInApp({ filePath: uri, packageName: target.pkg });
          log('info', 'print', `Blotter opened in ${target.name}`);
          setBusy(false);
          return;
        } catch (e: any) {
          const msg = String(e?.message || e);
          log('error', 'print', `Blotter handoff to ${target.name} failed`, e);
          toast(`Print failed: ${msg.slice(0, 120)}`);
          setBusy(false);
          return;
        }
      }
      log('info', 'print', 'No known print app installed; using system print dialog');
    } catch (e: any) {
      log('warn', 'print', 'Blotter handoff probe failed', String(e?.message || e));
    }

    // Fallback: system print dialog via window.print()
    const cleanup = () => {
      setBusy(false);
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', () => {
      log('info', 'print', 'afterprint fired (blotter)');
      cleanup();
    });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try {
        window.print();
        log('info', 'print', 'window.print() invoked (blotter)');
      } catch (err) {
        log('error', 'print', 'Blotter window.print() threw', err);
        cleanup();
      }
      setTimeout(cleanup, 4000);
    }));
  };

  const handleSave = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { fileName } = await generateBlotterPDF(args);
      log('info', 'pdf', `Blotter PDF saved: ${fileName}`);
      toast(`Saved: ${fileName}`, 'success');
    } catch (e: any) {
      const msg = String(e?.message || e);
      log('error', 'pdf', 'Blotter PDF generation failed', e);
      toast(`Couldn't build PDF: ${msg.slice(0, 120)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleShare = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { uri, fileName } = await generateBlotterPDF(args);
      const { Share } = await import('@capacitor/share');
      await Share.share({
        title: `${customerName} - Statement`,
        text: `Statement for ${customerName} (${bills.length} bills, ${formatINR(cumulative)})`,
        url: uri,
        dialogTitle: `Share ${fileName}`,
      });
    } catch (e: any) {
      if (e?.message && !/cancel/i.test(e.message)) {
        log('error', 'share', 'Blotter share failed', e);
        toast(`Share failed: ${String(e?.message || e).slice(0, 120)}`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto pb-32">
      <div className="flex justify-between items-center mb-6 no-print gap-2">
        <button onClick={onBack} className="flex items-center gap-1 text-sky-600 active:text-sky-800 font-semibold flex-shrink-0">
          <ArrowLeftIcon />
          <span className="hidden sm:inline">Back</span>
        </button>
        <div className="flex gap-2 flex-wrap justify-end">
          <button
            onClick={handleShare}
            disabled={busy}
            className="flex items-center gap-2 bg-sky-500 text-white font-semibold py-2 px-3 rounded-md active:bg-sky-600 transition disabled:opacity-50"
          >
            <ShareIcon />
            <span className="hidden xs:inline">Share</span>
          </button>
          <button
            onClick={handleSave}
            disabled={busy}
            className="flex items-center gap-2 bg-white text-slate-700 border border-slate-300 font-semibold py-2 px-3 rounded-md active:bg-slate-50 disabled:opacity-50"
          >
            <DownloadIcon />
            <span className="hidden sm:inline">Save PDF</span>
          </button>
          <button
            onClick={handlePrint}
            disabled={busy}
            className="flex items-center gap-2 bg-sky-600 text-white font-bold py-2 px-4 rounded-md active:bg-sky-700 transition disabled:opacity-60"
          >
            <PrintIcon />
            {busy ? '…' : 'Print'}
          </button>
        </div>
      </div>

      <div className="blotter-printable bg-white border-2 border-slate-200 rounded-lg shadow-md mx-auto">
        <div className="bg-sky-600 text-white px-6 py-4 flex justify-between items-start">
          <div className="min-w-0">
            <p className="text-lg font-bold leading-tight truncate">
              {(business && business.name) || 'Customer Statement'}
            </p>
            {business && (business.phone || business.gst) && (
              <p className="text-xs opacity-90 mt-1">
                {business.phone && <span>{business.phone}</span>}
                {business.phone && business.gst && <span className="mx-1.5">•</span>}
                {business.gst && <span>ID: {business.gst}</span>}
              </p>
            )}
            {business && business.address && (
              <p className="text-xs opacity-90 mt-0.5 whitespace-pre-line">{business.address}</p>
            )}
          </div>
          <p className="text-base font-bold tracking-widest ml-3">STATEMENT</p>
        </div>

        <div className="px-6 py-4 grid grid-cols-2 gap-4 border-b border-slate-200">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wider font-bold text-slate-500">Customer</p>
            <p className="text-base font-bold text-slate-800 mt-0.5 truncate">{customerName}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider font-bold text-slate-500">Period</p>
            <p className="text-sm text-slate-800 mt-0.5">
              {startDate.toLocaleDateString()} — {endDate.toLocaleDateString()}
            </p>
          </div>
        </div>

        <div className="px-6 py-4 space-y-4">
          {sorted.map(bill => {
            const total = calcBillTotal(bill.products);
            return (
              <div key={bill.id} className="bill-block">
                <div className="flex justify-between items-baseline mb-2">
                  <p className="font-bold text-sky-700 font-mono">{bill.billNumber}</p>
                  <p className="text-xs text-slate-500">{bill.createdAt.toLocaleDateString()}</p>
                </div>
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-sky-50 text-slate-700 uppercase text-[10px]">
                      <th className="text-left py-1.5 pl-2 font-bold">Item</th>
                      <th className="text-right py-1.5 font-bold w-12">Qty</th>
                      <th className="text-left py-1.5 pl-2 font-bold w-14">Unit</th>
                      <th className="text-right py-1.5 font-bold w-24">Rate</th>
                      <th className="text-right py-1.5 pr-2 font-bold w-28">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bill.products.map(p => {
                      const qty = parseFloat(p.quantity) || 0;
                      const price = parseFloat(p.price) || 0;
                      return (
                        <tr key={p.id}>
                          <td className="py-1 pl-2 text-slate-800">{p.name}</td>
                          <td className="py-1 text-right text-slate-800">{p.quantity}</td>
                          <td className="py-1 pl-2 text-slate-600">{p.prefix}</td>
                          <td className="py-1 text-right text-slate-800">{formatINR(price)}</td>
                          <td className="py-1 pr-2 text-right text-slate-800 font-semibold">{formatINR(qty * price)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div className="flex justify-end mt-1.5 pr-2">
                  <span className="text-sm font-bold text-slate-700">
                    Bill total: <span className="text-sky-700 ml-1">{formatINR(total)}</span>
                  </span>
                </div>
                <div className="border-b border-slate-200 mt-3" />
              </div>
            );
          })}
        </div>

        <div className="px-6 py-4 bg-sky-600 text-white">
          <div className="flex justify-between items-center">
            <p className="text-sm font-bold uppercase tracking-wider">Cumulative Total</p>
            <p className="text-2xl font-bold">{formatINR(cumulative)}</p>
          </div>
          <p className="text-xs mt-2 opacity-90">
            <span className="font-semibold uppercase tracking-wider mr-2">In words:</span>
            {numberToIndianWords(cumulative)}
          </p>
        </div>

        <div className="px-6 py-3 bg-slate-50 border-t border-slate-200 flex justify-between items-center text-xs text-slate-500">
          <span>{bills.length} bills · Generated {new Date().toLocaleDateString()}</span>
          <span className="text-sky-700 font-bold">Thank you for your business</span>
        </div>
      </div>
    </div>
  );
};

export default BlotterPreview;
