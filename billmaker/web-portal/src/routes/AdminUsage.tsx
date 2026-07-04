// AdminUsage — shows quota usage for Brevo, Firestore, Supabase, Cloudflare,
// Cloudinary. Each service is its own card with a progress bar where possible.
// Unconfigured services show a "Setup" hint so the admin knows what to add.

import React, { useEffect, useState, useCallback } from 'react';
import {
  Activity, Mail, Database, Flame, Cloud, ImageIcon,
  Loader2, RefreshCw, AlertCircle, CheckCircle2,
} from 'lucide-react';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { FirestoreUsageChart } from '../components/usage/FirestoreUsageChart';
import { authedFetch } from '../lib/authClient';
import { cn } from '../lib/utils';

interface UsageResponse {
  fetchedAt: string;
  cached: boolean;
  brevo: any;
  firestore: any;
  supabase: any;
  cloudflare: any;
  cloudinary: any;
}

const AdminUsage: React.FC = () => {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (forceRefresh = false) => {
    if (forceRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const r = await authedFetch(forceRefresh ? '/admin/usage/refresh' : '/admin/usage', {
        method: forceRefresh ? 'POST' : 'GET',
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || 'load_failed');
      setData(body);
    } catch (e: any) {
      setError(e?.message || 'load_failed');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(false); }, [load]);

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight flex items-center gap-2">
            <Activity className="h-7 w-7 text-blue-600" /> Usage
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Quota tracking across the five services this app depends on. Cached for 5 min — hit refresh for live data.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data?.fetchedAt && (
            <span className="text-[11px] text-muted-foreground">
              Updated {new Date(data.fetchedAt).toLocaleTimeString()}{' '}
              {data.cached && <span className="text-amber-700">· cached</span>}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={() => load(true)} disabled={refreshing}>
            {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </Button>
        </div>
      </header>

      {loading && !data && (
        <Card className="p-12 text-center text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" /> Loading usage…
        </Card>
      )}

      {error && (
        <Card className="border-rose-200 bg-rose-50 mb-4">
          <CardContent className="p-3 text-xs text-rose-800 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <span>Couldn't load — {error}</span>
          </CardContent>
        </Card>
      )}

      {data && (
        <>
          {/* Firestore chart spans full width — it's the most important */}
          <Card className="overflow-hidden mb-4">
            <div className="h-1 bg-gradient-to-br from-amber-400 to-orange-600" />
            <CardContent className="p-5">
              <div className="flex items-start gap-3 mb-4">
                <div className="w-10 h-10 rounded-lg flex items-center justify-center text-white shadow-sm bg-gradient-to-br from-amber-400 to-orange-600">
                  <Flame className="h-5 w-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-bold text-slate-900">Firestore activity</h3>
                  <p className="text-xs text-muted-foreground">
                    Reads, writes, and deletes from Cloud Monitoring. Data lags ~5 min.
                  </p>
                </div>
              </div>
              <FirestoreUsageChart />
            </CardContent>
          </Card>

          {/* Other services in a 2-column grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <CloudflareCard data={data.cloudflare} />
            <SupabaseCard data={data.supabase} />
            <FirestoreCard data={data.firestore} />
            <BrevoCard data={data.brevo} />
            <CloudinaryCard data={data.cloudinary} />
          </div>
        </>
      )}
    </div>
  );
};


// ===========================================================================
// Reusable bits
// ===========================================================================

const ServiceCard: React.FC<{
  title: string;
  subtitle?: string;
  icon: React.ComponentType<{ className?: string }>;
  iconColor: string;
  children: React.ReactNode;
}> = ({ title, subtitle, icon: Icon, iconColor, children }) => (
  <Card className="overflow-hidden">
    <div className={cn('h-1', iconColor)} />
    <CardContent className="p-5">
      <div className="flex items-start gap-3 mb-4">
        <div className={cn('w-10 h-10 rounded-lg flex items-center justify-center text-white shadow-sm', iconColor)}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-slate-900">{title}</h3>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
      {children}
    </CardContent>
  </Card>
);

const ProgressBar: React.FC<{ used: number; limit: number; toneOverride?: 'safe' | 'warn' | 'danger' }> = ({ used, limit, toneOverride }) => {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const tone = toneOverride ?? (pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'safe');
  const colorMap = {
    safe: 'bg-gradient-to-r from-emerald-400 to-emerald-600',
    warn: 'bg-gradient-to-r from-amber-400 to-amber-600',
    danger: 'bg-gradient-to-r from-rose-400 to-rose-600',
  };
  return (
    <div className="w-full h-2 rounded-full bg-slate-100 overflow-hidden">
      <div className={cn('h-full transition-all', colorMap[tone])} style={{ width: `${pct}%` }} />
    </div>
  );
};

const Metric: React.FC<{
  label: string;
  used: number | string;
  limit?: number;
  unit?: string;
  showBar?: boolean;
}> = ({ label, used, limit, unit = '', showBar = true }) => {
  const usedNum = typeof used === 'number' ? used : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono font-semibold text-slate-900">
          {typeof used === 'number' ? used.toLocaleString('en-IN') : used}{unit}
          {limit && (
            <span className="text-muted-foreground font-normal">
              {' / '}{limit.toLocaleString('en-IN')}{unit}
            </span>
          )}
        </span>
      </div>
      {showBar && limit && <ProgressBar used={usedNum} limit={limit} />}
    </div>
  );
};

const NotConfigured: React.FC<{ hint?: string }> = ({ hint }) => (
  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900">
    <p className="font-semibold mb-1 flex items-center gap-1.5">
      <AlertCircle className="h-3.5 w-3.5" /> Not configured
    </p>
    {hint && <p className="text-[11px] leading-relaxed">{hint}</p>}
  </div>
);


// ===========================================================================
// Service-specific cards
// ===========================================================================

const CloudflareCard: React.FC<{ data: any }> = ({ data }) => (
  <ServiceCard
    title="Cloudflare Workers"
    subtitle="Where your auth-service runs"
    icon={Cloud}
    iconColor="bg-gradient-to-br from-orange-400 to-orange-600"
  >
    {!data.available ? (
      <NotConfigured hint={data.setupHint || `Free tier: 100,000 requests/day. Add credentials in .env to track live usage.`} />
    ) : (
      <div className="space-y-3">
        <Metric label="Requests (last 24h)" used={data.last24h?.requests || 0} limit={data.dailyRequestLimit || 100000} />
        {data.last24h?.errors > 0 && (
          <Metric label="Errors (last 24h)" used={data.last24h.errors} showBar={false} />
        )}
        {data.last24h?.cpuTimeP50ms != null && (
          <Metric label="CPU time p50" used={`${data.last24h.cpuTimeP50ms.toFixed(1)}`} unit="ms" showBar={false} />
        )}
        {data.last24h?.cpuTimeP99ms != null && (
          <Metric label="CPU time p99" used={`${data.last24h.cpuTimeP99ms.toFixed(1)}`} unit="ms" showBar={false} />
        )}
      </div>
    )}
  </ServiceCard>
);

const SupabaseCard: React.FC<{ data: any }> = ({ data }) => (
  <ServiceCard
    title="Supabase"
    subtitle="Auth DB + Firestore replica"
    icon={Database}
    iconColor="bg-gradient-to-br from-emerald-400 to-emerald-600"
  >
    {!data.available ? (
      <NotConfigured hint={data.reason || 'Could not load.'} />
    ) : (
      <div className="space-y-3">
        <p className="text-[11px] text-muted-foreground italic">
          Free plan: 500 MB DB, 5 GB bandwidth/month, unlimited API.
        </p>
        <div className="bg-slate-50 rounded-lg p-3 space-y-1.5">
          <p className="text-[10px] uppercase tracking-widest font-bold text-slate-600 mb-1">
            Row counts (proxy for storage)
          </p>
          {Object.entries(data.rowCounts || {}).map(([t, n]) => (
            <div key={t} className="flex justify-between text-xs">
              <span className="font-mono text-slate-600">{t}</span>
              <span className="font-mono font-semibold text-slate-900">{Number(n).toLocaleString('en-IN')}</span>
            </div>
          ))}
          <div className="border-t border-slate-200 pt-1.5 mt-1.5 flex justify-between text-xs">
            <span className="font-bold text-slate-700">Total rows</span>
            <span className="font-mono font-bold text-slate-900">{Number(data.totalRows || 0).toLocaleString('en-IN')}</span>
          </div>
        </div>
      </div>
    )}
  </ServiceCard>
);

const FirestoreCard: React.FC<{ data: any }> = ({ data }) => (
  <ServiceCard
    title="Firestore"
    subtitle="Mobile + admin data source"
    icon={Flame}
    iconColor="bg-gradient-to-br from-amber-400 to-orange-600"
  >
    {!data.available ? (
      <NotConfigured hint={data.reason || 'Could not load.'} />
    ) : (
      <div className="space-y-3">
        <p className="text-[11px] text-muted-foreground italic">
          Free tier: 50k reads/day, 20k writes/day. Counter below is THIS app's sync only —
          direct mobile/portal Firestore activity isn't included.
        </p>
        <Metric label="Lifetime reads (sync engine)" used={data.totalLifetimeReads || 0} showBar={false} />
        {data.perCollection?.length > 0 && (
          <div className="bg-slate-50 rounded-lg p-3 space-y-1.5">
            <p className="text-[10px] uppercase tracking-widest font-bold text-slate-600 mb-1">
              Per collection
            </p>
            {data.perCollection.map((c: any) => (
              <div key={c.collection} className="flex justify-between text-xs">
                <span className="font-mono text-slate-600">{c.collection}</span>
                <span className="font-mono text-slate-900">
                  {Number(c.total_upserts || 0).toLocaleString('en-IN')}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    )}
  </ServiceCard>
);

const BrevoCard: React.FC<{ data: any }> = ({ data }) => (
  <ServiceCard
    title="Brevo"
    subtitle="OTP email delivery"
    icon={Mail}
    iconColor="bg-gradient-to-br from-sky-400 to-blue-600"
  >
    {!data.available ? (
      <NotConfigured hint={data.reason || 'Could not load.'} />
    ) : (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          <span className="text-sm font-semibold text-slate-800">
            {data.companyName || data.accountEmail}
          </span>
          {data.planType && (
            <span className="text-[10px] font-bold uppercase tracking-wider bg-sky-100 text-sky-700 px-2 py-0.5 rounded-full border border-sky-200">
              {data.planType}
            </span>
          )}
        </div>
        {data.creditsRemaining != null && (
          <Metric label="Credits remaining" used={data.creditsRemaining} showBar={false} />
        )}
        <Metric
          label="Documented daily limit"
          used={`${data.dailyEmailLimit}/day`}
          showBar={false}
        />
        <p className="text-[11px] text-muted-foreground italic">{data.note}</p>
      </div>
    )}
  </ServiceCard>
);

const CloudinaryCard: React.FC<{ data: any }> = ({ data }) => (
  <ServiceCard
    title="Cloudinary"
    subtitle="Product image hosting"
    icon={ImageIcon}
    iconColor="bg-gradient-to-br from-purple-400 to-fuchsia-600"
  >
    {!data.available ? (
      <NotConfigured hint={data.setupHint || data.reason || 'Could not load.'} />
    ) : (
      <div className="space-y-3">
        <p className="text-sm">
          <span className="text-muted-foreground">Plan: </span>
          <strong className="text-slate-900">{data.plan || 'Free'}</strong>
        </p>
        {data.storage?.limit && (
          <Metric
            label="Storage"
            used={Math.round((data.storage.usage || 0) / 1024 / 1024)}
            limit={Math.round(data.storage.limit / 1024 / 1024)}
            unit=" MB"
          />
        )}
        {data.bandwidth?.limit && (
          <Metric
            label="Bandwidth (this month)"
            used={Math.round((data.bandwidth.usage || 0) / 1024 / 1024)}
            limit={Math.round(data.bandwidth.limit / 1024 / 1024)}
            unit=" MB"
          />
        )}
        {data.transformations?.limit && (
          <Metric
            label="Transformations"
            used={data.transformations.usage || 0}
            limit={data.transformations.limit}
          />
        )}
        {data.creditsLimit != null && (
          <Metric label="Credits" used={data.creditsUsed || 0} limit={data.creditsLimit} />
        )}
      </div>
    )}
  </ServiceCard>
);

export default AdminUsage;
