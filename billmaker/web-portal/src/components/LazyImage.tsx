import React, { useEffect, useRef, useState } from 'react';
import { Skeleton } from './ui/skeleton';
import { cn } from '../lib/utils';
import { ImageOff } from 'lucide-react';

interface LazyImageProps {
  src: string;
  alt?: string;
  className?: string;
  /** Artificial delay before the image starts loading (prototype). */
  delayMs?: number;
  /** Skeleton/wrapper aspect ratio class, e.g. "aspect-square", "aspect-[4/3]" */
  aspectClass?: string;
  /** Optional placeholder when no src provided. */
  fallback?: React.ReactNode;
  /**
   * How to fit the image inside the container.
   * - 'cover' (default): fills the container, may crop edges. Best for thumbnails.
   * - 'contain': shows the whole image, letterboxes whitespace. Best for product hero photos
   *   where the entire image must be visible.
   */
  fit?: 'cover' | 'contain';
}

/**
 * Lazy-loads an image when it enters the viewport. Shows a shimmering skeleton
 * placeholder until the (artificially delayed) load completes. Default delay
 * is 3 seconds to simulate slow networks for the prototype demo.
 */
export const LazyImage: React.FC<LazyImageProps> = ({
  src,
  alt = '',
  className,
  delayMs = 3000,
  aspectClass = 'aspect-[4/3]',
  fallback,
  fit = 'cover',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  // Step 1: detect when in viewport
  useEffect(() => {
    if (inView || !containerRef.current) return;
    if (typeof IntersectionObserver === 'undefined') {
      // Older browser fallback
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: '100px' },
    );
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [inView]);

  // Step 2: once in view, wait delayMs (prototype slow-network simulation), then mount <img>
  useEffect(() => {
    if (!inView || shouldLoad || !src) return;
    const t = setTimeout(() => setShouldLoad(true), delayMs);
    return () => clearTimeout(t);
  }, [inView, shouldLoad, src, delayMs]);

  // If src changes, reset
  useEffect(() => {
    setImgLoaded(false);
    setErrored(false);
    setShouldLoad(false);
    setInView(false);
  }, [src]);

  return (
    <div ref={containerRef} className={cn('relative overflow-hidden bg-muted', aspectClass, className)}>
      {!src ? (
        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
          {fallback || <ImageOff className="h-8 w-8" />}
        </div>
      ) : (
        <>
          {!imgLoaded && <Skeleton className="absolute inset-0 rounded-none" />}
          {shouldLoad && !errored && (
            <img
              src={src}
              alt={alt}
              loading="lazy"
              decoding="async"
              onLoad={() => setImgLoaded(true)}
              onError={() => setErrored(true)}
              className={cn(
                'absolute inset-0 w-full h-full transition-opacity duration-700',
                fit === 'contain' ? 'object-contain' : 'object-cover',
                imgLoaded ? 'opacity-100' : 'opacity-0',
              )}
            />
          )}
          {errored && (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground bg-muted">
              <ImageOff className="h-8 w-8" />
            </div>
          )}
        </>
      )}
    </div>
  );
};
