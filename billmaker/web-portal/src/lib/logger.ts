/**
 * In-memory ring-buffer logger used by the admin Logs page.
 * Mirrors the BillMaker mobile diagnostics module (utils/diagnostics.ts) so the
 * two apps speak the same vocabulary when triaging issues.
 */

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';
export type LogCategory = 'firestore' | 'auth' | 'config' | 'cloudinary' | 'general' | 'sync';

export interface LogEntry {
  id: number;
  timestamp: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  details?: string;
}

const MAX_ENTRIES = 500;
const entries: LogEntry[] = [];
const listeners = new Set<() => void>();
let nextId = 1;

const notify = () => listeners.forEach(fn => { try { fn(); } catch {} });

const safeStringify = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (v instanceof Error) return `${v.name}: ${v.message}\n${v.stack || ''}`;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
};

export const log = (level: LogLevel, category: LogCategory, message: string, details?: unknown) => {
  const entry: LogEntry = {
    id: nextId++,
    timestamp: new Date().toISOString(),
    level,
    category,
    message,
    details: details === undefined ? undefined : safeStringify(details),
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  const tag = `[${level}] ${category}`;
  if (level === 'error') console.error(tag, message, details);
  else if (level === 'warn') console.warn(tag, message, details);
  else if (level === 'debug') console.debug(tag, message, details);
  else console.log(tag, message, details);
  notify();
};

export const getLogs = (): readonly LogEntry[] => entries;
export const clearLogs = (): void => { entries.length = 0; notify(); };
export const onLogsChange = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

export const formatLogEntry = (e: LogEntry): string => {
  const head = `${e.timestamp} [${e.level.toUpperCase()}] ${e.category}: ${e.message}`;
  if (!e.details) return head;
  const indented = e.details.split('\n').map(l => '    ' + l).join('\n');
  return `${head}\n${indented}`;
};

export const exportLogsAsText = (): string => {
  const lines: string[] = [];
  lines.push(`# BillMaker Portal — Logs`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`User agent: ${navigator.userAgent}`);
  lines.push('');
  for (const e of [...entries].reverse()) {
    lines.push(formatLogEntry(e));
    lines.push('');
  }
  return lines.join('\n');
};

/** Wires window error + unhandled rejection to the log. Call once at app start. */
export const installGlobalErrorHandlers = () => {
  window.addEventListener('error', e => {
    log('error', 'general', e.message || 'Window error', {
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      stack: (e as ErrorEvent).error?.stack,
    });
  });
  window.addEventListener('unhandledrejection', e => {
    log('error', 'general', 'Unhandled promise rejection', e.reason);
  });
};
