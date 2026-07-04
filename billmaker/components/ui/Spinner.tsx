import React from 'react';
import { cls } from './tokens';

type Size = 'sm' | 'md' | 'lg' | 'xl';

interface SpinnerProps {
  size?: Size;
  /** Tailwind text-* color class for the ring. Defaults to sky-blue. */
  colorClass?: string;
  /** Show a centered overlay covering the parent (use for tab transitions). */
  overlay?: boolean;
  /** Optional label rendered under the spinner when overlay is true. */
  label?: string;
  className?: string;
}

const sizeStyles: Record<Size, string> = {
  sm: 'w-4 h-4 border-2',
  md: 'w-6 h-6 border-2',
  lg: 'w-10 h-10 border-[3px]',
  xl: 'w-14 h-14 border-[3px]',
};

/**
 * Lightweight spinning ring. Two ways to use:
 *
 *   1. Inline:   <Spinner size="md" />
 *   2. Overlay:  <Spinner overlay label="Saving…" />   (fills parent)
 *
 * Render inside a `position: relative` ancestor when using `overlay`.
 */
const Spinner: React.FC<SpinnerProps> = ({
  size = 'md',
  colorClass = 'text-sky-600',
  overlay = false,
  label,
  className,
}) => {
  const ring = (
    <span
      className={cls(
        'inline-block rounded-full border-current border-t-transparent animate-spin',
        sizeStyles[size],
        colorClass,
        className,
      )}
      role="status"
      aria-label={label || 'Loading'}
    />
  );

  if (!overlay) return ring;

  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-amber-50/80 backdrop-blur-sm">
      {ring}
      {label && (
        <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
          {label}
        </span>
      )}
    </div>
  );
};

export default Spinner;
