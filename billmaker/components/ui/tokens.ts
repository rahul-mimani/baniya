// Design tokens — single source of truth for the new design system.
//
// These are Tailwind-class strings, not raw colors. Use them via the
// `cls()` helper or inline. Keeping them in one file means any
// rebrand only edits this file.

/**
 * Final palette — locked in:
 *   blue       = primary brand (sky-600)
 *   dark blue  = emphasis / heading text (sky-900 / slate-900)
 *   white      = cards & modal surfaces
 *   grey       = borders, muted text (slate)
 *   cream      = app background (amber-50 — warm, low-glare)
 *
 * Use these tokens via the Tailwind classes below so the whole app
 * reads as one product. Status colors (success / danger / warning)
 * are kept semantic — see STATUS below.
 */
export const BRAND = {
  bg: 'bg-sky-600',
  bgHover: 'active:bg-sky-700',
  bgDark: 'bg-sky-900',
  text: 'text-sky-600',
  textDark: 'text-sky-900',
  textOnBrand: 'text-white',
  ring: 'ring-sky-500',
  border: 'border-sky-600',
} as const;

/** Cream — the app background. Warm off-white that pairs with sky-blue. */
export const CREAM = {
  bg: 'bg-amber-50',       // #FFFBEB — light cream
  bgSubtle: 'bg-amber-100', // for nested cream blocks
} as const;

/** Neutrals — cards, text, dividers, grey accents. */
export const NEUTRAL = {
  bg: 'bg-white',
  bgSubtle: 'bg-slate-50',
  bgMuted: 'bg-slate-100',
  text: 'text-slate-900',     // dark blue/black for body text
  textHeading: 'text-sky-900', // dark-blue heading variant
  textMuted: 'text-slate-600',
  textSubtle: 'text-slate-400',
  border: 'border-slate-200',
  borderStrong: 'border-slate-300',
  divider: 'border-slate-100',
} as const;

/** Status colors — release toggle, error, success, pending. */
export const STATUS = {
  successBg: 'bg-emerald-50',
  successText: 'text-emerald-600',
  successBorder: 'border-emerald-300',
  dangerBg: 'bg-rose-50',
  dangerText: 'text-rose-600',
  dangerBorder: 'border-rose-300',
  warnBg: 'bg-amber-50',
  warnText: 'text-amber-600',
  infoBg: 'bg-sky-50',
  infoText: 'text-sky-600',
} as const;

/** Spacing scale (Tailwind units). */
export const SPACE = {
  xs: 'gap-1',
  sm: 'gap-2',
  md: 'gap-3',
  lg: 'gap-4',
  xl: 'gap-6',
} as const;

/** Typography. */
export const TEXT = {
  heading: 'text-lg font-bold text-slate-900',
  subheading: 'text-sm font-semibold text-slate-700',
  body: 'text-sm text-slate-700',
  caption: 'text-xs text-slate-500',
  mono: 'font-mono text-xs text-slate-600',
} as const;

/** Common border radii. */
export const RADIUS = {
  sm: 'rounded-md',
  md: 'rounded-lg',
  lg: 'rounded-xl',
  pill: 'rounded-full',
} as const;

/** Shadow scale. */
export const SHADOW = {
  none: '',
  sm: 'shadow-sm',
  md: 'shadow-md',
  lg: 'shadow-lg',
} as const;

/** Helper: concat truthy Tailwind class strings, ignoring undefined/false. */
export const cls = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(' ');
