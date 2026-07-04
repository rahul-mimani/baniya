import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { ScrollText, Trash2, Download, Filter, Search, Activity, Pause, Play, X, RefreshCw, Server, Monitor, Loader2, AlertCircle } from 'lucide-react';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { cn } from '../lib/utils';
import {
  LogEntry,
  LogLevel,
  LogCategory,
  getLogs,
  clearLogs,
  onLogsChange,
  exportLogsAsText,
} from '../lib/logger';
import { getSyncStatus, onSyncStatusChange, SyncStatus } from '../lib/firestoreSync';
import { authedFetch } from '../lib/authClient';

type LogView = 'browser' | 'worker';

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const CATEGORIES: LogCategory[] = ['firestore', 'auth', 'config', 'sync', 'cloudinary', 'general'];

const levelStyles: Record<LogLevel, string> = {
  debug: 'bg-slate-100 text-slate-600 border-slate-200',
  info: 'bg-sky-50 text-sky-700 border-sky-200',
  warn: 'bg-amber-50 text-amber-700 border-amber-300',
  error: 'bg-rose-50 text-rose-700 border-rose-300',
};

const AdminLogs: React.FC = () => {
  const [view, setView] = useState<LogView>('browser');
  const [, force] = useState(0);
  const [paused, setPaused] = useState(false);
  const [levelFilter, setLevelFilter] = useState<Set<LogLevel>>(new Set(LEVELS));
  const [catFilter, setCatFilter] = useState<Set<LogCategory>>(new Set(CATEGORIES));
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [sync, setSync] = useState<SyncStatus>(getSyncStatus());
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => onLogsChange(() => { if (!paused) force(n => n + 1); }), [paused]);
  useEffect(() => onSyncStatusChange(setSync), []);

  // Auto-scroll to bottom when new logs arrive (unless paused or user scrolled up)
  useEffect(() => {
    if (paused || !listRef.current) return;
    const el = listRef.current;
    const nearBottom = el.scrollHeight - el.clientHeight - el.scrollTop < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  });

  const all = getLogs();
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter(e => {
      if (!levelFilter.has(e.level)) return false;
      if (!catFilter.has(e.category)) return false;
      if (q) {
        const hay = `${e.message} ${e.details || ''} ${e.category}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [all, levelFilter, catFilter, search]);

  const counts = useMemo(() => {
    const out = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const e of all) out[e.level]++;
    return out;
  }, [all]);

  const toggleLevel = (l: LogLevel) => {
    setLevelFilter(prev => {
      const next = new Set(prev);
      if (next.has(l)) next.delete(l); else next.add(l);
      return next;
    });
  };
  const toggleCat = (c: LogCategory) => {
    setCatFilter(prev => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });
  };

  const handleExport = () => {
    const text = exportLogsAsText();
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `billmaker-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const fmtTime = (iso: string) => {
    try {
      const d = new Date(iso);
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds() % 1000).slice(0, 3)}`;
    } catch { return iso; }
  };

  const collectionDot = (s: string) =>
    s === 'received' ? 'bg-emerald-500' : s === 'subscribed' ? 'bg-amber-400 animate-pulse' : s === 'error' ? 'bg-rose-500' : 'bg-slate-300';

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto">
      <header className="mb-4">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight flex items-center gap-2">
          <ScrollText className="h-7 w-7 text-secondary" /> Logs
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {view === 'browser'
            ? 'Real-time diagnostic log for Firestore sync, image uploads, and config events. Ring buffer of the last 500 entries.'
            : 'Persisted worker events from the auth-service (cron syncs, aggregate recomputes, errors). Last 10 days of history; older rows pruned weekly.'}
        </p>
      </header>

      {/* View toggle — Browser (in-page logs) vs Worker (auth-service Supabase-backed events) */}
      <div className="flex gap-1 bg-muted rounded-lg p-1 mb-4 w-fit">
        <button
          type="button"
          onClick={() => setView('browser')}
          className={cn(
            'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition',
            view === 'browser' ? 'bg-background text-primary shadow' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Monitor className="h-3.5 w-3.5" /> Browser
        </button>
        <button
          type="button"
          onClick={() => setView('worker')}
          className={cn(
            'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition',
            view === 'worker' ? 'bg-background text-primary shadow' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Server className="h-3.5 w-3.5" /> Worker
        </button>
      </div>

      {view === 'worker' ? (
        <WorkerLogsPanel />
      ) : (
      <>
      {/* Sync status panel */}
      <Card className="mb-4">
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2 flex items-center gap-1.5">
                <Activity className="h-3.5 w-3.5" /> Firestore sync status
              </p>
              <div className="flex items-center gap-3 flex-wrap text-sm">
                <span className="flex items-center gap-1.5">
                  <span className={cn('w-2 h-2 rounded-full', sync.initialized ? 'bg-emerald-500' : 'bg-slate-300')} />
                  {sync.initialized ? 'Initialized' : 'Not initialized'}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className={cn('w-2 h-2 rounded-full', sync.authReady ? 'bg-emerald-500' : 'bg-amber-400')} />
                  {sync.authReady ? 'Authenticated' : 'Not authenticated'}
                </span>
                {sync.projectId && <Badge variant="secondary" className="font-mono text-[10px]">{sync.projectId}</Badge>}
                {sync.shopCode && <Badge variant="default" className="font-mono text-[10px]">shop: {sync.shopCode}</Badge>}
              </div>
              <div className="flex items-center gap-3 mt-2 text-[11px] text-muted-foreground">
                {Object.entries(sync.collections).map(([name, st]) => (
                  <span key={name} className="flex items-center gap-1.5">
                    <span className={cn('w-1.5 h-1.5 rounded-full', collectionDot(st))} />
                    <span className="font-mono">{name}</span>
                    <span className="text-[10px]">({st})</span>
                  </span>
                ))}
              </div>
            </div>
            {sync.lastError && (
              <div className="bg-rose-50 border border-rose-200 rounded-md px-3 py-1.5 text-xs text-rose-800 max-w-md">
                <p className="font-bold mb-0.5">Last error</p>
                <p className="font-mono text-[10px] break-all">{sync.lastError}</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-2 mb-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter logs by message, details, category…"
            className="pl-9 pr-9"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-3 top-2.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setPaused(p => !p)} className={paused ? 'border-amber-400 text-amber-700' : ''}>
            {paused ? <><Play className="h-3.5 w-3.5" /> Resume</> : <><Pause className="h-3.5 w-3.5" /> Pause</>}
          </Button>
          <Button variant="outline" size="sm" onClick={handleExport} disabled={all.length === 0}>
            <Download className="h-3.5 w-3.5" /> Export
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { if (window.confirm('Clear all logs?')) clearLogs(); }}
            disabled={all.length === 0}
            className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
          >
            <Trash2 className="h-3.5 w-3.5" /> Clear
          </Button>
        </div>
      </div>

      {/* Filter chips */}
      <div className="space-y-2 mb-3">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <Filter className="h-3 w-3 text-muted-foreground mr-1" />
          <span className="text-muted-foreground font-semibold uppercase tracking-wider mr-1">Level:</span>
          {LEVELS.map(l => {
            const on = levelFilter.has(l);
            return (
              <button
                key={l}
                onClick={() => toggleLevel(l)}
                className={cn(
                  'text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border transition',
                  on ? levelStyles[l] : 'bg-background text-muted-foreground border-border opacity-50',
                )}
              >
                {l} <span className="opacity-60 ml-0.5">{counts[l]}</span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground font-semibold uppercase tracking-wider mr-1 ml-5">Source:</span>
          {CATEGORIES.map(c => {
            const on = catFilter.has(c);
            return (
              <button
                key={c}
                onClick={() => toggleCat(c)}
                className={cn(
                  'text-[10px] font-mono px-2 py-0.5 rounded border transition',
                  on ? 'bg-slate-900 text-slate-50 border-slate-900' : 'bg-background text-muted-foreground border-border opacity-50',
                )}
              >
                {c}
              </button>
            );
          })}
        </div>
      </div>

      {/* Log list */}
      <Card>
        <CardContent className="p-0">
          <div
            ref={listRef}
            className="font-mono text-[11px] leading-relaxed bg-slate-950 text-slate-100 rounded-md max-h-[60vh] overflow-y-auto overflow-x-hidden"
          >
            {filtered.length === 0 ? (
              <div className="py-12 px-4 text-center text-slate-500">
                {all.length === 0 ? 'No logs yet.' : 'No logs match the current filters.'}
              </div>
            ) : (
              filtered.map(e => <LogRow key={e.id} entry={e} expanded={expanded} setExpanded={setExpanded} fmtTime={fmtTime} />)
            )}
          </div>
          {paused && (
            <div className="px-3 py-1.5 bg-amber-50 border-t border-amber-200 text-[11px] text-amber-800 font-semibold">
              ⏸ Live updates paused. Click Resume to see new entries.
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-[10px] text-muted-foreground mt-3 text-right font-mono">
        {filtered.length} of {all.length} entries shown · ring buffer caps at 500
      </p>
      </>
      )}
    </div>
  );
};

interface LogRowProps {
  entry: LogEntry;
  expanded: Set<number>;
  setExpanded: React.Dispatch<React.SetStateAction<Set<number>>>;
  fmtTime: (iso: string) => string;
}

const LogRow: React.FC<LogRowProps> = ({ entry, expanded, setExpanded, fmtTime }) => {
  const hasDetails = !!entry.details;
  const open = expanded.has(entry.id);
  const toggle = () => {
    if (!hasDetails) return;
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id);
      return next;
    });
  };
  const levelText: Record<LogLevel, string> = {
    debug: 'text-slate-400',
    info: 'text-sky-300',
    warn: 'text-amber-300',
    error: 'text-rose-300',
  };
  return (
    <div
      onClick={toggle}
      className={cn(
        'px-3 py-1.5 border-b border-slate-800 last:border-b-0',
        hasDetails && 'cursor-pointer hover:bg-slate-900',
      )}
    >
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-slate-500">{fmtTime(entry.timestamp)}</span>
        <span className={cn('font-bold uppercase text-[10px] tracking-wider w-12', levelText[entry.level])}>{entry.level}</span>
        <span className="text-violet-300">{entry.category}</span>
        <span className="text-slate-100 flex-1 break-words">{entry.message}</span>
        {hasDetails && <span className="text-[9px] text-slate-500">{open ? '▼' : '▶'}</span>}
      </div>
      {hasDetails && open && (
        <pre className="mt-1 ml-12 text-[10px] text-slate-400 whitespace-pre-wrap break-words bg-slate-900/60 rounded p-2 border border-slate-800">
          {entry.details}
        </pre>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Worker logs panel — reads from /admin/worker-events (Supabase-backed).
// ---------------------------------------------------------------------------

type Range = '1h' | '24h' | '7d' | '30d';
type WorkerLevel = 'info' | 'warn' | 'error';

interface WorkerEvent {
  id: number;
  ts: string;
  level: WorkerLevel;
  event: string;
  payload: Record<string, unknown> | null;
}

const RANGES: Array<{ value: Range; label: string }> = [
  { value: '1h', label: 'Last 1h' },
  { value: '24h', label: 'Last 24h' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
];

const workerLevelStyles: Record<WorkerLevel, string> = {
  info: 'bg-sky-50 text-sky-700 border-sky-200',
  warn: 'bg-amber-50 text-amber-700 border-amber-300',
  error: 'bg-rose-50 text-rose-700 border-rose-300',
};

const WorkerLogsPanel: React.FC = () => {
  const [range, setRange] = useState<Range>('24h');
  const [levelFilter, setLevelFilter] = useState<WorkerLevel | 'all'>('all');
  const [eventFilter, setEventFilter] = useState<string>('');
  const [search, setSearch] = useState('');
  const [events, setEvents] = useState<WorkerEvent[]>([]);
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [autoRefresh, setAutoRefresh] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ range, limit: '500' });
      if (levelFilter !== 'all') params.set('level', levelFilter);
      if (eventFilter) params.set('event', eventFilter);
      if (search.trim()) params.set('q', search.trim());
      const r = await authedFetch(`/admin/worker-events?${params.toString()}`);
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || body.reason || `HTTP ${r.status}`);
      }
      const data = await r.json();
      setEvents(data.events || []);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [range, levelFilter, eventFilter, search]);

  // Fetch event-type vocab once on mount for the dropdown
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await authedFetch('/admin/worker-events/event-types');
        if (!r.ok) return;
        const data = await r.json();
        if (!cancelled) setEventTypes(data.events || []);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  // Reload on filter change
  useEffect(() => { void load(); }, [load]);

  // Auto-refresh every 30 seconds (lighter than the browser-logs live stream)
  useEffect(() => {
    if (!autoRefresh) return;
    const handle = setInterval(() => { void load(); }, 30000);
    return () => clearInterval(handle);
  }, [autoRefresh, load]);

  const counts = useMemo(() => {
    const out = { info: 0, warn: 0, error: 0 };
    for (const e of events) out[e.level]++;
    return out;
  }, [events]);

  const fmtRelative = (iso: string) => {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
    if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m ago`;
    if (ms < 24 * 60 * 60_000) return `${Math.round(ms / (60 * 60_000))}h ago`;
    return `${Math.round(ms / (24 * 60 * 60_000))}d ago`;
  };

  const fmtAbsolute = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, {
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch { return iso; }
  };

  const toggleExpand = (id: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <>
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-2 mb-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter by event name or payload contents…"
            className="pl-9 pr-9"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-3 top-2.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAutoRefresh(a => !a)}
            className={autoRefresh ? 'border-emerald-400 text-emerald-700' : ''}
          >
            {autoRefresh ? <><Pause className="h-3.5 w-3.5" /> Auto: on</> : <><Play className="h-3.5 w-3.5" /> Auto: off</>}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /> Refresh
          </Button>
        </div>
      </div>

      {/* Filter chips */}
      <div className="space-y-2 mb-3">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <Filter className="h-3 w-3 text-muted-foreground mr-1" />
          <span className="text-muted-foreground font-semibold uppercase tracking-wider mr-1">Range:</span>
          {RANGES.map(r => (
            <button
              key={r.value}
              onClick={() => setRange(r.value)}
              className={cn(
                'text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border transition',
                range === r.value ? 'bg-slate-900 text-slate-50 border-slate-900' : 'bg-background text-muted-foreground border-border opacity-60',
              )}
            >
              {r.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground font-semibold uppercase tracking-wider mr-1 ml-5">Level:</span>
          {(['all', 'info', 'warn', 'error'] as const).map(l => {
            const on = levelFilter === l;
            const count = l === 'all' ? events.length : counts[l];
            return (
              <button
                key={l}
                onClick={() => setLevelFilter(l)}
                className={cn(
                  'text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border transition',
                  on
                    ? l === 'all'
                      ? 'bg-slate-900 text-slate-50 border-slate-900'
                      : workerLevelStyles[l as WorkerLevel]
                    : 'bg-background text-muted-foreground border-border opacity-50',
                )}
              >
                {l} <span className="opacity-60 ml-0.5">{count}</span>
              </button>
            );
          })}
        </div>

        {eventTypes.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted-foreground font-semibold uppercase tracking-wider mr-1 ml-5">Event:</span>
            <button
              onClick={() => setEventFilter('')}
              className={cn(
                'text-[10px] font-mono px-2 py-0.5 rounded border transition',
                eventFilter === '' ? 'bg-slate-900 text-slate-50 border-slate-900' : 'bg-background text-muted-foreground border-border opacity-50',
              )}
            >
              all
            </button>
            {eventTypes.map(et => (
              <button
                key={et}
                onClick={() => setEventFilter(et === eventFilter ? '' : et)}
                className={cn(
                  'text-[10px] font-mono px-2 py-0.5 rounded border transition',
                  eventFilter === et ? 'bg-slate-900 text-slate-50 border-slate-900' : 'bg-background text-muted-foreground border-border opacity-50',
                )}
              >
                {et}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="bg-rose-50 border border-rose-200 rounded-md px-3 py-2 text-xs text-rose-800 mb-3 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <span>
            <strong>Failed to load worker events:</strong> {error}
            <br />
            <span className="text-rose-700">
              Make sure the <code className="font-mono">worker_events</code> table exists in Supabase
              (run <code className="font-mono">auth-service/sql/2026-05-22_worker_events.sql</code>)
              and the auth-service is deployed with the new endpoint.
            </span>
          </span>
        </div>
      )}

      {/* Event list */}
      <Card>
        <CardContent className="p-0">
          <div className="font-mono text-[11px] leading-relaxed bg-slate-950 text-slate-100 rounded-md max-h-[60vh] overflow-y-auto overflow-x-hidden">
            {loading && events.length === 0 ? (
              <div className="py-12 px-4 text-center text-slate-500">
                <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" /> Loading…
              </div>
            ) : events.length === 0 ? (
              <div className="py-12 px-4 text-center text-slate-500">
                No events in the selected range / filters.
              </div>
            ) : (
              events.map(e => (
                <WorkerEventRow
                  key={e.id}
                  event={e}
                  expanded={expanded.has(e.id)}
                  onToggle={() => toggleExpand(e.id)}
                  fmtAbsolute={fmtAbsolute}
                  fmtRelative={fmtRelative}
                />
              ))
            )}
          </div>
        </CardContent>
      </Card>

      <p className="text-[10px] text-muted-foreground mt-3 text-right font-mono">
        {events.length} events shown · auto-refresh {autoRefresh ? 'every 30s' : 'paused'} · backed by Supabase
      </p>
    </>
  );
};

const WorkerEventRow: React.FC<{
  event: WorkerEvent;
  expanded: boolean;
  onToggle: () => void;
  fmtAbsolute: (iso: string) => string;
  fmtRelative: (iso: string) => string;
}> = ({ event, expanded, onToggle, fmtAbsolute, fmtRelative }) => {
  const hasPayload = event.payload && Object.keys(event.payload).length > 0;
  const levelText: Record<WorkerLevel, string> = {
    info: 'text-sky-300',
    warn: 'text-amber-300',
    error: 'text-rose-300',
  };
  return (
    <div
      onClick={hasPayload ? onToggle : undefined}
      className={cn(
        'px-3 py-1.5 border-b border-slate-800 last:border-b-0',
        hasPayload && 'cursor-pointer hover:bg-slate-900',
      )}
    >
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-slate-500" title={fmtAbsolute(event.ts)}>
          {fmtRelative(event.ts)}
        </span>
        <span className={cn('font-bold uppercase text-[10px] tracking-wider w-12', levelText[event.level])}>
          {event.level}
        </span>
        <span className="text-violet-300 font-bold">{event.event}</span>
        {hasPayload && <span className="text-[9px] text-slate-500">{expanded ? '▼' : '▶'}</span>}
      </div>
      {hasPayload && expanded && (
        <pre className="mt-1 ml-12 text-[10px] text-slate-300 whitespace-pre-wrap break-words bg-slate-900/60 rounded p-2 border border-slate-800">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      )}
    </div>
  );
};

export default AdminLogs;
