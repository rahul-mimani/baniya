// ClientTier — shows the customer their current rank in the loyalty
// hierarchy. Tiers above the current one are styled to feel aspirational
// (brighter, with "what you'd unlock" hints); tiers at or below are marked
// as cleared. The whole page is designed to gently push the customer to
// engage more and rise up the ladder.

import React, { useMemo } from 'react';
import { motion } from 'framer-motion';
import {
  Crown, Award, Star, Sparkles, UserCheck, ArrowUp, ChevronRight,
  Phone, ShieldCheck, Tag, BadgeCheck, CheckCircle2, Lock,
} from 'lucide-react';
import { Card, CardContent } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { useClientMe } from '../lib/clientData';
import { useT } from '../lib/i18n';
import { store, classDisplayName, classBadgeClasses } from '../data/dummyData';
import { ALL_CLASS_CODES, type CustomerClass } from '../types';
import { cn } from '../lib/utils';

// Generic per-rank content. Index 0 = highest tier (Class A in canonical order).
const RANK_META: {
  icon: React.ComponentType<{ className?: string }>;
  tagline: string;
  description: string;
  perks: string[];
  unlockHint: string;
}[] = [
  {
    icon: Crown,
    tagline: 'Top tier — our most valued customers',
    description: "You're at the highest level. Best pricing on every product, priority access to new deals, and the warmest welcome whenever you visit.",
    perks: ['Best pricing across catalog', 'Early access to seasonal deals', 'Priority quote responses', 'Custom requests welcomed'],
    unlockHint: 'The pinnacle. Build the strongest relationship to land here.',
  },
  {
    icon: Award,
    tagline: 'Premium tier — significant savings',
    description: 'You unlock noticeably better prices than the standard catalog and get early visibility on deals.',
    perks: ['Better-than-standard pricing', 'Early deal access', 'Priority on bulk quotes'],
    unlockHint: 'Strong, recurring business unlocks Premium status.',
  },
  {
    icon: Star,
    tagline: 'Regular tier — our trusted base',
    description: 'Standard catalog pricing applies. As a recurring customer, you have access to the full product range and most ongoing deals.',
    perks: ['Standard catalog pricing', 'Access to most deals', 'Full product visibility'],
    unlockHint: 'Consistent purchase activity moves you up to Regular.',
  },
  {
    icon: Sparkles,
    tagline: 'Discovery tier — getting to know us',
    description: 'A great place to start exploring the full catalog. Build up purchase history to unlock higher tiers.',
    perks: ['Full catalog visibility', 'Standard newcomer pricing', 'Quote requests welcomed'],
    unlockHint: 'Place a few orders to graduate from Discovery.',
  },
  {
    icon: UserCheck,
    tagline: 'Welcome tier — your starting line',
    description: "You're just beginning your journey. As you continue to engage, your tier can be reviewed and adjusted by admin.",
    perks: ['Welcome catalog access', 'Open communication via quote requests', 'Friendly first-time service'],
    unlockHint: 'The starting tier for newcomers.',
  },
];


const ClientTier: React.FC = () => {
  const { me, loading } = useClientMe();
  const { t } = useT();

  const activeCodes = useMemo(
    () => new Set(store.classDefs.map(d => d.code)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [me],
  );

  if (loading && !me) {
    return <ClientTierSkeleton />;
  }
  if (!me) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        No customer profile linked. Please contact admin.
      </div>
    );
  }

  const myClass = me.class as CustomerClass;
  const myIndex = ALL_CLASS_CODES.indexOf(myClass);
  const totalTiers = ALL_CLASS_CODES.length;

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-3xl mx-auto">
      {/* Hero — current tier */}
      <CurrentTierHero code={myClass} rankFromTop={myIndex + 1} totalTiers={totalTiers} />

      {/* Aspirational header for tiers above */}
      {myIndex > 0 && (
        <motion.div
          className="mt-6 mb-2 flex items-center gap-2"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
        >
          <ArrowUp className="h-4 w-4 text-amber-600 animate-bounce" style={{ animationDuration: '2s' }} />
          <p className="text-xs font-bold text-amber-700 uppercase tracking-widest">
            {myIndex === 1 ? t('tier.oneTierAbove') : `${myIndex} ${t('tier.tiersAbove')}`}
          </p>
        </motion.div>
      )}

      {/* Tier ladder — render in order: ABOVE (aspirational), THEN current,
          THEN below (completed). All rendered in canonical A→E top-to-bottom
          but styled by their position relative to the user. */}
      <div className="space-y-2 sm:space-y-3">
        {ALL_CLASS_CODES.map((code, i) => {
          const meta = RANK_META[i];
          const isActive = activeCodes.has(code);
          const isMine = code === myClass;
          const isAboveMine = myIndex > -1 && i < myIndex;
          const isBelowMine = myIndex > -1 && i > myIndex;
          return (
            <TierRow
              key={code}
              code={code}
              rank={i + 1}
              totalTiers={totalTiers}
              meta={meta}
              isActive={isActive}
              isMine={isMine}
              isAboveMine={isAboveMine}
              isBelowMine={isBelowMine}
              delay={i * 0.06}
            />
          );
        })}
      </div>

      {/* Help footer */}
      <Card className="mt-6 bg-gradient-to-br from-sky-50 to-blue-50 border-blue-100">
        <CardContent className="p-4 sm:p-5">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center flex-shrink-0">
              <Phone className="h-4 w-4" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-slate-900">{t('tier.help.title')}</p>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                {t('tier.help.body')}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};


// ===========================================================================
// Hero — current tier card (unchanged from prior version, kept as a focal point)
// ===========================================================================
const CurrentTierHero: React.FC<{
  code: CustomerClass;
  rankFromTop: number;
  totalTiers: number;
}> = ({ code, rankFromTop, totalTiers }) => {
  const meta = RANK_META[rankFromTop - 1];
  const Icon = meta.icon;
  const friendlyName = classDisplayName(code);
  const percentile = ((totalTiers - rankFromTop + 1) / totalTiers) * 100;
  const { t } = useT();

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 280, damping: 26 }}
    >
      <Card className="relative overflow-hidden border-2 bg-gradient-to-br from-sky-600 via-blue-700 to-indigo-800 text-white shadow-2xl shadow-blue-500/30">
        <div className="absolute top-0 right-0 w-64 h-64 bg-white/10 rounded-full -translate-y-32 translate-x-32 blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 left-0 w-48 h-48 bg-white/10 rounded-full translate-y-24 -translate-x-24 blur-3xl pointer-events-none" />

        <CardContent className="p-6 sm:p-8 relative">
          <p className="text-[10px] uppercase tracking-[0.35em] font-semibold opacity-80 mb-3">
            {t('tier.your')}
          </p>

          <div className="flex items-center gap-4 mb-4">
            <motion.div
              className="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-white/15 backdrop-blur border border-white/25 flex items-center justify-center shadow-lg"
              animate={{ rotate: [0, -3, 3, 0] }}
              transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
            >
              <Icon className="h-7 w-7 sm:h-8 sm:w-8" />
            </motion.div>
            <div className="min-w-0">
              <h1 className="text-2xl sm:text-4xl font-bold tracking-tight leading-tight">
                {friendlyName}
              </h1>
              <p className="text-xs sm:text-sm opacity-90 mt-0.5">{meta.tagline}</p>
            </div>
          </div>

          <div className="mt-5">
            <div className="flex items-center justify-between text-[11px] mb-1.5 opacity-90">
              <span>{t('tier.rank')} {rankFromTop} {t('tier.of')} {totalTiers}</span>
              <span className="font-mono">{percentile.toFixed(0)}%</span>
            </div>
            <div className="h-2 rounded-full bg-white/15 overflow-hidden">
              <motion.div
                className="h-full bg-gradient-to-r from-amber-300 via-yellow-200 to-amber-300 rounded-full"
                initial={{ width: 0 }}
                animate={{ width: `${percentile}%` }}
                transition={{ duration: 1.2, ease: 'easeOut' }}
              />
            </div>
          </div>

          <p className="text-sm sm:text-base mt-5 leading-relaxed opacity-95">
            {meta.description}
          </p>

          <div className="mt-5 flex flex-wrap gap-1.5">
            {meta.perks.map(p => (
              <span
                key={p}
                className="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-full bg-white/15 backdrop-blur border border-white/20"
              >
                <Tag className="h-2.5 w-2.5" />
                {p}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
};


// ===========================================================================
// One row in the ladder. Styled by position relative to current:
//   - isAboveMine: amber/gold gradient, "Unlock by..." hint, locked icon
//   - isMine:     bright blue border + glow
//   - isBelowMine: subtle check icon + slightly muted (you've cleared this)
// ===========================================================================
interface TierRowProps {
  code: CustomerClass;
  rank: number;
  totalTiers: number;
  meta: typeof RANK_META[number];
  isActive: boolean;
  isMine: boolean;
  isAboveMine: boolean;
  isBelowMine: boolean;
  delay: number;
}

const TierRow: React.FC<TierRowProps> = ({
  code, rank, totalTiers, meta, isActive, isMine, isAboveMine, isBelowMine, delay,
}) => {
  const Icon = meta.icon;
  const friendlyName = classDisplayName(code);
  const isTop = rank === 1;
  const { t } = useT();

  return (
    <motion.div
      initial={{ opacity: 0, x: isAboveMine ? -12 : 12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ type: 'spring', stiffness: 280, damping: 28, delay }}
    >
      <Card className={cn(
        'overflow-hidden transition relative',
        isMine
          ? 'border-2 border-blue-500 shadow-lg shadow-blue-500/20'
          : isAboveMine
            ? 'border-2 border-amber-300/60 shadow-md shadow-amber-200/30 bg-gradient-to-r from-amber-50/40 to-yellow-50/40'
            : 'border border-slate-200 opacity-75',
        !isActive && 'opacity-40',
      )}>
        {/* Left rail color */}
        <div className={cn(
          'absolute left-0 top-0 bottom-0 w-1',
          isMine ? 'bg-blue-500' :
          isAboveMine ? 'bg-gradient-to-b from-amber-400 to-yellow-500' :
          'bg-slate-300',
        )} />

        <CardContent className="pl-5 pr-3 py-3 sm:py-4 flex items-center gap-3">
          {/* Rank icon */}
          <div className={cn(
            'flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center text-xs font-bold tracking-wider border',
            isMine
              ? 'bg-gradient-to-br from-sky-500 to-blue-700 text-white border-blue-700 shadow'
              : isAboveMine
                ? 'bg-gradient-to-br from-amber-300 to-yellow-500 text-amber-900 border-amber-400 shadow-md shadow-amber-200/50'
                : isBelowMine
                  ? 'bg-emerald-50 text-emerald-600 border-emerald-200'
                  : 'bg-slate-50 text-slate-600 border-slate-200',
          )}>
            <Icon className="h-5 w-5" />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <p className={cn(
                'font-bold',
                isMine ? 'text-blue-700' :
                isAboveMine ? 'text-amber-900' :
                'text-slate-800',
              )}>
                {friendlyName}
              </p>
              <span className={cn(
                'text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border',
                classBadgeClasses(code),
              )}>
                Class {code}
              </span>

              {isMine && (
                <span className="text-[10px] font-bold uppercase tracking-wider bg-blue-600 text-white px-2 py-0.5 rounded-full shadow-sm">
                  {t('tier.youAreHere')}
                </span>
              )}
              {isAboveMine && (
                <span className="text-[10px] font-bold uppercase tracking-wider bg-amber-500 text-white px-2 py-0.5 rounded-full shadow-sm inline-flex items-center gap-0.5">
                  <Lock className="h-2.5 w-2.5" /> {t('tier.locked')}
                </span>
              )}
              {isBelowMine && (
                <span className="text-[10px] font-bold uppercase tracking-wider bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full inline-flex items-center gap-0.5">
                  <CheckCircle2 className="h-2.5 w-2.5" /> {t('tier.cleared')}
                </span>
              )}
              {!isActive && (
                <span className="text-[10px] uppercase tracking-wider text-slate-400 italic">
                  inactive
                </span>
              )}
            </div>

            <p className={cn(
              'text-[11px] mt-0.5',
              isAboveMine ? 'text-amber-700 font-medium' : 'text-muted-foreground',
            )}>
              {isTop ? 'Highest tier · ' : ''}
              Rank {rank} of {totalTiers}
            </p>

            {/* "What you'd unlock" hint — only for tiers above */}
            {isAboveMine && isActive && (
              <p className="text-xs text-amber-900 mt-2 leading-relaxed">
                <span className="font-bold">{t('tier.unlock')}: </span>
                {meta.unlockHint}
              </p>
            )}
          </div>

          {isMine && <ShieldCheck className="h-4 w-4 text-blue-500 flex-shrink-0" />}
          {isAboveMine && <ArrowUp className="h-4 w-4 text-amber-600 flex-shrink-0" />}
          {isBelowMine && <ChevronRight className="h-4 w-4 text-slate-300 flex-shrink-0" />}
        </CardContent>
      </Card>
    </motion.div>
  );
};


// ===========================================================================
// Skeleton — shown while /client/me is loading
// ===========================================================================
const ClientTierSkeleton: React.FC = () => (
  <div className="p-4 sm:p-6 lg:p-8 max-w-3xl mx-auto">
    {/* Hero skeleton */}
    <Card className="overflow-hidden border-2 bg-gradient-to-br from-sky-100 via-blue-100 to-indigo-100">
      <CardContent className="p-6 sm:p-8">
        <Skeleton className="h-3 w-20 mb-3 bg-white/40" />
        <div className="flex items-center gap-4 mb-4">
          <Skeleton className="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-white/40" />
          <div className="flex-1">
            <Skeleton className="h-7 w-44 mb-2 bg-white/40" />
            <Skeleton className="h-3 w-36 bg-white/30" />
          </div>
        </div>
        <Skeleton className="h-2 w-full rounded-full bg-white/30" />
        <Skeleton className="h-4 w-full mt-5 bg-white/30" />
        <Skeleton className="h-4 w-3/4 mt-1 bg-white/30" />
      </CardContent>
    </Card>

    {/* Ladder skeleton — 5 rows */}
    <div className="mt-6 space-y-3">
      {Array.from({ length: 5 }, (_, i) => (
        <Card key={i} className="overflow-hidden border border-slate-200">
          <CardContent className="pl-5 pr-3 py-3 sm:py-4 flex items-center gap-3">
            <Skeleton className="w-10 h-10 rounded-lg" />
            <div className="flex-1">
              <Skeleton className="h-4 w-28 mb-2" />
              <Skeleton className="h-3 w-32" />
            </div>
            <Skeleton className="h-4 w-4 rounded-full" />
          </CardContent>
        </Card>
      ))}
    </div>
  </div>
);

export default ClientTier;
