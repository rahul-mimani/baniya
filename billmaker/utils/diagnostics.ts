import { Filesystem, Encoding } from '@capacitor/filesystem';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { APP_DIR, EXPORT_DIR } from '../storage/paths';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';
export type LogCategory =
  | 'print' | 'usb' | 'storage' | 'pdf' | 'share' | 'general'
  | 'firebase' | 'realtime' | 'bills' | 'payments' | 'customers' | 'products' | 'profiles';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  details?: string;
}

// ---------------------------------------------------------------------------
// File-backed log persistence.
//
// All log() calls buffer into `pending[]` and flush to a single file at
// APP_DIR/billmaker-logs.txt every FLUSH_INTERVAL_MS. The file holds the
// last MAX_LINES_IN_FILE lines — a trim pass runs every minute when the
// file exceeds the threshold by 20%.
//
// The user accesses logs via downloadLogs() which copies the current file
// to EXPORT_DIR with a timestamped filename for easy share/download. No
// in-app log viewer — logs are write-only from the app's perspective.
// ---------------------------------------------------------------------------
const LOG_FILE = 'billmaker-logs.txt';
const MAX_LINES_IN_FILE = 10000;
const FLUSH_INTERVAL_MS = 2000;
const TRIM_INTERVAL_MS = 60_000;

let pending: LogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let trimTimer: ReturnType<typeof setInterval> | null = null;

const formatLogLine = (e: LogEntry): string => {
  const d = new Date(e.timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${ms}`;
  let line = `${ymd} ${hms} [${e.level.toUpperCase()}] ${e.category}: ${e.message}`;
  if (e.details) {
    const indented = e.details.split('\n').map(l => '    ' + l).join('\n');
    line += '\n' + indented;
  }
  return line;
};

const writePendingToFile = async (): Promise<void> => {
  if (pending.length === 0) return;
  const toWrite = pending.slice();
  pending.length = 0;
  const text = toWrite.map(formatLogLine).join('\n') + '\n';
  try {
    await Filesystem.appendFile({
      path: LOG_FILE,
      directory: APP_DIR,
      encoding: Encoding.UTF8,
      data: text,
    });
  } catch {
    // File doesn't exist — create it.
    try {
      await Filesystem.writeFile({
        path: LOG_FILE,
        directory: APP_DIR,
        encoding: Encoding.UTF8,
        data: text,
      });
    } catch (err) {
      // Persistence is best-effort; log to console so we don't recurse.
      // eslint-disable-next-line no-console
      console.error('[diagnostics] log file write failed', err);
    }
  }
};

const scheduleFlush = () => {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    await writePendingToFile();
  }, FLUSH_INTERVAL_MS);
};

const trimIfNeeded = async (): Promise<void> => {
  try {
    const result = await Filesystem.readFile({
      path: LOG_FILE,
      directory: APP_DIR,
      encoding: Encoding.UTF8,
    });
    const text = typeof result.data === 'string' ? result.data : await result.data.text();
    const lines = text.split('\n');
    // Only rewrite if we've overflowed by 20% so we're not constantly rewriting.
    if (lines.length > MAX_LINES_IN_FILE * 1.2) {
      const trimmed = lines.slice(-MAX_LINES_IN_FILE).join('\n');
      await Filesystem.writeFile({
        path: LOG_FILE,
        directory: APP_DIR,
        encoding: Encoding.UTF8,
        data: trimmed,
      });
    }
  } catch {
    // File doesn't exist — nothing to trim.
  }
};

const startTrimInterval = () => {
  if (trimTimer) return;
  trimTimer = setInterval(() => { void trimIfNeeded(); }, TRIM_INTERVAL_MS);
};
startTrimInterval();

export const log = (level: LogLevel, category: LogCategory, message: string, details?: unknown) => {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    category,
    message,
    details: details === undefined ? undefined : safeStringify(details),
  };
  pending.push(entry);
  scheduleFlush();
  const tag = `[${level}] ${category}`;
  if (level === 'error') console.error(tag, message, details);
  else if (level === 'warn') console.warn(tag, message, details);
  else console.log(tag, message, details);
};

/**
 * Force-flush any pending log entries to file, then return the file's full
 * contents as a string. Used by downloadLogs + exportDiagnostics.
 */
export const readLogFile = async (): Promise<string> => {
  if (pending.length > 0) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    await writePendingToFile();
  }
  try {
    const result = await Filesystem.readFile({
      path: LOG_FILE,
      directory: APP_DIR,
      encoding: Encoding.UTF8,
    });
    return typeof result.data === 'string' ? result.data : await result.data.text();
  } catch {
    return '';
  }
};

/**
 * Save the log file to the user's downloads.
 *
 * Two paths:
 *   - Web (browser via npm run dev or PWA): trigger a real Blob download
 *     using an anchor tag. File lands in the browser's Downloads folder.
 *   - Mobile (Capacitor native): write the file to app's external dir, then
 *     open the share sheet so the user can save to Downloads / share to
 *     email / send to Drive / etc. Android scoped storage prevents direct
 *     writes to the public Downloads folder without MediaStore plugins.
 *
 * Returns `{ uri, fileName }` for compatibility with callers that want to
 * open the saved file via FileOpener (web has empty uri).
 */
export const downloadLogs = async (): Promise<{ uri: string; fileName: string }> => {
  const content = await readLogFile();
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const fileName = `billmaker-logs_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.txt`;
  const payload = content || '(no logs yet)';

  // Detect Capacitor native vs browser. Inline-import to avoid bundle cost
  // on web-only builds.
  const { Capacitor } = await import('@capacitor/core');
  const isNative = Capacitor.isNativePlatform();

  if (!isNative) {
    // Browser path: standard Blob download. Lands in the browser's
    // configured Downloads folder.
    const blob = new Blob([payload], { type: 'text/plain;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Free the blob URL on next tick so the download has a chance to start.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    return { uri: '', fileName };
  }

  // Native path: write to external dir + open share sheet so user can pick
  // the Downloads folder (or any other destination).
  await Filesystem.writeFile({
    path: fileName,
    directory: EXPORT_DIR,
    encoding: Encoding.UTF8,
    data: payload,
  });
  const { uri } = await Filesystem.getUri({ path: fileName, directory: EXPORT_DIR });

  try {
    const { Share } = await import('@capacitor/share');
    await Share.share({
      title: 'BillMaker logs',
      text: 'Save to Downloads or share to a developer.',
      url: uri,
      dialogTitle: `Save ${fileName}`,
    });
  } catch (err: any) {
    // User dismissed share sheet — that's fine, the file is still on disk
    // at `uri` and they can open it via FileOpener as a fallback.
    if (err?.message && !/cancel/i.test(err.message)) {
      // Re-throw real errors; ignore "user cancelled".
      throw err;
    }
  }

  return { uri, fileName };
};

/** Wipe both pending buffer + the log file. */
export const clearLogs = async (): Promise<void> => {
  pending.length = 0;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  try {
    await Filesystem.deleteFile({ path: LOG_FILE, directory: APP_DIR });
  } catch {
    // Already gone — fine.
  }
};

const safeStringify = (v: unknown): string => {
  if (v instanceof Error) {
    return `${v.name}: ${v.message}\n${v.stack || ''}`;
  }
  try {
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};

/** Hooks window error and unhandledrejection so they show up in the diagnostic log. */
export const installGlobalErrorHandlers = () => {
  window.addEventListener('error', e => {
    log('error', 'general', e.message || 'Window error', {
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      stack: e.error?.stack,
    });
  });
  window.addEventListener('unhandledrejection', e => {
    log('error', 'general', 'Unhandled promise rejection', e.reason);
  });
};

interface DiagnosticsInfo {
  generatedAt: string;
  userAgent: string;
  platform: string;
  language: string;
  screen: string;
  appVersion: string;
}

const collectInfo = (appVersion: string): DiagnosticsInfo => ({
  generatedAt: new Date().toISOString(),
  userAgent: navigator.userAgent || '(n/a)',
  platform: navigator.platform || '(n/a)',
  language: navigator.language || '(n/a)',
  screen: `${window.screen?.width || '?'}x${window.screen?.height || '?'} @ ${window.devicePixelRatio || 1}x`,
  appVersion,
});

/** Format an ISO timestamp into a human-readable local-time string.
 *  e.g. "2026-05-23T07:21:00.000Z" → "2026-05-23 12:51:00 (IST)" so the
 *  diagnostics export matches the time the user actually saw the event. */
const formatLocalTimestamp = (iso: string): string => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  // Local timezone abbreviation if available.
  const tz = (() => {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d);
      return parts.find(p => p.type === 'timeZoneName')?.value || '';
    } catch { return ''; }
  })();
  return tz ? `${ymd} ${hms} (${tz})` : `${ymd} ${hms}`;
};

const formatLogEntry = (e: LogEntry): string => {
  const head = `${formatLocalTimestamp(e.timestamp)} [${e.level.toUpperCase()}] ${e.category}: ${e.message}`;
  if (!e.details) return head;
  const indented = e.details.split('\n').map(l => '    ' + l).join('\n');
  return `${head}\n${indented}`;
};

interface UsbSnapshot {
  supported: boolean;
  printers: Array<{ name: string; vendorId: number; productId: number }>;
}

export interface ExportArgs {
  appVersion: string;
  usb?: UsbSnapshot;
  capacitorPlugins?: string[];
}

const buildReport = async (args: ExportArgs): Promise<string> => {
  const info = collectInfo(args.appVersion);
  const usb = args.usb;

  let report = '';
  report += '# Bill Manager — Diagnostics Report\n';
  report += `Generated: ${info.generatedAt}\n\n`;

  report += '## App\n';
  report += `- Version: ${info.appVersion}\n\n`;

  report += '## Device\n';
  report += `- User Agent: ${info.userAgent}\n`;
  report += `- Platform: ${info.platform}\n`;
  report += `- Language: ${info.language}\n`;
  report += `- Screen: ${info.screen}\n\n`;

  if (args.capacitorPlugins?.length) {
    report += '## Capacitor Plugins\n';
    for (const p of args.capacitorPlugins) report += `- ${p}\n`;
    report += '\n';
  }

  report += '## USB Printer Detection\n';
  if (!usb) {
    report += '- (not captured)\n\n';
  } else {
    report += `- Plugin supported: ${usb.supported}\n`;
    report += `- Printers detected: ${usb.printers.length}\n`;
    for (const p of usb.printers) {
      const vid = p.vendorId.toString(16).toUpperCase().padStart(4, '0');
      const pid = p.productId.toString(16).toUpperCase().padStart(4, '0');
      report += `  - ${p.name || '(no name)'} — VID ${vid} / PID ${pid}\n`;
    }
    report += '\n';
  }

  // Logs read directly from the persisted file (oldest → newest, chronological).
  const fileContent = await readLogFile();
  report += '## Logs\n';
  if (!fileContent) {
    report += '_(no entries — try reproducing the issue first, then export again)_\n';
  } else {
    report += fileContent;
  }
  return report;
};

const fmtFilename = (prefix: string) => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${prefix}_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}.txt`;
};

export interface ExportedDiagnosticsFile {
  uri: string;
  fileName: string;
  contents: string;
}

export const exportDiagnostics = async (args: ExportArgs): Promise<ExportedDiagnosticsFile> => {
  const contents = await buildReport(args);
  const fileName = fmtFilename('billmaker-diagnostics');
  await Filesystem.writeFile({
    path: fileName,
    data: contents,
    directory: EXPORT_DIR,
    encoding: Encoding.UTF8,
  });
  const { uri } = await Filesystem.getUri({ path: fileName, directory: EXPORT_DIR });
  log('info', 'general', `Diagnostics exported to ${fileName}`);
  return { uri, fileName, contents };
};

/** Generates a tiny one-page test PDF for verifying that PDF gen, file write, and the print path all work. */
export const generateTestPrintPDF = async (appVersion: string): Promise<{ uri: string; fileName: string }> => {
  log('info', 'print', 'Generating test print PDF');
  try {
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const page = pdfDoc.addPage([595.28, 841.89]);
    const SKY = rgb(0.0117, 0.5176, 0.7803);
    const TEXT = rgb(0.118, 0.161, 0.231);
    const MUTED = rgb(0.392, 0.455, 0.545);

    page.drawRectangle({ x: 0, y: 841.89 - 90, width: 595.28, height: 90, color: SKY });
    page.drawText('Bill Manager — Test Print', { x: 40, y: 841.89 - 42, size: 22, font: bold, color: rgb(1, 1, 1) });
    page.drawText('Diagnostic / printer-connectivity check', { x: 40, y: 841.89 - 66, size: 11, font, color: rgb(0.85, 0.94, 0.99) });

    let y = 720;
    page.drawText('If you can see this page printed clearly, the print path is working.', {
      x: 40, y, size: 12, font, color: TEXT,
    });
    y -= 22;
    page.drawText('Please verify:', { x: 40, y, size: 11, font: bold, color: TEXT });
    y -= 16;
    [
      '1. The header band above is filled in sky-blue (background colors print).',
      '2. The text is sharp at this size — about 12pt.',
      '3. The page fills the A4 sheet, not just a corner of it.',
      '4. There are no items / lines cutting through text.',
    ].forEach(line => {
      page.drawText(line, { x: 50, y, size: 10, font, color: TEXT });
      y -= 14;
    });

    y -= 14;
    page.drawText(`App version: ${appVersion}`, { x: 40, y, size: 9, font, color: MUTED });
    y -= 12;
    page.drawText(`Generated: ${new Date().toLocaleString()}`, { x: 40, y, size: 9, font, color: MUTED });
    y -= 12;
    page.drawText(`User agent: ${(navigator.userAgent || '').slice(0, 100)}`, { x: 40, y, size: 9, font, color: MUTED });

    const base64Data = await pdfDoc.saveAsBase64();
    const fileName = `Test-Print_${Date.now()}.pdf`;
    await Filesystem.writeFile({ path: fileName, data: base64Data, directory: EXPORT_DIR });
    const { uri } = await Filesystem.getUri({ path: fileName, directory: EXPORT_DIR });
    log('info', 'print', `Test PDF generated: ${fileName}`);
    return { uri, fileName };
  } catch (e) {
    log('error', 'print', 'Test print PDF generation failed', e);
    throw e;
  }
};
