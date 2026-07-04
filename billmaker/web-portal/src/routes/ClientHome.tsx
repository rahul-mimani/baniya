import React from 'react';
import { Link } from 'react-router-dom';
import { Receipt, TrendingUp, Sparkles, ArrowRight, ShoppingBag, AlertCircle, ChevronRight } from 'lucide-react';
import { motion } from 'framer-motion';
import { fmtINR } from '../data/dummyData';
import { useClientMe, useClientBills, useClientDeals } from '../lib/clientData';
import { useT } from '../lib/i18n';
import { ClientHomeSkeleton, InlineSkeleton } from '../components/client/Skeletons';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { ClassBadge } from '../components/ClassBadge';

const ClientHome: React.FC = () => {
  const { me, loading: meLoading, error: meError } = useClientMe();
  const { bills, loading: billsLoading } = useClientBills();
  const { deals, loading: dealsLoading } = useClientDeals();
  const { t } = useT();

  const loading = meLoading || billsLoading;
  if (loading && !me) {
    return <ClientHomeSkeleton />;
  }
  if (meError) {
    return (
      <div className="p-8 text-center text-sm text-rose-600">Couldn't load your data — {meError}</div>
    );
  }
  if (!me) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        {t('home.notLinked')}
      </div>
    );
  }

  const myBills = bills; // already filtered to acknowledged
  const totalPurchased = myBills.reduce((s, b) => s + b.total, 0);
  const outstanding = myBills.reduce((s, b) => s + (b.total - b.paid), 0);
  const myDeals = deals;
  const recent = myBills.slice(0, 3); // already sorted desc by createdAt in the hook

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto">
      {/* Outstanding alert — shown at the top so the user sees it
          immediately. Hidden when there's nothing due. */}
      {!billsLoading && outstanding > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 280, damping: 26 }}
        >
          <Link to="/client/bills" className="block mb-4 group">
            <div className="rounded-xl border-2 border-rose-200 bg-gradient-to-r from-rose-50 to-amber-50 p-4 flex items-center gap-3 hover:shadow-lg hover:shadow-rose-200/40 transition">
              <div className="w-10 h-10 rounded-full bg-rose-100 border border-rose-200 flex items-center justify-center flex-shrink-0">
                <AlertCircle className="h-5 w-5 text-rose-600" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] uppercase tracking-widest text-rose-700 font-bold">{t('home.outstandingAlert')}</p>
                <p className="text-base sm:text-lg font-bold text-rose-900">
                  {fmtINR(outstanding)} <span className="text-xs font-medium text-rose-700">{t('home.outstandingDetail')}</span>
                </p>
              </div>
              <ChevronRight className="h-5 w-5 text-rose-600 flex-shrink-0 group-hover:translate-x-0.5 transition" />
            </div>
          </Link>
        </motion.div>
      )}

      {/* Hero welcome */}
      <Card className="mb-6 overflow-hidden border-0 bg-gradient-to-br from-primary via-secondary to-accent text-white shadow-xl shadow-primary/30 relative">
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/10 rounded-full -translate-y-32 translate-x-32 blur-3xl" />
        <div className="absolute bottom-0 left-0 w-48 h-48 bg-white/10 rounded-full translate-y-24 -translate-x-24 blur-3xl" />
        <CardContent className="p-6 sm:p-8 relative">
          <p className="text-xs sm:text-sm uppercase tracking-widest font-semibold opacity-90">{t('home.welcome')}</p>
          <h1 className="text-2xl sm:text-4xl font-bold mt-1 tracking-tight">{me.name}</h1>
          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <ClassBadge code={me.class} nameOnly />
            <span className="text-sm opacity-90">{me.email}</span>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 mb-6">
        <ClientStat icon={Receipt} label={t('home.myBills')} value={String(myBills.length)} accent="primary" loading={billsLoading} />
        <ClientStat icon={TrendingUp} label={t('home.totalPurchased')} value={fmtINR(totalPurchased)} accent="secondary" loading={billsLoading} />
        <ClientStat icon={ShoppingBag} label={t('home.outstanding')} value={fmtINR(outstanding)} accent={outstanding > 0 ? 'destructive' : 'muted'} loading={billsLoading} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <div>
              <CardTitle>{t('home.recentBills')}</CardTitle>
              <CardDescription>{t('home.releasedToYou')}</CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link to="/client/bills">
                {t('common.viewAll')} <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {billsLoading && recent.length === 0 ? (
              // Placeholder rows while bills are loading — keeps the panel
              // alive instead of showing "No bills released yet" briefly.
              Array.from({ length: 3 }).map((_, i) => (
                <div key={`sk-${i}`} className="flex items-center justify-between gap-3 p-3 border rounded-lg">
                  <div>
                    <InlineSkeleton width="5em" className="mb-1.5" />
                    <InlineSkeleton width="7em" className="opacity-60" />
                  </div>
                  <InlineSkeleton width="4em" />
                </div>
              ))
            ) : recent.length === 0 ? (
              <p className="text-sm text-muted-foreground italic py-8 text-center">{t('home.noBillsYet')}</p>
            ) : (
              recent.map(b => (
                <div key={b.id} className="flex items-center justify-between gap-3 p-3 border rounded-lg hover:bg-muted/40 transition">
                  <div>
                    <p className="font-mono font-bold text-primary text-sm">{b.billNumber}</p>
                    <p className="text-xs text-muted-foreground">{new Date(b.createdAt).toLocaleDateString()}</p>
                  </div>
                  <p className="font-bold">{fmtINR(b.total)}</p>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-accent" /> {t('home.dealsForYou')}
              </CardTitle>
              <CardDescription>{t('home.handpicked')}</CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link to="/client/deals">
                View all <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {dealsLoading && myDeals.length === 0 ? (
              Array.from({ length: 2 }).map((_, i) => (
                <div key={`sk-${i}`} className="p-3 border-2 border-dashed border-accent/30 rounded-lg bg-accent/5">
                  <div className="flex items-center justify-between mb-2 gap-2">
                    <InlineSkeleton width="9em" />
                    <InlineSkeleton width="3em" />
                  </div>
                  <InlineSkeleton width="80%" className="opacity-60" />
                </div>
              ))
            ) : (
              myDeals.slice(0, 3).map(d => (
                <div key={d.id} className="p-3 border-2 border-dashed border-accent/30 rounded-lg bg-accent/5 hover:border-accent/60 transition">
                  <div className="flex items-center justify-between mb-1 gap-2">
                    <p className="font-bold text-sm flex-1 truncate">{d.title}</p>
                    <Badge variant="accent">{d.discountPct}% OFF</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{d.description}</p>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

const ClientStat: React.FC<{
  icon: any;
  label: string;
  value: string;
  accent: 'primary' | 'secondary' | 'destructive' | 'muted';
  loading?: boolean;
}> = ({ icon: Icon, label, value, accent, loading }) => {
  const cls: Record<string, string> = {
    primary: 'from-primary/15 via-primary/5 to-transparent border-primary/30 text-primary',
    secondary: 'from-secondary/15 via-secondary/5 to-transparent border-secondary/30 text-secondary',
    destructive: 'from-rose-100 via-rose-50 to-transparent border-rose-300 text-rose-600',
    muted: 'from-muted via-muted/50 to-transparent border-border text-muted-foreground',
  };
  return (
    <Card className={`bg-gradient-to-br ${cls[accent]} border-2`}>
      <CardContent className="p-4">
        <Icon className="h-5 w-5 mb-2" />
        <p className="text-[10px] uppercase tracking-widest font-bold opacity-80">{label}</p>
        <p className="text-xl sm:text-2xl font-bold mt-1 text-foreground">
          {loading ? <InlineSkeleton width="4em" /> : value}
        </p>
      </CardContent>
    </Card>
  );
};

export default ClientHome;
