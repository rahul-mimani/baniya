// Skeleton screens for client-facing pages. Each mirrors the actual layout of
// its target view so the transition from skeleton → real content is visually
// stable (no flicker, no jumpy re-layout).
//
// Animation: a slow shimmer (~1.6s loop), tinted blue to fit the palette.

import React from 'react';
import { Card, CardContent } from '../ui/card';
import { Skeleton } from '../ui/skeleton';
import { cn } from '../../lib/utils';


// ---------------------------------------------------------------------------
// InlineSkeleton — small shimmer block usable inside text (replaces "0" /
// "₹0" / count placeholders that would otherwise flash before real values
// land). Renders as a <span> so it can sit inside <p>, <h1>, badges, etc.
//
// Usage:
//   {loading ? <InlineSkeleton width="3.5em" /> : fmtINR(total)}
// ---------------------------------------------------------------------------
export const InlineSkeleton: React.FC<{
  width?: string;
  className?: string;
}> = ({ width = '3ch', className }) => (
  <span
    aria-hidden
    className={cn(
      'inline-block align-middle rounded bg-gradient-to-r from-slate-200/70 via-slate-100 to-slate-200/70 bg-[length:200%_100%]',
      className,
    )}
    style={{
      width,
      // Match the line-height of surrounding text. 0.7em looks balanced
      // sitting inside h-of-em text without making the line taller.
      height: '0.75em',
      animation: 'shimmer 1.6s ease-in-out infinite',
    }}
  />
);

/** Reusable bar — replaces `<Skeleton className="h-X w-Y" />` with a slight
 *  blue tint so client skeletons feel consistent with the brand. */
const Bar: React.FC<{ className?: string }> = ({ className }) => (
  <Skeleton
    className={cn(
      'bg-gradient-to-br from-sky-100 via-blue-50 to-sky-100 bg-[length:200%_100%]',
      className,
    )}
  />
);


// ---------------------------------------------------------------------------
// Hero skeleton — used on ClientHome above the stat cards.
// ---------------------------------------------------------------------------
export const HeroSkeleton: React.FC = () => (
  <Card className="mb-6 overflow-hidden border-0 bg-gradient-to-br from-blue-50 via-sky-50 to-indigo-50 shadow-xl shadow-blue-200/30 relative">
    <CardContent className="p-6 sm:p-8 relative">
      <Bar className="h-3 w-20 mb-3 rounded-full" />
      <Bar className="h-9 w-56 mb-3 rounded-md" />
      <div className="flex items-center gap-2 mt-3">
        <Bar className="h-5 w-14 rounded-full" />
        <Bar className="h-3.5 w-40 rounded" />
      </div>
    </CardContent>
  </Card>
);


// ---------------------------------------------------------------------------
// Stat cards — three side-by-side cards on ClientHome.
// ---------------------------------------------------------------------------
export const StatsRowSkeleton: React.FC = () => (
  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 mb-6">
    {[0, 1, 2].map(i => (
      <Card key={i} className="border-2 border-blue-100">
        <CardContent className="p-4">
          <Bar className="h-5 w-5 mb-2 rounded" />
          <Bar className="h-2.5 w-16 mb-2 rounded-full" />
          <Bar className="h-6 w-24 rounded" />
        </CardContent>
      </Card>
    ))}
  </div>
);


// ---------------------------------------------------------------------------
// Bill row skeleton — used in the bills list (ClientBills) and recent-bills
// preview on ClientHome.
// ---------------------------------------------------------------------------
interface BillRowSkeletonProps {
  /** How many rows to render. */
  count?: number;
  /** Compact = no item-count line, used in ClientHome's preview list. */
  compact?: boolean;
}

export const BillRowSkeleton: React.FC<BillRowSkeletonProps> = ({ count = 4, compact = false }) => (
  <div className="space-y-3">
    {Array.from({ length: count }, (_, i) => (
      <Card key={i} className="overflow-hidden">
        <div className="p-4 sm:p-5 flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex items-center gap-2">
              <Bar className="h-4 w-20 rounded" />
              <Bar className="h-4 w-12 rounded-full" />
            </div>
            {!compact && <Bar className="h-3 w-44 rounded" />}
          </div>
          <div className="text-right flex-shrink-0 space-y-1.5">
            <Bar className="h-4 w-20 ml-auto rounded" />
            {!compact && <Bar className="h-3 w-14 ml-auto rounded" />}
          </div>
        </div>
      </Card>
    ))}
  </div>
);


// ---------------------------------------------------------------------------
// Deal card skeleton — used in ClientDeals' "Active deals" grid + the
// preview block on ClientHome.
// ---------------------------------------------------------------------------
export const DealCardSkeleton: React.FC<{ count?: number }> = ({ count = 2 }) => (
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
    {Array.from({ length: count }, (_, i) => (
      <div
        key={i}
        className="relative bg-gradient-to-br from-sky-200 via-blue-200 to-indigo-200 rounded-2xl shadow-lg overflow-hidden p-5"
      >
        <div className="absolute top-0 right-0 w-40 h-40 bg-white/20 rounded-full -translate-y-20 translate-x-20 blur-2xl" />
        <div className="relative space-y-3">
          <div className="flex items-start justify-between">
            <Bar className="h-5 w-16 rounded-full bg-white/40" />
            <Bar className="h-3 w-14 rounded bg-white/40" />
          </div>
          <Bar className="h-5 w-40 rounded bg-white/40" />
          <Bar className="h-3 w-full rounded bg-white/40" />
          <Bar className="h-3 w-3/4 rounded bg-white/40" />
        </div>
      </div>
    ))}
  </div>
);


// ---------------------------------------------------------------------------
// Product card skeleton — used in ClientDeals' "Available products" grid.
// Mirrors the actual card layout: hero image area + name + description + price row.
// ---------------------------------------------------------------------------
export const ProductCardSkeleton: React.FC<{ count?: number }> = ({ count = 6 }) => (
  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
    {Array.from({ length: count }, (_, i) => (
      <Card key={i} className="overflow-hidden flex flex-col">
        <div className="p-3 pb-0">
          <Bar className="aspect-[4/3] w-full rounded-lg" />
        </div>
        <CardContent className="p-4 flex-1 flex flex-col">
          <div className="flex gap-1 mb-2">
            <Bar className="h-3.5 w-12 rounded-full" />
            <Bar className="h-3.5 w-14 rounded-full" />
          </div>
          <Bar className="h-4 w-3/4 mb-2 rounded" />
          <Bar className="h-3 w-full mb-1.5 rounded" />
          <Bar className="h-3 w-2/3 mb-4 rounded" />
          <div className="flex items-baseline justify-between mt-auto pt-3 border-t border-blue-100">
            <Bar className="h-7 w-20 rounded" />
            <Bar className="h-7 w-16 rounded" />
          </div>
        </CardContent>
      </Card>
    ))}
  </div>
);


// ---------------------------------------------------------------------------
// Full-page composites — what each Client route shows while data is loading.
// ---------------------------------------------------------------------------

export const ClientHomeSkeleton: React.FC = () => (
  <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto">
    <HeroSkeleton />
    <StatsRowSkeleton />
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
      <Card>
        <div className="px-5 py-3 border-b flex items-center justify-between">
          <div>
            <Bar className="h-4 w-28 mb-1 rounded" />
            <Bar className="h-3 w-44 rounded" />
          </div>
          <Bar className="h-7 w-16 rounded" />
        </div>
        <CardContent className="space-y-2 p-4">
          <BillRowSkeleton count={3} compact />
        </CardContent>
      </Card>
      <Card>
        <div className="px-5 py-3 border-b flex items-center justify-between">
          <div>
            <Bar className="h-4 w-28 mb-1 rounded" />
            <Bar className="h-3 w-44 rounded" />
          </div>
          <Bar className="h-7 w-16 rounded" />
        </div>
        <CardContent className="space-y-2 p-4">
          {[0, 1, 2].map(i => (
            <div key={i} className="p-3 border-2 border-dashed border-sky-200 rounded-lg space-y-2">
              <div className="flex items-center justify-between">
                <Bar className="h-3.5 w-40 rounded" />
                <Bar className="h-4 w-12 rounded-full" />
              </div>
              <Bar className="h-2.5 w-3/4 rounded" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  </div>
);


export const ClientBillsSkeleton: React.FC = () => (
  <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto">
    <header className="mb-6">
      <Bar className="h-8 w-40 mb-2 rounded" />
      <Bar className="h-3.5 w-64 rounded" />
    </header>
    <BillRowSkeleton count={5} />
  </div>
);


export const ClientDealsSkeleton: React.FC = () => (
  <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto">
    <header className="mb-6">
      <Bar className="h-8 w-52 mb-2 rounded" />
      <Bar className="h-3.5 w-72 rounded" />
    </header>
    <section className="mb-8">
      <Bar className="h-3 w-28 mb-3 rounded-full" />
      <DealCardSkeleton count={2} />
    </section>
    <section>
      <Bar className="h-3 w-32 mb-3 rounded-full" />
      <ProductCardSkeleton count={6} />
    </section>
  </div>
);
