import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Receipt, TrendingUp, AlertCircle, Sparkles, Users, ArrowRight } from 'lucide-react';
import { store, fmtINR, onStoreChange } from '../data/dummyData';
import { useAdminAggregates } from '../lib/adminAggregates';
import { useCollectionLoaded } from '../lib/syncHooks';
import { InlineSkeleton } from '../components/client/Skeletons';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';

const AdminHome: React.FC = () => {
  const [, force] = useState(0);
  useEffect(() => onStoreChange(() => force(n => n + 1)), []);

  // All Overview tiles read from the Worker-maintained _meta/admin_aggregates
  // doc (one Firestore subscription, shared across the page). Skeleton while
  // it's loading rather than fallback computations from store.bills —
  // showing "₹1L" then jumping to "₹6L" once the doc arrives looks broken.
  //
  // productCount is maintained by:
  //   - Portal: patchAdminAggregates({productCountDelta: ±1}) on admin add/delete
  //   - Worker: incrementDocumentFields on worker-derived portal_products auto-create
  // Either way it's atomic + reflects in the subscription instantly. No
  // separate getCountFromServer query needed.
  const { value: agg, loaded: aggLoaded } = useAdminAggregates();
  const aggReady = aggLoaded && agg !== null;

  // Wait for the bills snapshot — payments are now embedded in each bill,
  // so a single subscription tells us when paid totals are accurate.
  const recentListReady = useCollectionLoaded('bills');

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">Overview</h1>
        <p className="text-sm text-muted-foreground mt-1">Snapshot of your shop's activity.</p>
      </header>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-6">
        <Stat
          icon={Users}
          label="Customers"
          value={
            // Reads from admin_aggregates.customerCount — atomic increment on
            // addCustomer (+1), archiveCustomer (-1), restoreCustomer (+1).
            // Mirrors the portal_customers subscription count without waiting
            // for the subscription to load.
            aggReady && typeof agg!.customerCount === 'number'
              ? String(agg!.customerCount)
              : <InlineSkeleton width="2.5em" />
          }
          accent="primary"
        />
        <Stat
          icon={Receipt}
          label="Products"
          value={
            // Reads from admin_aggregates.productCount — maintained by atomic
            // increment from portal (add/delete) and worker (auto-create from
            // mobile-originated bill products). One subscription, instant.
            aggReady && typeof agg!.productCount === 'number'
              ? String(agg!.productCount)
              : <InlineSkeleton width="2.5em" />
          }
          accent="secondary"
        />
        <Stat
          icon={Sparkles}
          label="Active deals"
          value={
            // Reads from admin_aggregates.dealCount — atomic increment on
            // addDeal (+1) and deleteDeal (-1). No portal_deals subscription
            // dependency for the Overview tile.
            aggReady && typeof agg!.dealCount === 'number'
              ? String(agg!.dealCount)
              : <InlineSkeleton width="2.5em" />
          }
          accent="accent"
        />
        <Stat
          icon={AlertCircle}
          label="Pending acknowledge"
          value={
            // Reads from admin_aggregates.pendingCount — maintained by atomic
            // increment from portal (ack toggle: ±1) and worker (mobile-
            // originated bill creates / acks via computeBillDelta). One
            // subscription, instant. No separate getCountFromServer query.
            aggReady && typeof agg!.pendingCount === 'number'
              ? String(agg!.pendingCount)
              : <InlineSkeleton width="2.5em" />
          }
          accent={aggReady && (agg!.pendingCount ?? 0) > 0 ? 'destructive' : 'muted'}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 mb-6">
        <Card className="relative overflow-hidden">
          <div className="absolute top-0 right-0 w-24 h-24 bg-gradient-to-br from-primary/20 to-secondary/20 rounded-full -translate-y-12 translate-x-12 blur-2xl" />
          <CardHeader className="pb-3">
            <CardDescription className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4" /> Revenue collected
            </CardDescription>
            <CardTitle className="text-3xl bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">
              {aggReady ? fmtINR(agg!.totalRevenue ?? 0) : <InlineSkeleton width="5em" />}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Sum of <code className="font-mono">paid</code> across all bills ·{' '}
            {aggReady ? fmtINR(agg!.totalBilled ?? 0) : <InlineSkeleton width="4em" />} billed total
          </CardContent>
        </Card>
        <Card className="relative overflow-hidden">
          <div className="absolute top-0 right-0 w-24 h-24 bg-gradient-to-br from-rose-500/20 to-amber-500/20 rounded-full -translate-y-12 translate-x-12 blur-2xl" />
          <CardHeader className="pb-3">
            <CardDescription className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4" /> Outstanding
            </CardDescription>
            <CardTitle className="text-3xl text-rose-600">
              {aggReady ? fmtINR(agg!.outstanding ?? 0) : <InlineSkeleton width="4em" />}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {aggReady
              ? (() => {
                  const billed = agg!.totalBilled ?? 0;
                  const outstanding = agg!.outstanding ?? 0;
                  return (
                    <>Billed − collected · {billed > 0
                      ? `${Math.round((outstanding / billed) * 100)}% of revenue still owed`
                      : 'no bills yet'}</>
                  );
                })()
              : <>Billed − collected · <InlineSkeleton width="6em" /></>}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <div>
            <CardTitle>Recent bills</CardTitle>
            <CardDescription>Latest activity across all customers</CardDescription>
          </div>
          <Button asChild variant="ghost" size="sm">
            <Link to="/admin/bills">
              View all <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {!recentListReady
            ? Array.from({ length: 5 }, (_, i) => <RecentBillRowSkeleton key={`sk-${i}`} />)
            : store.bills
            .slice()
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, 5)
            .map(b => (
              <div
                key={b.id}
                className="flex items-center justify-between gap-3 p-3 border rounded-lg hover:bg-muted/40 transition"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono font-bold text-primary text-sm">{b.billNumber}</span>
                    <Badge variant={b.acknowledged ? 'success' : 'warning'}>
                      {b.acknowledged ? 'Released' : 'Pending'}
                    </Badge>
                  </div>
                  <p className="text-sm font-semibold text-foreground truncate mt-0.5">{b.customerName}</p>
                  <p className="text-xs text-muted-foreground">{new Date(b.createdAt).toLocaleString()}</p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="font-bold text-foreground">{fmtINR(b.total)}</p>
                  {b.paid < b.total && (
                    <p className="text-xs text-rose-600 font-semibold">{fmtINR(b.total - b.paid)} due</p>
                  )}
                </div>
              </div>
            ))}
        </CardContent>
      </Card>
    </div>
  );
};

const Stat: React.FC<{
  icon: any;
  label: string;
  value: React.ReactNode;
  accent: 'primary' | 'secondary' | 'accent' | 'destructive' | 'muted';
}> = ({ icon: Icon, label, value, accent }) => {
  const cls: Record<string, string> = {
    primary: 'from-primary/10 to-primary/5 text-primary border-primary/20',
    secondary: 'from-secondary/10 to-secondary/5 text-secondary border-secondary/20',
    accent: 'from-accent/10 to-accent/5 text-accent border-accent/20',
    destructive: 'from-rose-100 to-rose-50 text-rose-600 border-rose-200',
    muted: 'from-muted to-muted/60 text-muted-foreground border-border',
  };
  return (
    <Card className={`bg-gradient-to-br ${cls[accent]} border`}>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-1">
          <Icon className="h-4 w-4" />
          <p className="text-[10px] uppercase tracking-widest font-bold">{label}</p>
        </div>
        <p className="text-2xl sm:text-3xl font-bold">{value}</p>
      </CardContent>
    </Card>
  );
};

/** Skeleton row for the Recent Bills card — matches the real row layout. */
const RecentBillRowSkeleton: React.FC = () => (
  <div className="flex items-center justify-between gap-3 p-3 border rounded-lg animate-pulse">
    <div className="min-w-0 flex-1 space-y-1.5">
      <div className="flex items-center gap-2">
        <div className="h-4 w-20 bg-slate-200 rounded" />
        <div className="h-4 w-14 bg-slate-200 rounded-full" />
      </div>
      <div className="h-4 w-40 bg-slate-200 rounded" />
      <div className="h-3 w-32 bg-slate-100 rounded" />
    </div>
    <div className="text-right flex-shrink-0 space-y-1">
      <div className="h-4 w-20 bg-slate-200 rounded ml-auto" />
      <div className="h-3 w-14 bg-slate-100 rounded ml-auto" />
    </div>
  </div>
);

export default AdminHome;
