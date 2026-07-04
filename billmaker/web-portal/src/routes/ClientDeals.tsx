import React, { useMemo, useState } from 'react';
import {
  Sparkles, Package, Clock, ChevronDown, Eye, Search, X,
  ArrowUpDown, Loader2, SlidersHorizontal,
} from 'lucide-react';
import { fmtINR, labelColorClasses, dealPriceFor } from '../data/dummyData';
import { useClientMe, useClientProducts, useClientDeals, useClientLabels } from '../lib/clientData';
import { useT } from '../lib/i18n';
import { ClientDealsSkeleton } from '../components/client/Skeletons';
import { ProductDetailModal } from '../components/client/ProductDetailModal';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { ClassBadge } from '../components/ClassBadge';
import { LazyImage } from '../components/LazyImage';
import { usePagination } from '../hooks/usePagination';
import { cn } from '../lib/utils';
import type { Product } from '../types';

type ProductSort = 'name_asc' | 'name_desc' | 'price_asc' | 'price_desc';

const SORTS: { key: ProductSort; label: string }[] = [
  { key: 'name_asc',   label: 'Name A → Z' },
  { key: 'name_desc',  label: 'Name Z → A' },
  { key: 'price_asc',  label: 'Price: low → high' },
  { key: 'price_desc', label: 'Price: high → low' },
];

const getProductPrice = (p: Product, classKey: string): number => {
  const apiPrice = (p as any).price;
  if (typeof apiPrice === 'number') return apiPrice;
  return (p.prices as any)?.[classKey] || 0;
};

const PAGE_SIZE = 6;

const gradients: Record<string, string> = {
  sky: 'from-sky-500 via-sky-600 to-sky-700',
  amber: 'from-amber-500 via-orange-500 to-amber-700',
  rose: 'from-rose-500 via-pink-600 to-rose-700',
  indigo: 'from-indigo-500 via-violet-500 to-purple-700',
};

const ClientDeals: React.FC = () => {
  const { me, loading: meLoading } = useClientMe();
  const { products, loading: productsLoading } = useClientProducts();
  const { deals, loading: dealsLoading } = useClientDeals();
  const { labels } = useClientLabels();
  const { t } = useT();

  // Product the user is currently viewing in the detail modal.
  const [activeProduct, setActiveProduct] = useState<Product | null>(null);

  // Search + filter + sort state for the Products section.
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<ProductSort>('name_asc');
  const [activeLabelIds, setActiveLabelIds] = useState<Set<string>>(new Set());

  // Labels actually used on at least one product — drives the chip row.
  const productLabels = useMemo(() => {
    const used = new Set<string>();
    for (const p of products) for (const id of p.labelIds || []) used.add(id);
    return labels.filter(l => used.has(l.id));
  }, [products, labels]);

  // Filter + sort BEFORE pagination so the user sees all matches, not just
  // matches on the first page.
  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    const classKey = me?.class || '';
    let list = products.slice();
    if (q) {
      list = list.filter(p =>
        p.name.toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q) ||
        p.labelIds.some(id => {
          const l = labels.find(x => x.id === id);
          return l ? l.name.toLowerCase().includes(q) : false;
        }),
      );
    }
    if (activeLabelIds.size > 0) {
      list = list.filter(p => p.labelIds.some(id => activeLabelIds.has(id)));
    }
    list.sort((a, b) => {
      switch (sort) {
        case 'name_desc':  return b.name.localeCompare(a.name);
        case 'price_asc':  return getProductPrice(a, classKey) - getProductPrice(b, classKey);
        case 'price_desc': return getProductPrice(b, classKey) - getProductPrice(a, classKey);
        case 'name_asc':
        default:           return a.name.localeCompare(b.name);
      }
    });
    return list;
  }, [products, labels, search, sort, activeLabelIds, me?.class]);

  // pager hook must always be called — pass the (possibly empty) products list.
  const pager = usePagination(filteredProducts, {
    pageSize: PAGE_SIZE,
    resetKey: `${me?.id || ''}|${search}|${sort}|${Array.from(activeLabelIds).sort().join(',')}|${filteredProducts.length}`,
  });

  const loading = meLoading || productsLoading;
  if (loading && !me) {
    return <ClientDealsSkeleton />;
  }
  if (!me) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        No customer profile is linked to this login.
      </div>
    );
  }

  const toggleLabel = (id: string) =>
    setActiveLabelIds(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const myDeals = deals;
  const anyFilterActive = !!search.trim() || activeLabelIds.size > 0;

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{t('deals.title')}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Prices below are for <ClassBadge code={me.class} nameOnly className="inline-flex" /> — your tier.
        </p>
      </header>

      {(dealsLoading || myDeals.length > 0) && (
        <section className="mb-8">
          <h2 className="text-xs sm:text-sm font-bold text-muted-foreground uppercase tracking-widest mb-3 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-accent" /> Active deals
          </h2>
          {dealsLoading && myDeals.length === 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
              {Array.from({ length: 2 }, (_, i) => <DealCardSkeleton key={`sk-${i}`} />)}
            </div>
          ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
            {myDeals.map(d => {
              const gradient = gradients[d.bannerColor || 'sky'];
              const daysLeft = Math.ceil((new Date(d.validUntil).getTime() - Date.now()) / (1000 * 60 * 60 * 24));

              // Resolve each deal product into a display row for this client's class.
              // Note: products served from the auth-service replica already have
              // enabledClasses stripped, so we check `prices[me.class]` instead.
              const dealProductRows = d.items
                .map(it => {
                  const p = products.find(p => p.id === it.productId);
                  if (!p) return null;
                  const { price, original, isOverride, isDiscounted } = dealPriceFor(d, p, me.class);
                  return { product: p, price, original, isOverride, isDiscounted };
                })
                .filter((r): r is NonNullable<typeof r> => r !== null);

              return (
                <div
                  key={d.id}
                  className={`relative bg-gradient-to-br ${gradient} text-white rounded-2xl shadow-xl overflow-hidden`}
                >
                  <div className="absolute top-0 right-0 w-48 h-48 bg-white/10 rounded-full -translate-y-24 translate-x-24 blur-3xl pointer-events-none" />
                  <div className="relative p-5">
                    <div className="flex items-start justify-between mb-3">
                      {d.discountPct > 0 ? (
                        <Badge className="bg-white/25 text-white border-white/40 backdrop-blur">
                          {d.discountPct}% OFF
                        </Badge>
                      ) : (
                        <Badge className="bg-white/25 text-white border-white/40 backdrop-blur">
                          DEAL
                        </Badge>
                      )}
                      <div className="text-right text-xs">
                        <p className="opacity-80 flex items-center gap-1 justify-end">
                          <Clock className="h-3 w-3" />
                          {daysLeft > 0 ? `${daysLeft}d left` : 'Expired'}
                        </p>
                      </div>
                    </div>
                    <p className="text-xl font-bold leading-tight">{d.title}</p>
                    <p className="text-sm opacity-90 mt-2">{d.description}</p>

                    {dealProductRows.length > 0 && (
                      <div className="mt-4 pt-4 border-t border-white/20 space-y-1.5">
                        <p className="text-[10px] uppercase tracking-widest font-bold opacity-80 mb-1">
                          Included products
                        </p>
                        {dealProductRows.map(({ product, price, original, isOverride, isDiscounted }) => (
                          <div key={product.id} className="flex items-center justify-between gap-3 bg-white/15 backdrop-blur rounded-lg px-2.5 py-1.5">
                            <p className="text-sm font-semibold truncate min-w-0 flex-1">{product.name}</p>
                            <div className="text-right flex-shrink-0 flex items-baseline gap-1.5">
                              {isDiscounted && original > 0 && original !== price && (
                                <span className="text-[10px] opacity-70 line-through">{fmtINR(original)}</span>
                              )}
                              <span className="font-bold text-sm">{fmtINR(price)}</span>
                              {isOverride && (
                                <span className="text-[8px] uppercase tracking-wider bg-white/30 px-1 py-0.5 rounded font-bold">
                                  Deal
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            </div>
          )}
        </section>
      )}

      <section>
        <div className="flex flex-wrap items-end justify-between gap-2 mb-3">
          <h2 className="text-xs sm:text-sm font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
            <Package className="h-4 w-4 text-secondary" /> Available products
          </h2>
          {pager.total > 0 && (
            <p className="text-[11px] text-muted-foreground font-semibold">
              Showing {pager.showing} of {pager.total}
              {anyFilterActive && <span className="text-blue-600"> · filtered from {products.length}</span>}
            </p>
          )}
        </div>

        {/* Search + sort */}
        {(productsLoading || products.length > 0) && (
          <div className="mb-3 flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search by name, label, description…"
                className="pl-9 pr-9 h-10 bg-white border-blue-200/70 focus-visible:ring-blue-400/40 focus:border-blue-400"
                inputMode="search"
                disabled={productsLoading && products.length === 0}
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="relative sm:w-56">
              <ArrowUpDown className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
              <select
                value={sort}
                onChange={e => setSort(e.target.value as ProductSort)}
                className="w-full h-10 pl-9 pr-3 rounded-md border border-blue-200/70 bg-white text-sm font-medium focus:outline-none focus:ring-2 focus:ring-blue-400/40 focus:border-blue-400 transition appearance-none"
              >
                {SORTS.map(s => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* Label filter chips — quick-tap multi-select. Only shown if labels exist. */}
        {productLabels.length > 0 && (
          <div className="mb-4 flex items-center flex-wrap gap-1.5">
            <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold mr-1">
              Filter by label
            </span>
            {productLabels.map(l => {
              const isActive = activeLabelIds.has(l.id);
              return (
                <button
                  key={l.id}
                  onClick={() => toggleLabel(l.id)}
                  className={cn(
                    'text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full border transition',
                    isActive
                      ? `${labelColorClasses[l.color]} ring-2 ring-offset-1 ring-current shadow-sm`
                      : 'bg-white border-slate-200 text-slate-500 hover:border-blue-300 hover:text-slate-700',
                  )}
                  aria-pressed={isActive}
                >
                  {l.name}
                </button>
              );
            })}
            {activeLabelIds.size > 0 && (
              <button
                onClick={() => setActiveLabelIds(new Set())}
                className="text-[10px] uppercase tracking-wider text-slate-500 hover:text-blue-700 underline ml-1"
              >
                Clear
              </button>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
          {productsLoading && products.length === 0 ? (
            // Products are still loading — show grid of skeleton cards instead
            // of "No products available" flash.
            Array.from({ length: 6 }, (_, i) => <ProductCardSkeleton key={`sk-${i}`} />)
          ) : pager.total === 0 && anyFilterActive ? (
            <Card className="col-span-full p-8 text-center">
              <Search className="h-10 w-10 mx-auto text-muted-foreground mb-2" />
              <p className="text-sm font-semibold">No products match your filters</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => { setSearch(''); setActiveLabelIds(new Set()); }}
              >
                Clear all filters
              </Button>
            </Card>
          ) : pager.total === 0 ? (
            <Card className="col-span-full p-8 text-center text-muted-foreground">
              <Package className="h-10 w-10 mx-auto mb-2" />
              <p className="text-sm">No products available for your tier yet.</p>
            </Card>
          ) : pager.page.map((p, idx) => {
            // First page: load immediately. Later pages: keep the 3s prototype-delay so the
            // skeleton story is still visible for newly-revealed cards.
            const isNewlyPaged = idx >= pager.newPageStart && pager.newPageStart > 0;
            const heroDelay = isNewlyPaged ? 3000 : 0;
            const hasMultipleImages = p.images && p.images.length > 1;
            return (
              <Card
                key={p.id}
                className="hover:shadow-lg hover:shadow-blue-200/40 hover:-translate-y-0.5 transition group overflow-hidden flex flex-col cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-400/60"
                onClick={() => setActiveProduct(p)}
                role="button"
                tabIndex={0}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveProduct(p); }
                }}
              >
                {/* Hero image only — secondary images live in the modal */}
                <div className="p-3 pb-0">
                  <div className="relative rounded-lg overflow-hidden border border-blue-100 bg-white">
                    <LazyImage
                      src={p.images?.[0] || ''}
                      alt={p.name}
                      aspectClass="aspect-[4/3]"
                      fit="contain"
                      delayMs={heroDelay}
                    />
                    {/* Subtle hover overlay with view-more hint */}
                    <div className="absolute inset-0 bg-gradient-to-t from-blue-900/50 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition flex items-end justify-center pb-3 pointer-events-none">
                      <span className="text-[10px] uppercase tracking-widest font-bold text-white bg-blue-900/40 backdrop-blur px-2 py-1 rounded-full inline-flex items-center gap-1">
                        <Eye className="h-3 w-3" /> View details
                      </span>
                    </div>
                    {/* Image count badge (just a number, no thumbnails) */}
                    {hasMultipleImages && (
                      <div className="absolute top-2 right-2 bg-white/90 backdrop-blur px-2 py-0.5 rounded-full border border-blue-100 text-[10px] font-bold text-blue-700">
                        +{p.images!.length - 1}
                      </div>
                    )}
                  </div>
                </div>
                <CardContent className="p-4 flex-1 flex flex-col">
                  <div className="flex flex-wrap gap-1 mb-2">
                    {p.labelIds.map(lid => {
                      const l = labels.find(x => x.id === lid);
                      if (!l) return null;
                      return (
                        <span key={l.id} className={`text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${labelColorClasses[l.color]}`}>
                          {l.name}
                        </span>
                      );
                    })}
                  </div>
                  <p className="font-bold text-foreground">{p.name}</p>
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2 flex-1">{p.description}</p>

                  <div className="flex items-baseline justify-between mt-4 pt-3 border-t border-blue-100">
                    <p className="text-2xl font-bold bg-gradient-to-r from-sky-500 via-blue-600 to-indigo-600 bg-clip-text text-transparent">
                      {(() => {
                        // Prefer the server-resolved price (works regardless of which
                        // class key the server picked). Fall back to the per-class map
                        // for older API responses.
                        const apiPrice = (p as any).price;
                        const fallback = p.prices[me.class] || 0;
                        const price = typeof apiPrice === 'number' ? apiPrice : fallback;
                        return price > 0 ? fmtINR(price) : 'Quote';
                      })()}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={e => { e.stopPropagation(); setActiveProduct(p); }}
                    >
                      <Eye className="h-3 w-3" /> Details
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}

          {/* Skeleton placeholders while loading next page */}
          {pager.loadingMore && Array.from({ length: pager.skeletonCount }, (_, i) => (
            <ProductCardSkeleton key={`sk-${i}`} />
          ))}
        </div>

        {pager.hasMore && (
          <>
            {/* Auto-load sentinel — triggers loadMore() when scrolled near */}
            <div ref={pager.sentinelRef} aria-hidden className="h-1" />
            <div className="flex items-center justify-center mt-6 gap-3 text-xs text-muted-foreground">
              <span>Showing {pager.showing} of {pager.total}</span>
              <Button variant="outline" size="sm" onClick={pager.loadMore} disabled={pager.loadingMore}>
                {pager.loadingMore
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</>
                  : <><ChevronDown className="h-3.5 w-3.5" /> Load more</>}
              </Button>
            </div>
          </>
        )}
      </section>

      {/* Product detail modal */}
      <ProductDetailModal
        product={activeProduct}
        labels={labels}
        classKey={me.class}
        open={!!activeProduct}
        onOpenChange={open => { if (!open) setActiveProduct(null); }}
      />
    </div>
  );
};

// Skeleton card matching the product-card layout (hero image + chips + price row).
const ProductCardSkeleton: React.FC = () => (
  <Card className="overflow-hidden flex flex-col animate-pulse">
    <div className="p-3 pb-0">
      <div className="aspect-[4/3] rounded-lg bg-gradient-to-br from-sky-100 via-slate-100 to-blue-100" />
    </div>
    <CardContent className="p-4 flex-1 flex flex-col">
      <div className="flex gap-1 mb-2">
        <div className="h-3.5 w-12 rounded-full bg-slate-200" />
        <div className="h-3.5 w-14 rounded-full bg-slate-100" />
      </div>
      <div className="h-4 w-3/4 bg-slate-200 rounded mb-2" />
      <div className="h-3 w-full bg-slate-100 rounded mb-1.5" />
      <div className="h-3 w-2/3 bg-slate-100 rounded mb-4" />
      <div className="flex items-baseline justify-between mt-auto pt-3 border-t border-blue-100">
        <div className="h-7 w-20 bg-slate-200 rounded" />
        <div className="h-7 w-16 bg-slate-100 rounded" />
      </div>
    </CardContent>
  </Card>
);

// Skeleton deal banner — mirrors the colorful deal card layout.
const DealCardSkeleton: React.FC = () => (
  <div className="relative bg-gradient-to-br from-sky-200 via-blue-200 to-indigo-200 text-white rounded-2xl shadow-xl overflow-hidden animate-pulse">
    <div className="p-5 space-y-3">
      <div className="flex items-start justify-between">
        <div className="h-5 w-16 rounded-full bg-white/40" />
        <div className="h-3 w-14 bg-white/40 rounded" />
      </div>
      <div className="h-5 w-3/4 bg-white/40 rounded" />
      <div className="h-3 w-full bg-white/30 rounded" />
      <div className="h-3 w-1/2 bg-white/30 rounded" />
    </div>
  </div>
);

export default ClientDeals;
