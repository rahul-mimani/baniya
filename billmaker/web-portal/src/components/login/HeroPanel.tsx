// Left-hand hero panel shown alongside the Login card on desktop.
//
// Composition:
//   - Slogan (large gradient headline)
//   - Animated parametric heart (MathHeart)
//   - Sub-tagline
//   - Three feature pills with icons
//   - Soft floating dots in the background
//
// Mobile uses a much more compact variant (`HeroCompact` below) — a small heart
// next to a short headline, designed to fit above the login card without
// pushing it below the fold.

import React from 'react';
import { motion } from 'framer-motion';
import { Receipt, ShieldCheck, Sparkles } from 'lucide-react';
import { MathHeart } from './MathHeart';

const spring = { type: 'spring' as const, stiffness: 240, damping: 26 };

const features = [
  { icon: Receipt, label: 'See every bill, every payment' },
  { icon: ShieldCheck, label: 'Phone-based one-tap sign in' },
  { icon: Sparkles, label: 'Exclusive deals & offers' },
];

export const HeroPanel: React.FC = () => (
  <div className="relative h-full flex flex-col items-center justify-center px-8 lg:px-12 py-10 lg:py-0 select-none">
    {/* Animated heart, centered */}
    <motion.div
      className="relative"
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ ...spring, delay: 0.15 }}
    >
      <MathHeart size={340} />

      {/* Tiny floating glyphs orbiting the heart for extra life */}
      <FloatingGlyph delay={2.4} radius={170} angle={20} duration={14}>
        <span className="text-[10px] font-mono font-bold text-sky-500/70 bg-white px-1.5 py-0.5 rounded shadow-sm shadow-sky-200">
          ₹
        </span>
      </FloatingGlyph>
      <FloatingGlyph delay={2.6} radius={155} angle={120} duration={18}>
        <span className="text-[9px] font-mono font-bold text-blue-600/70 bg-white px-1.5 py-0.5 rounded shadow-sm shadow-blue-200">
          ✓
        </span>
      </FloatingGlyph>
      <FloatingGlyph delay={2.8} radius={180} angle={240} duration={22}>
        <span className="text-[10px] font-mono font-bold text-indigo-500/70 bg-white px-1.5 py-0.5 rounded shadow-sm shadow-indigo-200">
          ★
        </span>
      </FloatingGlyph>
    </motion.div>

    {/* Slogan */}
    <motion.div
      className="text-center mt-2"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...spring, delay: 0.45 }}
    >
      <h2 className="text-4xl xl:text-5xl font-bold tracking-tight leading-[1.1]">
        <span className="block text-slate-900">Bills, deals,</span>
        <span className="block bg-gradient-to-r from-sky-500 via-blue-600 to-indigo-600 bg-clip-text text-transparent">
          all in one tap.
        </span>
      </h2>
      <p className="text-base text-slate-500 mt-4 max-w-md mx-auto leading-relaxed">
        Track every bill, grab exclusive deals, and rise through the tiers —
        all from one beautifully simple portal.
      </p>
    </motion.div>

    {/* Feature pills */}
    <motion.div
      className="mt-7 flex flex-wrap justify-center gap-2"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.7, duration: 0.5 }}
    >
      {features.map((f, i) => (
        <motion.div
          key={f.label}
          className="inline-flex items-center gap-1.5 bg-white/80 backdrop-blur border border-blue-100 rounded-full px-3 py-1.5 text-xs text-slate-700 shadow-sm shadow-blue-100/50"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ ...spring, delay: 0.8 + i * 0.08 }}
          whileHover={{ y: -2, transition: spring }}
        >
          <f.icon className="h-3.5 w-3.5 text-blue-600" />
          <span className="font-medium">{f.label}</span>
        </motion.div>
      ))}
    </motion.div>
  </div>
);


/**
 * Compact mobile hero — a small heart + short headline, designed to sit ABOVE
 * the login card without crowding it. We don't repeat the feature pills on
 * mobile; the user is here to sign in, not to read marketing copy.
 */
export const HeroCompact: React.FC = () => (
  <motion.div
    className="flex items-center justify-center gap-4 mb-6 select-none"
    initial={{ opacity: 0, y: -10 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ ...spring, delay: 0.1 }}
  >
    <div className="flex-shrink-0">
      <MathHeart size={110} />
    </div>
    <div className="max-w-[180px]">
      <p className="text-[10px] uppercase tracking-[0.3em] text-blue-600/70 font-semibold mb-1">
        Welcome
      </p>
      <p className="text-base font-bold text-slate-900 leading-tight">
        Bills, deals,<br />
        <span className="bg-gradient-to-r from-sky-500 via-blue-600 to-indigo-600 bg-clip-text text-transparent">
          all in one tap.
        </span>
      </p>
    </div>
  </motion.div>
);


/**
 * A small element that orbits a fixed radius around its parent's center.
 * Uses transform-origin trick so we can spin the wrapper while keeping the
 * glyph upright (counter-rotate the inner span).
 */
interface FloatingGlyphProps {
  children: React.ReactNode;
  delay: number;
  radius: number;
  angle: number;     // starting angle in degrees
  duration: number;  // seconds per full orbit
}

const FloatingGlyph: React.FC<FloatingGlyphProps> = ({ children, delay, radius, angle, duration }) => (
  <motion.div
    className="absolute top-1/2 left-1/2 pointer-events-none"
    style={{ rotate: angle, translateX: '-50%', translateY: '-50%' }}
    initial={{ opacity: 0, rotate: angle }}
    animate={{ opacity: 1, rotate: angle + 360 }}
    transition={{
      opacity: { delay, duration: 0.4 },
      rotate: { delay, duration, ease: 'linear', repeat: Infinity },
    }}
  >
    {/* Push outward by `radius`, then counter-rotate so the glyph stays upright */}
    <motion.div
      style={{ transform: `translateX(${radius}px)` }}
      animate={{ rotate: -360 }}
      transition={{ duration, ease: 'linear', repeat: Infinity }}
    >
      {children}
    </motion.div>
  </motion.div>
);
