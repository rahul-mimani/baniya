import React, { useEffect, useState } from 'react';
import { Bill, BusinessInfo } from '../types';
import { PrintIcon, ArrowLeftIcon, DownloadIcon, ShareIcon } from './Icons';
import { generateBillsPDF, generateBillsPDFForShare } from '../utils/generateBillsPDF';
import { getBusinessInfo } from '../storage/businessStorage';
import { calcBillTotal, formatINR } from '../utils/billTotal';
import { setBackHandler } from '../utils/backHandler';
import { numberToIndianWords } from '../utils/numberToWords';
import { log } from '../utils/diagnostics';
import type { PaperSize, PrintAction } from './PrintOptionsModal';

interface PrintPreviewProps {
  bills: Bill[];
  action: PrintAction;
  paperSize: PaperSize;
  onBack: () => void;
  showToast?: (message: string, type?: 'success' | 'error') => void;
}

const PrintPreview: React.FC<PrintPreviewProps> = ({ bills, action, paperSize, onBack, showToast }) => {
  const toast = (msg: string, t: 'success' | 'error' = 'error') => showToast?.(msg, t);
  const [business, setBusiness] = useState<BusinessInfo | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getBusinessInfo().then(setBusiness);
  }, []);

  useEffect(() => {
    setBackHandler(() => { onBack(); return true; });
    return () => setBackHandler(null);
  }, [onBack]);

  const handleAction = async (mode: PrintAction) => {
    if (busy) return;
    setBusy(true);
    try {
      if (mode === 'system') {
        // Preferred path: if NokoPrint (or another known print app) is installed, generate the
        // PDF and hand it off via Intent.ACTION_VIEW. This works for USB-C printers that
        // Android's built-in print framework can't reach.
        const result = await tryHandoffToPrintApp(bills, paperSize, /*share*/ false);
        if (result === 'handed' || result === 'failed') {
          // 'handed' = NokoPrint opened; 'failed' = toast already shown. Either way, stop here.
          setBusy(false);
          return;
        }
        // result === 'no-app' → fall through to window.print()

        log('info', 'print', `Print → system dialog (${bills.length} bill(s), paper=${paperSize})`);
        const cleanup = () => {
          setBusy(false);
          window.removeEventListener('afterprint', cleanup);
        };
        window.addEventListener('afterprint', () => {
          log('info', 'print', 'afterprint fired');
          cleanup();
        });
        requestAnimationFrame(() => requestAnimationFrame(() => {
          try {
            window.print();
            log('info', 'print', 'window.print() invoked');
          } catch (err) {
            log('error', 'print', 'window.print() threw', err);
            cleanup();
          }
          setTimeout(cleanup, 4000);
        }));
      } else {
        log('info', 'print', `Save PDF (${bills.length} bill(s), paper=${paperSize})`);
        try {
          const result = await generateBillsPDF(bills, { paperSize });
          log('info', 'print', `PDF saved to disk: ${result.uri}`);
          // generateBillsPDF prefers the public Downloads folder; if the URI
          // is under /storage/.../Download/ we tell the user where to look.
          const inDownloads = /\/Download\//i.test(result.uri);
          toast(
            inDownloads
              ? `Saved to Downloads · ${result.fileName}`
              : `Saved · ${result.fileName}`,
            'success',
          );
        } catch (err: any) {
          const msg = String(err?.message || err);
          log('error', 'print', 'Save PDF failed', err);
          toast(`Save PDF failed: ${msg.slice(0, 120)}`);
        }
        setBusy(false);
      }
    } catch (e: any) {
      const msg = String(e?.message || e);
      log('error', 'print', 'Print action failed', e);
      toast(`Print failed: ${msg.slice(0, 120)}`);
      setBusy(false);
    }
  };

  const tryHandoffToPrintApp = async (
    billsToPrint: Bill[],
    paper: PaperSize,
    _share: boolean,
  ): Promise<'handed' | 'no-app' | 'failed'> => {
    let UsbPrinter: any;
    try {
      const mod = await import('../plugins/usbPrinter');
      UsbPrinter = mod.UsbPrinter;
    } catch (e: any) {
      log('error', 'print', 'usbPrinter plugin import failed', e);
      return 'failed';
    }

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
      } catch {
        // ignore — keep probing
      }
    }
    if (!target) {
      log('info', 'print', 'No known print app installed; using system print dialog');
      return 'no-app';
    }

    log('info', 'print', `Routing PDF to ${target.name} (${target.pkg}, paper=${paper})`);
    try {
      const { uri } = await generateBillsPDFForShare(billsToPrint, { paperSize: paper });
      log('info', 'print', `PDF written: ${uri}`);
      try {
        await UsbPrinter.openPdfInApp({ filePath: uri, packageName: target.pkg });
        log('info', 'print', `PDF opened in ${target.name}`);
        return 'handed';
      } catch (e: any) {
        const msg = String(e?.message || e);
        log('error', 'print', `${target.name} could not open the PDF`, e);
        toast(`${target.name} failed to open the PDF: ${msg.slice(0, 100)}`);
        return 'failed';
      }
    } catch (e: any) {
      const msg = String(e?.message || e);
      log('error', 'print', 'PDF generation failed before handoff', e);
      toast(`Couldn't build the PDF: ${msg.slice(0, 100)}`);
      return 'failed';
    }
  };

  const handleShare = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { uri, fileName } = await generateBillsPDFForShare(bills, { paperSize });
      const { Share } = await import('@capacitor/share');
      const title =
        bills.length === 1
          ? `Bill ${bills[0].billNumber} - ${bills[0].customerName}`
          : `${bills.length} bills`;
      const text =
        bills.length === 1
          ? `${bills[0].customerName} - ${formatINR(calcBillTotal(bills[0].products))}`
          : `${bills.length} bills, total ${formatINR(bills.reduce((s, b) => s + calcBillTotal(b.products), 0))}`;
      await Share.share({
        title,
        text,
        url: uri,
        dialogTitle: `Share ${fileName}`,
      });
    } catch (e: any) {
      if (e?.message && !/cancel/i.test(e.message)) {
        log('error', 'share', 'Share failed', e);
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
            onClick={() => handleAction('pdf')}
            disabled={busy}
            className="flex items-center gap-2 bg-white text-slate-700 border border-slate-300 font-semibold py-2 px-3 rounded-md active:bg-slate-50 disabled:opacity-50"
          >
            <DownloadIcon />
            <span className="hidden sm:inline">Save PDF</span>
          </button>
          <button
            onClick={() => handleAction(action)}
            disabled={busy}
            className="flex items-center gap-2 bg-sky-600 text-white font-bold py-2 px-4 rounded-md active:bg-sky-700 transition disabled:opacity-60"
          >
            <PrintIcon />
            {busy ? 'Working…' : action === 'system' ? `Print (${bills.length})` : `Save (${bills.length})`}
          </button>
        </div>
      </div>

      <div className="space-y-8">
        {bills.map(bill => {
          const grandTotal = calcBillTotal(bill.products);
          // On-screen preview now mirrors the printed PDF: black-on-white,
          // bold lines, no color fills. What you see is what prints.
          return (
            <div key={bill.id} className="printable-bill bg-white border-2 border-black mx-auto overflow-hidden text-black">
              <div className="px-6 py-4 border-b-2 border-black flex justify-between items-start">
                <div className="min-w-0">
                  <p className="text-lg font-bold leading-tight truncate">
                    {(business && business.name) || 'Bill Summary'}
                  </p>
                  {business && business.gst && (
                    <p className="text-xs font-bold mt-1">ID: {business.gst}</p>
                  )}
                  {business && business.address && (
                    <p className="text-xs font-bold mt-0.5 whitespace-pre-line">{business.address}</p>
                  )}
                </div>
                <p className="text-sm font-bold tracking-widest ml-3 whitespace-nowrap">BILL SUMMARY</p>
              </div>

              {/* Compact meta row — bill# left, customer right, customer
                  in larger bold so it stands out. */}
              <div className="px-6 py-3 grid grid-cols-3 gap-4 border-b-2 border-black">
                <div>
                  <p className="text-[10px] uppercase tracking-wider font-bold">Bill No.</p>
                  <p className="text-xs font-bold font-mono mt-0.5">{bill.billNumber}</p>
                </div>
                <div className="text-center">
                  <p className="text-[10px] uppercase tracking-wider font-bold">Date</p>
                  <p className="text-xs font-bold mt-0.5">{bill.createdAt.toLocaleDateString()}</p>
                </div>
                <div className="min-w-0 text-right">
                  <p className="text-[10px] uppercase tracking-wider font-bold">Customer</p>
                  <p className="text-sm font-bold truncate mt-0.5 uppercase">{bill.customerName}</p>
                </div>
              </div>

              <div className="px-6 py-4">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="text-xs uppercase tracking-wider border-b-2 border-black">
                      <th className="text-left py-2 pl-2 font-bold w-8">#</th>
                      <th className="text-left py-2 font-bold">Item</th>
                      <th className="text-right py-2 font-bold w-16">Qty</th>
                      <th className="text-left py-2 pl-3 font-bold w-16">Unit</th>
                      <th className="text-right py-2 font-bold w-24">Rate</th>
                      <th className="text-right py-2 pr-2 font-bold w-28">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bill.products.map((p, i) => {
                      const quantity = parseFloat(p.quantity) || 0;
                      const price = parseFloat(p.price) || 0;
                      const total = quantity * price;
                      return (
                        <tr key={p.id} className="border-b border-black">
                          <td className="py-2 pl-2 font-bold">{i + 1}</td>
                          <td className="py-2 font-bold uppercase break-words">{p.name}</td>
                          <td className="py-2 text-right font-bold">{p.quantity}</td>
                          <td className="py-2 pl-3 font-bold">{p.prefix}</td>
                          <td className="py-2 text-right font-bold">{formatINR(price)}</td>
                          <td className="py-2 pr-2 text-right font-bold">{formatINR(total)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                {/* Totals — no background fill; thick black rules above + below. */}
                <div className="flex justify-end mt-4">
                  <div className="w-64">
                    <div className="flex justify-between text-sm font-bold py-1">
                      <span>Subtotal</span>
                      <span>{formatINR(grandTotal)}</span>
                    </div>
                    <div className="flex justify-between px-3 py-2 mt-1 border-t-2 border-b-4 border-black border-double">
                      <span className="font-bold text-base">Grand Total</span>
                      <span className="font-bold text-base">{formatINR(grandTotal)}</span>
                    </div>
                  </div>
                </div>

                <div className="mt-5 pt-4 border-t-2 border-black">
                  <p className="text-[10px] uppercase tracking-wider font-bold">Amount in words</p>
                  <p className="text-sm font-bold mt-1">{numberToIndianWords(grandTotal)}</p>
                </div>
              </div>

              <div className="px-6 py-3 border-t-2 border-black flex justify-between items-center text-xs font-bold">
                <div>
                  {bill.createdByProfileName && <>Generated by <span>{bill.createdByProfileName}</span> • </>}
                  Issued {bill.createdAt.toLocaleString()}
                </div>
                <p>Thank you for your business</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default PrintPreview;
