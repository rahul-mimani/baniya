// Foot block to drop at the bottom of any paginated list:
//   - <div ref={sentinelRef}> for IntersectionObserver auto-load
//   - Optional skeleton renderer that fills the space while `loadingMore` is true
//   - "Load more" button as a fallback for users without IntersectionObserver
//
// Usage:
//   const pager = usePagination(items, { pageSize: 20 });
//   return (
//     <>
//       {pager.page.map(item => <Row key={item.id} item={item} />)}
//       <InfiniteScrollFoot
//         pager={pager}
//         renderSkeleton={(i) => <RowSkeleton key={`sk-${i}`} />}
//       />
//     </>
//   );

import React from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import type { usePagination } from '../hooks/usePagination';

type Pager = ReturnType<typeof usePagination<unknown>>;

interface Props {
  pager: Pick<Pager, 'sentinelRef' | 'loadMore' | 'loadingMore' | 'hasMore' | 'skeletonCount'>;
  /** Render N skeleton rows while a new page is loading. */
  renderSkeleton?: (index: number) => React.ReactNode;
  /** Override the "Load more" button label. */
  loadMoreLabel?: string;
  /** Hide the manual "Load more" button (keep only sentinel + skeleton). */
  hideButton?: boolean;
}

export const InfiniteScrollFoot: React.FC<Props> = ({
  pager,
  renderSkeleton,
  loadMoreLabel = 'Load more',
  hideButton = false,
}) => {
  if (!pager.hasMore && !pager.loadingMore) return null;

  return (
    <>
      {/* Skeleton placeholders rendered while a new page is loading */}
      {pager.loadingMore && renderSkeleton && Array.from({ length: pager.skeletonCount }, (_, i) => renderSkeleton(i))}

      {/* Sentinel — IntersectionObserver triggers loadMore() when it scrolls into view */}
      {pager.hasMore && <div ref={pager.sentinelRef} aria-hidden className="h-1" />}

      {/* Manual fallback button */}
      {!hideButton && pager.hasMore && (
        <div className="flex justify-center mt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={pager.loadMore}
            disabled={pager.loadingMore}
          >
            {pager.loadingMore
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</>
              : <><ChevronDown className="h-3.5 w-3.5" /> {loadMoreLabel}</>}
          </Button>
        </div>
      )}
    </>
  );
};
