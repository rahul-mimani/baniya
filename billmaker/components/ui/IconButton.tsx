import React from 'react';
import { cls } from './tokens';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
type Size = 'sm' | 'md' | 'lg';

interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: Variant;
  size?: Size;
  /** Accessible label — REQUIRED. Don't ship icon-only buttons without one. */
  label: string;
  className?: string;
}

const variantStyles: Record<Variant, string> = {
  primary:
    'bg-teal-600 text-white active:bg-teal-700 ring-teal-500',
  secondary:
    'bg-white text-slate-700 active:bg-slate-50 ring-slate-300 border border-slate-300',
  ghost:
    'bg-transparent text-slate-600 active:bg-slate-100 ring-slate-300',
  danger:
    'bg-rose-500 text-white active:bg-rose-600 ring-rose-500',
  success:
    'bg-emerald-600 text-white active:bg-emerald-700 ring-emerald-500',
};

const sizeStyles: Record<Size, string> = {
  sm: 'w-8 h-8 [&>svg]:w-4 [&>svg]:h-4',
  md: 'w-10 h-10 [&>svg]:w-5 [&>svg]:h-5',
  lg: 'w-12 h-12 [&>svg]:w-6 [&>svg]:h-6',
};

/**
 * Square icon-only button. Always pass a `label` prop — it becomes the
 * aria-label and title (tooltip on desktop).
 */
const IconButton: React.FC<IconButtonProps> = ({
  variant = 'ghost',
  size = 'md',
  label,
  children,
  disabled,
  className,
  ...rest
}) => {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      disabled={disabled}
      className={cls(
        'inline-flex items-center justify-center rounded-full transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        variantStyles[variant],
        sizeStyles[size],
        className,
      )}
    >
      {children}
    </button>
  );
};

export default IconButton;
