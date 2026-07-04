import React, { useMemo, useState } from 'react';
import { PrintIcon, DownloadIcon, ShareIcon, TrashIcon } from './Icons';
import { useUsbPrinter } from '../hooks/useUsbPrinter';
import UsbPrinterStatus from './UsbPrinterStatus';
import {
  exportDiagnostics,
  generateTestPrintPDF,
  downloadLogs,
  clearLogs,
  log,
} from '../utils/diagnostics';
import { FileOpener } from '@capacitor-community/file-opener';

// pdf-lib + capacitor plugin versions (kept in sync with package.json by hand).
const CAPACITOR_PLUGINS = [
  '@capacitor/app',
  '@capacitor/browser',
  '@capacitor/filesystem',
  '@capacitor/share',
  '@capacitor-community/file-opener',
];

const APP_VERSION = '0.0.0'; // matches package.json

interface Props {
  showToast: (message: string, type?: 'success' | 'error') => void;
}

const PrinterDiagnostics: React.FC<Props> = ({ showToast }) => {
  const usb = useUsbPrinter();
  const [busy, setBusy] = useState<'idle' | 'test' | 'download' | 'export' | 'share' | 'clear'>('idle');

  const usbSnapshot = useMemo(() => ({
    supported: usb.supported,
    printers: usb.printers.map(p => ({
      name: p.productName || p.manufacturerName || '(no name)',
      vendorId: p.vendorId,
      productId: p.productId,
    })),
  }), [usb]);

  const handleTestPrint = async () => {
    if (busy !== 'idle') return;
    setBusy('test');
    try {
      const { uri } = await generateTestPrintPDF(APP_VERSION);
      try {
        await FileOpener.open({ filePath: uri, contentType: 'application/pdf' });
        log('info', 'print', 'Test PDF opened in viewer');
        showToast('Test PDF opened — print from the viewer');
      } catch (e: any) {
        log('error', 'print', 'FileOpener.open failed for test PDF', e);
        showToast('Could not open test PDF — see logs', 'error');
      }
    } catch (e: any) {
      showToast(e?.message || 'Test print failed', 'error');
    } finally {
      setBusy('idle');
    }
  };

  // Plain log download — rolling log file (up to ~10k lines) as a text file.
  //   - Web: triggers a real Blob download → browser's Downloads folder.
  //   - Native: pops Share sheet so user can save to Downloads / share.
  // No FileOpener fallback needed — the underlying downloadLogs() handles both.
  const handleDownloadLogs = async () => {
    if (busy !== 'idle') return;
    setBusy('download');
    try {
      const file = await downloadLogs();
      showToast(`Saved ${file.fileName}`);
    } catch (e: any) {
      log('error', 'general', 'downloadLogs failed', e);
      showToast(e?.message || 'Download failed', 'error');
    } finally {
      setBusy('idle');
    }
  };

  // Full diagnostics report — log file + device info + USB snapshot. Used
  // when reporting an issue to a developer.
  const handleExport = async () => {
    if (busy !== 'idle') return;
    setBusy('export');
    try {
      const file = await exportDiagnostics({
        appVersion: APP_VERSION,
        usb: usbSnapshot,
        capacitorPlugins: CAPACITOR_PLUGINS,
      });
      try {
        await FileOpener.open({ filePath: file.uri, contentType: 'text/plain' });
      } catch { /* viewer may not handle .txt */ }
      showToast(`Saved ${file.fileName}`);
    } catch (e: any) {
      log('error', 'general', 'Diagnostics export failed', e);
      showToast(e?.message || 'Export failed', 'error');
    } finally {
      setBusy('idle');
    }
  };

  const handleShareDiagnostics = async () => {
    if (busy !== 'idle') return;
    setBusy('share');
    try {
      const file = await exportDiagnostics({
        appVersion: APP_VERSION,
        usb: usbSnapshot,
        capacitorPlugins: CAPACITOR_PLUGINS,
      });
      const { Share } = await import('@capacitor/share');
      await Share.share({
        title: 'BillMaker diagnostics',
        text: 'Diagnostics report from BillMaker',
        url: file.uri,
        dialogTitle: `Share ${file.fileName}`,
      });
    } catch (e: any) {
      if (e?.message && !/cancel/i.test(e.message)) {
        log('error', 'share', 'Diagnostics share failed', e);
        showToast(e?.message || 'Share failed', 'error');
      }
    } finally {
      setBusy('idle');
    }
  };

  const handleClear = async () => {
    if (!window.confirm('Clear the log file? This deletes the rolling 10,000-line on-device log.')) return;
    setBusy('clear');
    try {
      await clearLogs();
      showToast('Logs cleared');
    } catch (e: any) {
      log('error', 'general', 'clearLogs failed', e);
      showToast(e?.message || 'Clear failed', 'error');
    } finally {
      setBusy('idle');
    }
  };

  return (
    <div className="space-y-4 text-sm text-slate-700">
      <UsbPrinterStatus printers={usb.printers} supported={usb.supported} />

      <div className="space-y-2 pt-1">
        <button
          onClick={handleTestPrint}
          disabled={busy !== 'idle'}
          className="w-full flex items-center justify-center gap-2 bg-sky-600 text-white font-semibold py-2.5 rounded-md active:bg-sky-700 disabled:opacity-60 transition"
        >
          <PrintIcon />
          {busy === 'test' ? 'Generating…' : 'Send test print'}
        </button>
        <p className="text-xs text-slate-500 px-1 leading-relaxed">
          Generates a one-page PDF with the diagnostic header and opens it. From the viewer you can tap the printer icon to send it to your printer.
        </p>
      </div>

      {/* Logs — file-backed (up to ~10,000 lines on device), no in-app viewer. */}
      <div className="pt-2 border-t">
        <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-2">Logs</p>
        <p className="text-xs text-slate-500 mb-3 leading-relaxed">
          Every Firebase / sync / storage event is persisted to a rolling log
          file on this device (up to 10,000 lines). Tap <strong>Download logs</strong> to
          export the raw text, or <strong>Save / Share diagnostics</strong> for the full
          report bundle (logs + device info + USB snapshot).
        </p>

        <button
          onClick={handleDownloadLogs}
          disabled={busy !== 'idle'}
          className="w-full flex items-center justify-center gap-2 bg-emerald-600 text-white font-semibold py-2.5 rounded-md active:bg-emerald-700 disabled:opacity-60 transition mb-2"
        >
          <DownloadIcon />
          {busy === 'download' ? 'Reading…' : 'Download logs (txt)'}
        </button>

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={handleExport}
            disabled={busy !== 'idle'}
            className="flex items-center justify-center gap-2 bg-white border border-slate-300 text-slate-700 font-semibold py-2.5 rounded-md active:bg-slate-50 disabled:opacity-60 transition"
          >
            <DownloadIcon />
            {busy === 'export' ? '…' : 'Save diagnostics'}
          </button>
          <button
            onClick={handleShareDiagnostics}
            disabled={busy !== 'idle'}
            className="flex items-center justify-center gap-2 bg-sky-500 text-white font-semibold py-2.5 rounded-md active:bg-sky-600 disabled:opacity-60 transition"
          >
            <ShareIcon />
            {busy === 'share' ? '…' : 'Share'}
          </button>
        </div>

        <button
          onClick={handleClear}
          disabled={busy !== 'idle'}
          className="mt-3 w-full flex items-center justify-center gap-2 bg-white border border-rose-200 text-rose-700 font-semibold py-2 rounded-md active:bg-rose-50 disabled:opacity-60 transition text-xs"
        >
          <TrashIcon />
          {busy === 'clear' ? 'Clearing…' : 'Clear log file'}
        </button>
      </div>
    </div>
  );
};

export default PrinterDiagnostics;
