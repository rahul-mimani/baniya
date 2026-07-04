import React from 'react';
import { cls } from './tokens';

interface CardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'className'> {
  /** When true, removes border/shadow — use for nested cards or full-bleed layouts. */
  flat?: boolean;
  /** Adds internal padding. Default true. Set to false for custom layouts. */
  padded?: boolean;
  /** Makes the card respond to tap (cursor-pointer + active state). */
  interactive?: boolean;
  className?: string;
}

const Card: React.FC<CardProps> = ({
  flat = false,
  padded = true,
  interactive = false,
  className,
  children,
  ...rest
}) => {
  return (
    <div
      {...rest}
      className={cls(
        'bg-white rounded-xl',
        !flat && 'border border-slate-200 shadow-sm',
        padded && 'p-4',
        interactive && 'cursor-pointer active:bg-slate-50 transition-colors',
        className,
      )}
    >
      {children}
    </div>
  );
};

export default Card;
