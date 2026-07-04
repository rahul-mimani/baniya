import React from 'react';
import { cls } from './tokens';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  loading?: boolean;
  className?: string;
}

const variantStyles: Record<Variant, string> = {
  primary:
    'bg-sky-600 text-white active:bg-sky-700 ring-sky-500 border border-sky-600',
  secondary:
    'bg-white text-slate-700 active:bg-slate-50 ring-slate-300 border border-slate-300',
  ghost:
    'bg-transparent text-slate-700 active:bg-slate-100 ring-slate-300 border border-transparent',
  danger:
    'bg-rose-600 text-white active:bg-rose-700 ring-rose-500 border border-rose-600',
  success:
    'bg-emerald-600 text-white active:bg-emerald-700 ring-emerald-500 border border-emerald-600',
};

const sizeStyles: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-xs gap-1.5',
  md: 'px-4 py-2.5 text-sm gap-2',
  lg: 'px-5 py-3 text-base gap-2.5',
};

/**
 * Touch-friendly button used across the mobile app. Icon-first
 * (use leftIcon/rightIcon props instead of inline children when you can)
 * so the layout stays consistent.
 *
 * Variants:
 *   primary   — main CTA (teal)
 *   secondary — neutral outlined
 *   ghost     — flat, no border (for in-row controls)
 *   danger    — destructive (red)
 *   success   — positive (green)
 */
const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  leftIcon,
  rightIcon,
  loading,
  disabled,
  children,
  className,
  ...rest
}) => {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cls(
        'inline-flex items-center justify-center font-semibold',
        'rounded-md transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        variantStyles[variant],
        sizeStyles[size],
        fullWidth && 'w-full',
        className,
      )}
    >
      {loading
        ? <span className="inline-block w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
        : leftIcon}
      {children}
      {!loading && rightIcon}
    </button>
  );
};

export default Button;
