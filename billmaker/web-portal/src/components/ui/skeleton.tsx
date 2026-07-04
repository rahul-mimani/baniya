import * as React from 'react';
import { cn } from '../../lib/utils';

export const Skeleton: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className, ...props }) => (
  <div
    className={cn(
      'animate-pulse rounded-md bg-gradient-to-br from-slate-200 via-slate-100 to-slate-200 bg-[length:200%_100%]',
      className,
    )}
    style={{ animation: 'shimmer 1.6s ease-in-out infinite' }}
    {...props}
  />
);
