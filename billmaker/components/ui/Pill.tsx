import React from 'react';
import { cls } from './tokens';

type Tone = 'neutral' | 'success' | 'danger' | 'warning' | 'info' | 'brand';

interface PillProps {
  tone?: Tone;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

const toneStyles: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700',
  success: 'bg-emerald-100 text-emerald-700',
  danger:  'bg-rose-100 text-rose-700',
  warning: 'bg-amber-100 text-amber-800',
  info:    'bg-sky-100 text-sky-700',
  brand:   'bg-teal-100 text-teal-700',
};

/** Compact status badge. */
const Pill: React.FC<PillProps> = ({ tone = 'neutral', icon, children, className }) => (
  <span
    className={cls(
      'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold',
      toneStyles[tone],
      className,
    )}
  >
    {icon && <span className="[&>svg]:w-3 [&>svg]:h-3">{icon}</span>}
    {children}
  </span>
);

export default Pill;
