import React, { useState, useEffect, useMemo } from 'react';
import { Plus, Pencil, Sparkles, AlertTriangle, Eye, EyeOff, ChevronDown, Search, X, Loader2, Stethoscope, RotateCw, Trash2 } from 'lucide-react';
import { store, fmtINR, toggleProductVisibility, canProductBeVisible, labelColorClasses, onStoreChange, getActiveClassCodes, classBadgeClasses, bulkDeleteProducts, mergePortalProductsSnapshot } from '../data/dummyData';
import { initProductCache, cacheGetAll, isCacheFresh, invalidateFreshness } from '../lib/productCache';
import { fetchPortalProductsPage } from '../lib/firestoreSync';
import { Product } from '../types';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { Switch } from '../components/ui/switch';
import { LazyImage } from '../components/LazyImage';
import { usePagination } from '../hooks/usePagination';
import { useCollectionLoaded } from '../lib/syncHooks';
import {
  loadMorePortalProducts,
  searchPortalProducts,
  areMorePortalProductsAvailable,
  areMoreSearchResultsAvailable,
  resetSearchCursor,
  auditProductsConsistency,
} from '../lib/firestoreSync';
import ProductModal from '../components/modals/ProductModal';

const PAGE_SIZE = 12;

const AdminProducts: React.FC = () => {
  const [, force] = useState(0);
  useEffect(() => onStoreChange(() => force(n => n + 1)), []);

  // Bootstrap: open the IndexedDB cache, paint anything already cached, then
  // refetch the top-50 from Firestore in parallel. Replaces the old live
  // subscription on portal_products. Cache survives reloads but is cleared
  // on logout (see authClient.logout).
  const [serverCursor, setServerCursor] = useState<any | null>(null);
  const [serverExhausted, setServerExhausted] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(true);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await initProductCache();
      // Apply cache → store immediately so UI is not blank.
      const cached = cacheGetAll();
      if (cached.length > 0) {
        mergePortalProductsSnapshot(cached);
      }
      // TTL gate: if the cache was populated within the last 30 min AND
      // we have docs, skip the Firestore refetch. Saves ~50 reads per
      // back-and-forth navigation. Explicit Reload button always refetches.
      // Local edits (add/edit/delete in this admin session) call
      // invalidateFreshness() to force the next mount to revalidate.
      if (isCacheFresh() && cached.length > 0) {
        if (!cancelled) setBootstrapping(false);
        return;
      }
      // Otherwise fetch the fresh top-50 from Firestore.
      try {
        const page = await fetchPortalProductsPage(null, 50);
        if (cancelled) return;
        mergePortalProductsSnapshot(page.products);
        setServerCursor(page.nextCursor);
        setServerExhausted(page.exhausted);
      } catch {
        // ignore — UI still shows cached values
      }
      if (!cancelled) setBootstrapping(false);
    })();
    return () => { cancelled = true; };
  }, []);

  // Explicit "Reload catalog" — re-fetches top-50 and replaces cursor.
  // Bypasses the TTL gate (admin clicked Reload because they WANT fresh data).
  const handleRefreshCatalog = async () => {
    setBootstrapping(true);
    invalidateFreshness();  // any subsequent mount also revalidates
    try {
      const page = await fetchPortalProductsPage(null, 50);
      mergePortalProductsSnapshot(page.products);
      setServerCursor(page.nextCursor);
      setServerExhausted(page.exhausted);
    } finally {
      setBootstrapping(false);
    }
  };
  const [modal, setModal] = useState<{ mode: 'add' | 'edit'; product?: Product } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'pending' | 'visible' | 'billmaker'>('all');
  const [search, setSearch] = useState('');
  const [searching, setSearching] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(true);
  // Search pagination state — separate from the browse-mode `loadMore`
  // because they query different Firestore paths.
  const [hasMoreSearch, setHasMoreSearch] = useState(false);
  const [loadingMoreSearch, setLoadingMoreSearch] = useState(false);

  // Diagnose modal — on-demand product consistency audit. Open via toolbar
  // button, results cached until refresh.
  const [diagOpen, setDiagOpen] = useState(false);
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagError, setDiagError] = useState<string | null>(null);
  type DiagReport = Awaited<ReturnType<typeof auditProductsConsistency>>;
  const [diagReport, setDiagReport] = useState<DiagReport | null>(null);

  const runDiag = async () => {
    if (diagLoading) return;
    setDiagLoading(true);
    setDiagError(null);
    try {
      const r = await auditProductsConsistency();
      setDiagReport(r);
    } catch (e: any) {
      setDiagError(String(e?.message || e));
    } finally {
      setDiagLoading(false);
    }
  };

  const openDiag = () => {
    setDiagOpen(true);
    if (!diagReport) void runDiag();
  };

  // Single-product delete — used by the trash icon on each card. Confirms,
  // then calls bulkDeleteProducts([id]) which also deletes the matching
  // products/<slug> doc so the product doesn't re-spawn via the slug loop.
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const handleDeleteProduct = async (p: Product) => {
    if (deletingId) return;
    if (!window.confirm(
      `Permanently delete "${p.name}"?\n\n` +
      `This removes the product from portal_products AND the mobile name index.\n` +
      `Bills that reference this product will keep working (the name stays on the bill).\n\n` +
      `Cannot be undone.`
    )) return;
    setDeletingId(p.id);
    try {
      const r = await bulkDeleteProducts([p.id]);
      if (r.failed > 0) {
        setToast(`Failed to delete "${p.name}" — try again.`);
        setTimeout(() => setToast(null), 4000);
      }
      // If the diagnose modal is open, refresh it so the user sees the count drop.
      if (diagOpen) void runDiag();
    } catch (e: any) {
      setToast(`Delete failed: ${String(e?.message || e)}`);
      setTimeout(() => setToast(null), 4000);
    } finally {
      setDeletingId(null);
    }
  };

  // Debounced Firestore prefix search — runs ~300ms after the user stops
  // typing. Empty query is a no-op (live subscription handles the top page).
  // While `searching=true`, the grid renders skeletons (NOT local-filtered
  // results) so the user sees a single, consistent set of results once the
  // search lands. Avoids the "show local matches → flicker → show full
  // results" pattern.
  useEffect(() => {
    const q = search.trim();
    if (!q) {
      setSearching(false);
      setHasMoreSearch(false);
      resetSearchCursor();
      return;
    }
    setSearching(true);
    setHasMoreSearch(false);
    const handle = setTimeout(() => {
      void searchPortalProducts(q).then(count => {
        setHasMoreSearch(count > 0 && areMoreSearchResultsAvailable());
      }).finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(handle);
  }, [search]);

  const handleLoadOlder = async () => {
    if (loadingOlder || serverExhausted) return;
    setLoadingOlder(true);
    try {
      const page = await fetchPortalProductsPage(serverCursor, 50);
      mergePortalProductsSnapshot(page.products);
      setServerCursor(page.nextCursor);
      setServerExhausted(page.exhausted);
      setHasMoreOlder(!page.exhausted);
    } finally {
      setLoadingOlder(false);
    }
  };

  // Fetch the next page of search results (continues the prefix-range query
  // with a cursor in firestoreSync). Independent of "Load older products"
  // which paginates the unfiltered catalog.
  const handleLoadMoreSearch = async () => {
    if (loadingMoreSearch || !search.trim()) return;
    setLoadingMoreSearch(true);
    try {
      const count = await searchPortalProducts(search, true);
      setHasMoreSearch(count > 0 && areMoreSearchResultsAvailable());
    } finally {
      setLoadingMoreSearch(false);
    }
  };

  const handleToggle = (id: string) => {
    const result = toggleProductVisibility(id);
    if (!result.ok && result.reason) {
      setToast(result.reason);
      setTimeout(() => setToast(null), 4000);
    }
  };

  const products = useMemo(() => {
    const q = search.trim().toLowerCase();
    return store.products.filter(p => {
      if (filter === 'pending' && p.visibleToClient) return false;
      if (filter === 'visible' && !p.visibleToClient) return false;
      if (filter === 'billmaker' && p.source !== 'billmaker') return false;
      if (q) {
        const labelNames = p.labelIds
          .map(id => store.labels.find(l => l.id === id)?.name || '')
          .join(' ')
          .toLowerCase();
        const hay = `${p.name} ${p.description} ${labelNames}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [search, filter, store.products.length, store.products.map(p => `${p.name}:${p.visibleToClient}:${p.source}`).join('|')]); // eslint-disable-line

  const fromBillmakerCount = store.products.filter(p => p.source === 'billmaker').length;
  const pager = usePagination(products, { pageSize: PAGE_SIZE, resetKey: `${filter}|${search}`, loadDelayMs: 0 });

  // True once the Firestore products subscription has fired. Same pattern as
  // bills — render skeletons while loading instead of stale cached entries.
  // We watch the portal_products collection since that's where enriched
  // products live; the bare-name `products` collection is just an autocomplete
  // feed that the portal merges in (and may be empty for fresh shops).
  const productsLoaded = useCollectionLoaded('portal_products');

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Products</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Catalog with Class A / B / C pricing. Products from Baniya mobile auto-import here as drafts —
            fill in details, then toggle visibility to publish to clients.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleRefreshCatalog} disabled={bootstrapping} title="Re-fetch the top 50 products from Firestore">
            {bootstrapping
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Loading</>
              : <><RotateCw className="h-4 w-4" /> Refresh</>}
          </Button>
          <Button variant="outline" onClick={openDiag}>
            <Stethoscope className="h-4 w-4" /> Diagnose
          </Button>
          <Button onClick={() => setModal({ mode: 'add' })}>
            <Plus className="h-4 w-4" /> Add product
          </Button>
        </div>
      </header>

      {fromBillmakerCount > 0 && (
        <Card className="mb-4 border-amber-200 bg-amber-50">
          <CardContent className="p-4 flex items-start gap-3">
            <Sparkles className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-amber-900">{fromBillmakerCount} product{fromBillmakerCount === 1 ? '' : 's'} auto-imported from Baniya</p>
              <p className="text-xs text-amber-800 mt-0.5">
                They appear here without descriptions or prices. Edit each to enrich it before the client portal will show them.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="relative mb-3">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search products by name, description, or label…"
          className="pl-9 pr-9"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch('')}
            className="absolute right-3 top-2.5 text-muted-foreground hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="flex gap-1 bg-muted rounded-lg p-1 mb-4 w-fit">
        {([
          { v: 'all', label: 'All' },
          { v: 'visible', label: 'Visible' },
          { v: 'pending', label: 'Pending' },
          { v: 'billmaker', label: `From Baniya (${fromBillmakerCount})` },
        ] as const).map(f => (
          <button
            key={f.v}
            onClick={() => setFilter(f.v)}
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition ${
              filter === f.v ? 'bg-background text-primary shadow' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {pager.total > 0 && !searching && (
        <p className="text-[11px] text-muted-foreground font-semibold mb-2">
          {search.trim() ? `${pager.total} match${pager.total === 1 ? '' : 'es'} for "${search.trim()}"` : `Showing ${pager.showing} of ${pager.total}`}
        </p>
      )}

      {/* When a search is in flight, render skeletons in the grid so the user
          sees a single consistent state — no flicker between local-filtered
          results and the full Firestore results. After ~300ms debounce + the
          Firestore round-trip, the real results swap in. */}
      {search.trim() && searching ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
          {Array.from({ length: 6 }, (_, i) => (
            <ProductCardSkeleton key={`search-sk-${i}`} />
          ))}
        </div>
      ) : search.trim() && !searching && pager.page.length === 0 ? (
        // Searched + completed + zero results
        <div className="text-center py-16 text-sm text-muted-foreground border-2 border-dashed border-border rounded-xl">
          <p className="font-semibold text-foreground mb-1">No products match "{search.trim()}"</p>
          <p className="text-xs">Try a different spelling, or add this product via the "Add product" button above.</p>
        </div>
      ) : (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        {/* Initial-load skeletons before Firestore has responded. */}
        {!productsLoaded && pager.page.length === 0 && Array.from({ length: 6 }, (_, i) => (
          <ProductCardSkeleton key={`init-sk-${i}`} />
        ))}
        {/* Real product cards */}
        {pager.page.map(p => {
          const canVisible = canProductBeVisible(p);
          const isBillmakerDraft = p.source === 'billmaker';
          return (
            <Card
              key={p.id}
              className={`hover:shadow-lg transition group ${isBillmakerDraft ? 'border-dashed border-amber-300' : ''}`}
            >
              <CardContent className="p-4 sm:p-5 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="relative w-16 h-16 sm:w-20 sm:h-20 flex-shrink-0">
                    <LazyImage
                      src={p.images?.[0] || ''}
                      aspectClass="aspect-square"
                      className="rounded-lg border"
                      delayMs={0}
                    />
                    {p.images && p.images.length > 1 && (
                      <span className="absolute -bottom-1 -right-1 text-[9px] font-bold bg-foreground text-background rounded-full px-1.5 py-0.5 shadow">
                        +{p.images.length - 1}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap mb-2">
                      {p.labelIds.map(lid => {
                        const l = store.labels.find(x => x.id === lid);
                        if (!l) return null;
                        return (
                          <span key={l.id} className={`text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${labelColorClasses[l.color]}`}>
                            {l.name}
                          </span>
                        );
                      })}
                      {isBillmakerDraft && <Badge variant="warning">From Baniya</Badge>}
                      {!p.inStock && <Badge variant="destructive">Out of stock</Badge>}
                    </div>
                    <p className="font-bold text-foreground truncate">{p.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                      {p.description || <span className="italic text-amber-700">No description yet</span>}
                    </p>
                  </div>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition flex-shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setModal({ mode: 'edit', product: p })}
                      title="Edit product"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDeleteProduct(p)}
                      disabled={deletingId === p.id}
                      title="Delete product"
                      className="text-rose-600 hover:text-rose-700 hover:bg-rose-50"
                    >
                      {deletingId === p.id
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Trash2 className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                </div>

                {(() => {
                  const codes = getActiveClassCodes();
                  const compact = codes.length > 3;
                  // 3 classes → flat row of 3; 4-5 classes → 2 rows so tiles stay readable
                  const gridCls = compact
                    ? codes.length === 4
                      ? 'grid-cols-2'
                      : 'grid-cols-3'
                    : 'grid-cols-3';
                  return (
                    <div className={`grid ${gridCls} gap-2`}>
                      {codes.map(cls => {
                        const enabled = !!p.enabledClasses[cls];
                        const price = p.prices[cls] || 0;
                        return (
                          <div
                            key={cls}
                            className={`text-center rounded-md py-2 px-1.5 border min-w-0 ${
                              !enabled
                                ? 'bg-muted text-muted-foreground/40 line-through border-transparent'
                                : classBadgeClasses(cls)
                            }`}
                          >
                            <p className="text-[9px] uppercase tracking-widest font-bold opacity-70 truncate">Class {cls}</p>
                            <p className="font-bold text-sm mt-0.5 truncate" title={price > 0 ? fmtINR(price) : '—'}>
                              {price > 0 ? (
                                compact ? `₹${Math.round(price).toLocaleString('en-IN')}` : fmtINR(price)
                              ) : '—'}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}

                <div className="flex items-center justify-between pt-2 border-t">
                  <div className="flex items-center gap-2">
                    {p.visibleToClient ? (
                      <Eye className="h-4 w-4 text-emerald-600" />
                    ) : (
                      <EyeOff className="h-4 w-4 text-muted-foreground" />
                    )}
                    <span className="text-xs font-semibold">
                      {p.visibleToClient ? 'Visible to clients' : 'Hidden'}
                    </span>
                  </div>
                  <Switch
                    checked={p.visibleToClient}
                    onCheckedChange={() => handleToggle(p.id)}
                    disabled={!canVisible && !p.visibleToClient}
                  />
                </div>
                {!canVisible && !p.visibleToClient && (
                  <p className="text-[11px] text-amber-700 flex items-center gap-1.5">
                    <AlertTriangle className="h-3 w-3" />
                    Needs name + description + one enabled class with price
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}

        {/* Skeleton cards while local pager loads next chunk OR while the
            server "Load more" fetch is in flight. Both render at the end of
            the grid below the last real product card. */}
        {(pager.loadingMore || loadingOlder) && Array.from({ length: pager.skeletonCount }, (_, i) => (
          <ProductCardSkeleton key={`sk-${i}`} />
        ))}
      </div>
      )}

      {/* Local pager: infinite scroll within already-loaded products.
          The sentinel triggers pager.loadMore as it scrolls into view. No
          Firestore reads — purely revealing the rest of the locally cached
          50-doc subscription window. */}
      {pager.hasMore && !searching && (
        <div ref={pager.sentinelRef} aria-hidden className="h-1" />
      )}

      {/* Server-side "load more search results" — fires when the user is
          searching and Firestore has more matches than the current 50-doc
          page. Costs ~50 Firestore reads per click. */}
      {search.trim() && !searching && hasMoreSearch && (
        <div className="flex items-center justify-center mt-6 gap-3 text-xs text-muted-foreground">
          <Button
            variant="outline"
            size="sm"
            onClick={handleLoadMoreSearch}
            disabled={loadingMoreSearch}
          >
            {loadingMoreSearch
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Fetching more matches…</>
              : <><ChevronDown className="h-3.5 w-3.5" /> Load more search results</>}
          </Button>
        </div>
      )}

      {/* Server-side "Load more" — fetches the next 50 products from Firestore
          (cursor-paginated by lastModified desc). Costs ~50 Firestore reads
          per click. */}
      {!pager.hasMore && !search && !serverExhausted && (
        <div className="flex items-center justify-center mt-4 gap-3 text-xs text-muted-foreground">
          <Button
            variant="outline"
            size="sm"
            onClick={handleLoadOlder}
            disabled={loadingOlder}
          >
            {loadingOlder
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading more…</>
              : <><ChevronDown className="h-3.5 w-3.5" /> Load more</>}
          </Button>
        </div>
      )}

      {/* The grid-level skeleton already conveys "search in progress" — no
          need for a separate footer indicator. Kept for fallback rendering
          if the grid path ever changes. */}
      {/* {searching && (...)} */}

      <ProductModal
        mode={modal?.mode || 'add'}
        product={modal?.product}
        open={!!modal}
        onClose={() => setModal(null)}
      />

      {toast && (
        <div className="fixed bottom-4 right-4 z-50 bg-rose-600 text-white text-sm font-semibold px-4 py-3 rounded-lg shadow-xl animate-fade-in max-w-xs">
          {toast}
        </div>
      )}

      {diagOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 sm:p-8 overflow-y-auto"
          onClick={() => setDiagOpen(false)}
        >
          <div
            className="bg-background rounded-lg shadow-2xl max-w-2xl w-full max-h-[calc(100vh-4rem)] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b">
              <div className="flex items-center gap-2">
                <Stethoscope className="h-5 w-5 text-primary" />
                <h2 className="text-lg font-bold">Products diagnose</h2>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={runDiag} disabled={diagLoading}>
                  {diagLoading
                    ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Scanning&hellip;</>
                    : <><RotateCw className="h-3.5 w-3.5" /> Refresh</>}
                </Button>
                <button
                  type="button"
                  onClick={() => setDiagOpen(false)}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="Close"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="overflow-y-auto px-5 py-4 text-sm">
              {diagError && (
                <div className="bg-rose-50 border border-rose-200 text-rose-900 rounded-md px-3 py-2 mb-3 text-xs flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <span>{diagError}</span>
                </div>
              )}

              {diagLoading && !diagReport && (
                <div className="flex items-center justify-center py-12 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <span className="ml-2 text-xs">Scanning Firestore&hellip;</span>
                </div>
              )}

              {diagReport && (() => {
                const fsCount    = diagReport.portal_products_in_firestore;
                const mobileCount = diagReport.mobile_products_in_firestore;
                const localCount = diagReport.portal_products_loaded_locally;
                const billsCount = diagReport.unique_names_in_bills;
                const missing    = diagReport.bill_names_NOT_in_catalog;
                const orphans    = diagReport.portal_products_NOT_in_mobile;
                const subscriptionGap = fsCount - localCount;
                const importGap = Math.max(0, mobileCount - fsCount);
                const verdicts: Array<{ kind: 'ok' | 'warn' | 'error'; text: string }> = [];
                if (subscriptionGap > 0) verdicts.push({
                  kind: 'error',
                  text: `${subscriptionGap} products are in Firestore but not loaded into the portal UI. Likely missing lastModified — run Settings → Maintenance → "Backfill lastModified" to fix.`,
                });
                if (importGap > 0) verdicts.push({
                  kind: 'warn',
                  text: `${importGap} mobile product names have no portal_products entry. Mobile catalog is ahead — should auto-import on next sync.`,
                });
                if (missing > 0) verdicts.push({
                  kind: 'warn',
                  text: `${missing} product names appear in bills but aren't in portal_products. Bills reference deleted products?`,
                });
                if (orphans > 0) verdicts.push({
                  kind: 'warn',
                  text: `${orphans} portal_products have no matching mobile name index. Could be admin-created products mobile never saw, or stale phantoms.`,
                });
                if (verdicts.length === 0) verdicts.push({
                  kind: 'ok',
                  text: 'All sources consistent. No drift detected.',
                });

                const rows = [
                  { label: 'Firestore portal_products (truth)',  value: fsCount,     hint: 'Live count via getDocs — authoritative' },
                  { label: 'Mobile products name-index',          value: mobileCount, hint: 'Slug-based name index mobile maintains' },
                  { label: 'Loaded into portal UI',              value: localCount,  hint: 'What you see on the cards' },
                  { label: 'Unique names in bills',              value: billsCount,  hint: 'Distinct product names across all bills' },
                  { label: 'Bill names NOT in catalog',          value: missing,     hint: 'Names referenced in bills but missing from portal_products', warnIfPositive: true },
                  { label: 'portal_products NOT in mobile index',value: orphans,     hint: 'Possible phantom drafts', warnIfPositive: true },
                ];

                return (
                  <>
                    <div className="overflow-hidden rounded-md border mb-4">
                      <table className="w-full text-xs">
                        <thead className="bg-muted/40 text-muted-foreground">
                          <tr>
                            <th className="px-3 py-2 text-left font-semibold">Source</th>
                            <th className="px-3 py-2 text-right font-semibold w-20">Count</th>
                            <th className="px-3 py-2 text-left font-semibold hidden sm:table-cell">Notes</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {rows.map(r => (
                            <tr key={r.label}>
                              <td className="px-3 py-2 font-medium">{r.label}</td>
                              <td className={`px-3 py-2 text-right font-mono font-bold ${r.warnIfPositive && r.value > 0 ? 'text-rose-600' : ''}`}>
                                {r.value}
                              </td>
                              <td className="px-3 py-2 text-muted-foreground hidden sm:table-cell">{r.hint}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <p className="font-bold text-xs uppercase tracking-wide text-muted-foreground mb-1">Verdict</p>
                    <div className="space-y-1.5 mb-4">
                      {verdicts.map((v, i) => (
                        <div
                          key={i}
                          className={`rounded-md px-3 py-2 text-xs flex items-start gap-2 ${
                            v.kind === 'ok' ? 'bg-emerald-50 border border-emerald-200 text-emerald-900' :
                            v.kind === 'warn' ? 'bg-amber-50 border border-amber-200 text-amber-900' :
                            'bg-rose-50 border border-rose-200 text-rose-900'
                          }`}
                        >
                          {v.kind === 'ok' && <Eye className="h-4 w-4 flex-shrink-0 mt-0.5" />}
                          {v.kind === 'warn' && <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />}
                          {v.kind === 'error' && <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />}
                          <span>{v.text}</span>
                        </div>
                      ))}
                    </div>

                    {diagReport.sample_missing.length > 0 && (
                      <div className="mb-3">
                        <p className="font-bold text-xs uppercase tracking-wide text-muted-foreground mb-1">
                          Sample missing names ({diagReport.sample_missing.length} of {missing})
                        </p>
                        <div className="bg-slate-50 border rounded-md p-2 text-xs font-mono text-slate-700">
                          {diagReport.sample_missing.map((n, i) => <div key={i}>· {n}</div>)}
                        </div>
                      </div>
                    )}

                    {diagReport.sample_orphans.length > 0 && (
                      <div className="mb-3">
                        <p className="font-bold text-xs uppercase tracking-wide text-muted-foreground mb-1">
                          Sample orphan portal_products ({diagReport.sample_orphans.length} of {orphans})
                        </p>
                        <div className="bg-slate-50 border rounded-md p-2 text-xs font-mono text-slate-700">
                          {diagReport.sample_orphans.map((n, i) => <div key={i}>· {n}</div>)}
                        </div>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>

            <div className="px-5 py-3 border-t bg-muted/20 text-xs text-muted-foreground">
              Cost: 1 Firestore read per portal_products + 1 per mobile products doc. Cheap for &lt;1000 product shops.
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Skeleton card shown in the grid while the next page is loading.
const ProductCardSkeleton: React.FC = () => (
  <Card className="animate-pulse">
    <CardContent className="p-4 sm:p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-lg bg-slate-200 flex-shrink-0" />
        <div className="flex-1 min-w-0 space-y-2">
          <div className="h-4 w-3/4 bg-slate-200 rounded" />
          <div className="h-3 w-1/2 bg-slate-100 rounded" />
          <div className="flex gap-1 mt-2">
            <div className="h-3.5 w-12 rounded-full bg-slate-100" />
            <div className="h-3.5 w-14 rounded-full bg-slate-100" />
          </div>
        </div>
      </div>
      <div className="h-3 w-full bg-slate-100 rounded" />
      <div className="h-3 w-5/6 bg-slate-100 rounded" />
      <div className="grid grid-cols-3 gap-2 pt-2">
        <div className="h-7 bg-slate-100 rounded" />
        <div className="h-7 bg-slate-100 rounded" />
        <div className="h-7 bg-slate-100 rounded" />
      </div>
      <div className="flex items-center justify-between pt-3 border-t">
        <div className="h-4 w-24 bg-slate-200 rounded" />
        <div className="h-6 w-10 bg-slate-100 rounded-full" />
      </div>
    </CardContent>
  </Card>
);

export default AdminProducts;
