import { useEffect, useMemo, useRef, useState } from 'react';

interface PaginationOptions {
  /** Items shown initially and added per page. */
  pageSize?: number;
  /** Reset paging when this signature changes (e.g. filter/search changed). */
  resetKey?: string | number;
  /** Synthetic loading delay between scroll-trigger and reveal (ms). Lets the
   *  skeleton row stay visible long enough to feel "live" instead of flashing.
   *  Set to 0 to disable. */
  loadDelayMs?: number;
}

interface PaginationResult<T> {
  page: T[];
  hasMore: boolean;
  loadMore: () => void;
  showing: number;
  total: number;
  reset: () => void;
  /** Index where the first newly-revealed page starts (so callers can render only those lazily). */
  newPageStart: number;
  /** True for ~loadDelayMs ms after `loadMore` fires — render skeleton rows below the list during this window. */
  loadingMore: boolean;
  /** How many skeleton rows the consumer should render while loading.
   *  Equals min(pageSize, remaining items). */
  skeletonCount: number;
  /** Ref to attach to a sentinel <div> at the bottom — observed for auto-load. */
  sentinelRef: (el: HTMLElement | null) => void;
}

/**
 * Infinite-scroll paginator with sentinel-based auto-load.
 *
 * Behavior:
 *   - Initial render shows `pageSize` items.
 *   - When the sentinel scrolls into view (or `loadMore` is called manually),
 *     `loadingMore` flips to true, skeleton rows can be rendered under the
 *     existing list, and after `loadDelayMs` the next batch is revealed.
 *   - Resets to one page whenever `resetKey` changes (filter/search updates).
 */
export function usePagination<T>(items: T[], options: PaginationOptions = {}): PaginationResult<T> {
  const { pageSize = 6, resetKey = '', loadDelayMs = 250 } = options;
  const [visible, setVisible] = useState(pageSize);
  const [newPageStart, setNewPageStart] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset when the resetKey changes
  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setLoadingMore(false);
    setVisible(pageSize);
    setNewPageStart(0);
  }, [resetKey, pageSize]);

  const page = useMemo(() => items.slice(0, visible), [items, visible]);
  const hasMore = visible < items.length;
  const skeletonCount = Math.min(pageSize, Math.max(0, items.length - visible));

  const loadMore = () => {
    if (loadingMore || !hasMore) return;
    if (loadDelayMs > 0) {
      setLoadingMore(true);
      timerRef.current = setTimeout(() => {
        setNewPageStart(visible);
        setVisible(v => Math.min(items.length, v + pageSize));
        setLoadingMore(false);
        timerRef.current = null;
      }, loadDelayMs);
    } else {
      setNewPageStart(visible);
      setVisible(v => Math.min(items.length, v + pageSize));
    }
  };

  const reset = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setLoadingMore(false);
    setVisible(pageSize);
    setNewPageStart(0);
  };

  // Sentinel ref — when it scrolls into view, auto-load the next page.
  const sentinelRef = (el: HTMLElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (!el || !hasMore || loadingMore) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) loadMore();
      },
      { rootMargin: '300px' },
    );
    obs.observe(el);
    observerRef.current = obs;
  };

  useEffect(() => () => {
    observerRef.current?.disconnect();
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return {
    page,
    hasMore,
    loadMore,
    showing: page.length,
    total: items.length,
    reset,
    newPageStart,
    loadingMore,
    skeletonCount,
    sentinelRef,
  };
}
