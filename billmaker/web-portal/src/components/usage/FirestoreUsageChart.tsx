// Reads/writes/deletes line chart for Firestore, fed by Cloud Monitoring API
// via /admin/usage/firestore-timeseries.
//
// Three ranges available:
//   1h    — 1-minute buckets, last hour. Best for "is something happening now"
//   24h   — 1-hour buckets, last day. Best for daily traffic shape
//   today — 1-hour buckets since 00:00 UTC. Matches Firestore's quota period

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts';
import { Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import { authedFetch } from '../../lib/authClient';
import { cn } from '../../lib/utils';

type Range = '1h' | '24h' | 'today';

interface Point { at: string; value: number }
interface TimeSeriesData {
  range: Range;
  intervalSeconds: number;
  reads: Point[];
  writes: Point[];
  deletes: Point[];
  totals: { reads: number; writes: number; deletes: number };
  cached?: boolean;
}

interface ErrorResp { error: string; reason?: string; setupHint?: string }

const RANGES: { key: Range; label: string }[] = [
  { key: '1h',    label: 'Last hour' },
  { key: '24h',   label: 'Last 24h' },
  { key: 'today', label: 'Since 00:00 UTC' },
];

// Daily free-tier caps used as reference lines.
const READ_LIMIT_DAILY = 50_000;
const WRITE_LIMIT_DAILY = 20_000;

export const FirestoreUsageChart: React.FC = () => {
  const [range, setRange] = useState<Range>('24h');
  const [data, setData] = useState<TimeSeriesData | null>(null);
  const [err, setErr] = useState<ErrorResp | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (r: Range) => {
    setLoading(true);
    setErr(null);
    try {
      const res = await authedFetch(`/admin/usage/firestore-timeseries?range=${r}`);
      const body = await res.json();
      if (!res.ok || body.error) {
        setErr(body as ErrorResp);
        setData(null);
      } else {
        setData(body as TimeSeriesData);
      }
    } catch (e: any) {
      setErr({ error: 'network_error', reason: e?.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(range); }, [range, load]);

  // Merge the three series into a single array of {at, reads, writes, deletes}
  // keyed by timestamp for the chart.
  const chartData = useMemo(() => {
    if (!data) return [];
    const map = new Map<string, { at: string; reads: number; writes: number; deletes: number }>();
    const ensure = (at: string) => {
      let r = map.get(at);
      if (!r) { r = { at, reads: 0, writes: 0, deletes: 0 }; map.set(at, r); }
      return r;
    };
    for (const p of data.reads)   ensure(p.at).reads   = p.value;
    for (const p of data.writes)  ensure(p.at).writes  = p.value;
    for (const p of data.deletes) ensure(p.at).deletes = p.value;
    return Array.from(map.values()).sort((a, b) => a.at.localeCompare(b.at));
  }, [data]);

  return (
    <div className="space-y-3">
      {/* Range chips + refresh */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex gap-1 bg-slate-100 rounded-md p-0.5">
          {RANGES.map(r => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={cn(
                'px-2.5 py-1 rounded text-[11px] font-bold uppercase tracking-wider transition',
                range === r.key
                  ? 'bg-white text-blue-700 shadow'
                  : 'text-slate-500 hover:text-slate-900',
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
        <Button size="sm" variant="ghost" onClick={() => load(range)} disabled={loading}>
          {loading
            ? <Loader2 className="h-3 w-3 animate-spin" />
            : <RefreshCw className="h-3 w-3" />}
        </Button>
      </div>

      {/* Totals header */}
      {data && (
        <div className="grid grid-cols-3 gap-2 text-center">
          <TotalsTile label="Reads" value={data.totals.reads} color="text-sky-700 bg-sky-50 border-sky-200" />
          <TotalsTile label="Writes" value={data.totals.writes} color="text-emerald-700 bg-emerald-50 border-emerald-200" />
          <TotalsTile label="Deletes" value={data.totals.deletes} color="text-rose-700 bg-rose-50 border-rose-200" />
        </div>
      )}

      {/* Error / not-configured banner */}
      {err && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900">
          <p className="font-semibold mb-1 flex items-center gap-1.5">
            <AlertCircle className="h-3.5 w-3.5" />
            {err.error === 'not_configured' ? 'GCP setup needed' : 'Could not load'}
          </p>
          {err.setupHint && <p className="leading-relaxed">{err.setupHint}</p>}
          {!err.setupHint && err.reason && <p className="font-mono text-[10px] mt-1 truncate">{err.reason}</p>}
        </div>
      )}

      {/* Chart */}
      {data && chartData.length > 0 && (
        <div className="bg-white rounded-lg border border-slate-200 p-2 pt-3">
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={chartData} margin={{ top: 5, right: 5, bottom: 0, left: -10 }}>
              <defs>
                <linearGradient id="gradReads" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#0284c7" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#0284c7" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradWrites" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#059669" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#059669" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradDeletes" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#e11d48" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#e11d48" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis
                dataKey="at"
                tickFormatter={fmtTick(range)}
                tick={{ fontSize: 9, fill: '#64748b' }}
                stroke="#cbd5e1"
                minTickGap={20}
              />
              <YAxis
                tick={{ fontSize: 10, fill: '#64748b' }}
                stroke="#cbd5e1"
                allowDecimals={false}
              />
              <Tooltip content={<ChartTooltip range={range} />} />
              <Legend
                wrapperStyle={{ fontSize: '11px', paddingTop: '8px' }}
                iconType="circle"
                iconSize={8}
              />
              <Area
                type="monotone" dataKey="reads" name="Reads"
                stroke="#0284c7" strokeWidth={2}
                fill="url(#gradReads)" activeDot={{ r: 4 }}
              />
              <Area
                type="monotone" dataKey="writes" name="Writes"
                stroke="#059669" strokeWidth={2}
                fill="url(#gradWrites)" activeDot={{ r: 4 }}
              />
              <Area
                type="monotone" dataKey="deletes" name="Deletes"
                stroke="#e11d48" strokeWidth={2}
                fill="url(#gradDeletes)" activeDot={{ r: 4 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Empty data hint */}
      {data && chartData.length === 0 && !err && (
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-500 text-center">
          No operations in this window. Try a wider range.
        </div>
      )}

      {/* Quota reference line for "today" */}
      {data && range === 'today' && (
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-2 text-[11px] text-slate-600 space-y-1">
          <div className="flex justify-between">
            <span>Today's reads vs cap</span>
            <span className="font-mono">
              {data.totals.reads.toLocaleString('en-IN')} / {READ_LIMIT_DAILY.toLocaleString('en-IN')}
              {' '}
              <strong className={cn(
                data.totals.reads > READ_LIMIT_DAILY * 0.9 ? 'text-rose-700' :
                data.totals.reads > READ_LIMIT_DAILY * 0.7 ? 'text-amber-700' : 'text-emerald-700',
              )}>
                ({((data.totals.reads / READ_LIMIT_DAILY) * 100).toFixed(1)}%)
              </strong>
            </span>
          </div>
          <div className="flex justify-between">
            <span>Today's writes vs cap</span>
            <span className="font-mono">
              {data.totals.writes.toLocaleString('en-IN')} / {WRITE_LIMIT_DAILY.toLocaleString('en-IN')}
              {' '}
              <strong className={cn(
                data.totals.writes > WRITE_LIMIT_DAILY * 0.9 ? 'text-rose-700' :
                data.totals.writes > WRITE_LIMIT_DAILY * 0.7 ? 'text-amber-700' : 'text-emerald-700',
              )}>
                ({((data.totals.writes / WRITE_LIMIT_DAILY) * 100).toFixed(1)}%)
              </strong>
            </span>
          </div>
        </div>
      )}
    </div>
  );
};


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fmtTick = (range: Range) => (raw: string): string => {
  const d = new Date(raw);
  if (range === '1h') {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${String(d.getHours()).padStart(2, '0')}:00`;
};

const fmtTip = (range: Range) => (raw: string): string => {
  const d = new Date(raw);
  if (range === '1h') {
    return `${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  return d.toLocaleString([], {
    month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
};

const ChartTooltip: React.FC<any> = ({ active, payload, label, range }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-slate-200 rounded-md shadow-md p-2 text-[11px]">
      <p className="font-semibold text-slate-700 mb-1">{fmtTip(range || '24h')(label)}</p>
      {payload.map((p: any) => (
        <p key={p.dataKey} className="flex items-center gap-1.5">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ backgroundColor: p.stroke }}
          />
          <span className="text-slate-500">{p.name}:</span>
          <span className="font-mono font-semibold text-slate-900">{p.value}</span>
        </p>
      ))}
    </div>
  );
};

const TotalsTile: React.FC<{ label: string; value: number; color: string }> = ({ label, value, color }) => (
  <div className={cn('rounded-md border px-2 py-1.5', color)}>
    <p className="text-[9px] uppercase tracking-widest font-bold opacity-70">{label}</p>
    <p className="text-base font-bold font-mono">{value.toLocaleString('en-IN')}</p>
  </div>
);
