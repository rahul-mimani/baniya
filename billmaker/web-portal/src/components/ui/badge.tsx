import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-primary/10 text-primary border border-primary/20',
        secondary: 'bg-secondary/10 text-secondary border border-secondary/20',
        accent: 'bg-accent/10 text-accent border border-accent/20',
        success: 'bg-emerald-100 text-emerald-700 border border-emerald-200',
        warning: 'bg-amber-100 text-amber-700 border border-amber-200',
        destructive: 'bg-rose-100 text-rose-700 border border-rose-200',
        outline: 'border border-input text-foreground',
        classA: 'bg-emerald-100 text-emerald-700 border border-emerald-300',
        classB: 'bg-sky-100 text-sky-700 border border-sky-300',
        classC: 'bg-slate-200 text-slate-700 border border-slate-300',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
