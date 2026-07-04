// Cloud Monitoring time-series queries for the Firestore project. Used by
// /admin/usage to render the Firestore reads/writes/deletes charts.
//
// REQUIRES (one-time GCP setup):
//   1. Enable Cloud Monitoring API in your project:
//      https://console.cloud.google.com/apis/library/monitoring.googleapis.com
//   2. Grant role "Monitoring Viewer" to your Firebase service account:
//      Console → IAM → find the firebase-adminsdk-* service account → Edit →
//      Add role "Monitoring Viewer" → Save
//
// Without those steps the API returns 403 and the charts gracefully show
// "Not configured" with the setup instructions.

import type { Env } from '../types';
import { getAccessToken } from './firestore';

export type Range = '1h' | '24h' | 'today';
export type Op = 'read' | 'write' | 'delete';

const METRIC_TYPES: Record<Op, string> = {
  read:   'firestore.googleapis.com/document/read_count',
  write:  'firestore.googleapis.com/document/write_count',
  delete: 'firestore.googleapis.com/document/delete_count',
};

export interface TimeSeriesPoint {
  /** ISO timestamp at end of the bucket. */
  at: string;
  /** Operations within this bucket (already integer-rounded). */
  value: number;
}

export interface TimeSeriesData {
  range: Range;
  intervalSeconds: number;
  reads: TimeSeriesPoint[];
  writes: TimeSeriesPoint[];
  deletes: TimeSeriesPoint[];
  totals: { reads: number; writes: number; deletes: number };
}


// ---------------------------------------------------------------------------
// Range → (start, alignment seconds)
//
//   1h    → start = 1h ago, 1-minute buckets    (60 points)
//   24h   → start = 24h ago, 1-hour buckets     (24 points)
//   today → start = today 00:00 UTC, 1h buckets (varies, 1-24 points)
// ---------------------------------------------------------------------------
const rangeWindow = (range: Range): { startMs: number; alignSeconds: number } => {
  const now = Date.now();
  if (range === '1h') {
    return { startMs: now - 60 * 60_000, alignSeconds: 60 };
  }
  if (range === '24h') {
    return { startMs: now - 24 * 60 * 60_000, alignSeconds: 3600 };
  }
  // today: UTC midnight (Google Cloud quotas reset on UTC midnight)
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return { startMs: d.getTime(), alignSeconds: 3600 };
};


// ---------------------------------------------------------------------------
// Single metric pull.
//
// Uses ALIGN_DELTA so each point is the raw count of operations within that
// bucket (vs ALIGN_RATE which gives per-second rates we'd have to multiply).
// crossSeriesReducer REDUCE_SUM collapses any multi-database / multi-shard
// series into one total per bucket.
// ---------------------------------------------------------------------------
const fetchOneMetric = async (
  env: Env,
  metricType: string,
  startMs: number,
  alignSeconds: number,
): Promise<TimeSeriesPoint[]> => {
  if (!env.FIREBASE_PROJECT_ID) throw new Error('FIREBASE_PROJECT_ID missing');

  const token = await getAccessToken(env);
  const now = new Date();
  const params = new URLSearchParams({
    filter: `metric.type = "${metricType}"`,
    'interval.startTime': new Date(startMs).toISOString(),
    'interval.endTime': now.toISOString(),
    'aggregation.alignmentPeriod': `${alignSeconds}s`,
    'aggregation.perSeriesAligner': 'ALIGN_DELTA',
    'aggregation.crossSeriesReducer': 'REDUCE_SUM',
  });

  const url = `https://monitoring.googleapis.com/v3/projects/${env.FIREBASE_PROJECT_ID}/timeSeries?${params}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Monitoring API ${metricType} → ${r.status}: ${detail.slice(0, 200)}`);
  }
  const body = await r.json() as {
    timeSeries?: Array<{
      points?: Array<{
        interval: { startTime: string; endTime: string };
        value: { int64Value?: string; doubleValue?: number };
      }>;
    }>;
  };
  const points = body.timeSeries?.[0]?.points || [];

  // Monitoring returns points in newest-first order. Normalize to oldest-first
  // for line charts.
  return points
    .map(p => ({
      at: p.interval.endTime,
      value: Number(p.value.int64Value ?? p.value.doubleValue ?? 0),
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
};


/**
 * Pull reads + writes + deletes for the given range. Returns aligned buckets
 * plus totals across the window.
 *
 * Note: Firestore metrics typically lag by 5-10 minutes — the last bucket may
 * be empty even if traffic is happening right now.
 */
export const fetchFirestoreTimeSeries = async (
  env: Env,
  range: Range,
): Promise<TimeSeriesData> => {
  const { startMs, alignSeconds } = rangeWindow(range);

  const [reads, writes, deletes] = await Promise.all([
    fetchOneMetric(env, METRIC_TYPES.read, startMs, alignSeconds),
    fetchOneMetric(env, METRIC_TYPES.write, startMs, alignSeconds),
    fetchOneMetric(env, METRIC_TYPES.delete, startMs, alignSeconds),
  ]);

  const sum = (pts: TimeSeriesPoint[]) =>
    pts.reduce((s, p) => s + p.value, 0);

  return {
    range,
    intervalSeconds: alignSeconds,
    reads,
    writes,
    deletes,
    totals: { reads: sum(reads), writes: sum(writes), deletes: sum(deletes) },
  };
};
