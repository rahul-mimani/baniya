// Parametric heart curve, rendered as SVG and animated with framer-motion.
//
//   x(t) = 16·sin³(t)
//   y(t) = 13·cos(t) − 5·cos(2t) − 2·cos(3t) − cos(4t)        (for t ∈ [0, 2π])
//
// The curve is sampled at N points and turned into a path string. We draw it
// with stroke-dash animation (via framer's `pathLength`), then breathe it with
// a slow scale loop. Multiple traces at different speeds make it feel layered.

import React, { useMemo } from 'react';
import { motion } from 'framer-motion';

const generateHeartPath = (samples = 200): string => {
  const pts: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = (i / samples) * Math.PI * 2;
    const x = 16 * Math.pow(Math.sin(t), 3);
    // SVG y is inverted vs math convention — negate so the heart points up.
    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
    pts.push(`${i === 0 ? 'M' : 'L'} ${x.toFixed(3)} ${y.toFixed(3)}`);
  }
  return pts.join(' ') + ' Z';
};

// Position a particle along the curve at parameter u ∈ [0,1].
const pointOnHeart = (u: number): { x: number; y: number } => {
  const t = u * Math.PI * 2;
  return {
    x: 16 * Math.pow(Math.sin(t), 3),
    y: -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)),
  };
};

interface MathHeartProps {
  /** Outer width in px. Height auto-derives to keep aspect ratio. */
  size?: number;
  /** Stroke + glow color. Defaults to a blue from the palette. */
  color?: string;
  /** If true, runs a slow breathing pulse after the initial draw-in. */
  pulse?: boolean;
}

export const MathHeart: React.FC<MathHeartProps> = ({
  size = 320,
  color = '#2563eb',
  pulse = true,
}) => {
  const path = useMemo(() => generateHeartPath(220), []);
  // Distribute orbit particles around the curve at equal parameter intervals.
  const particles = useMemo(
    () => [0.08, 0.22, 0.36, 0.5, 0.64, 0.78, 0.92].map(u => pointOnHeart(u)),
    [],
  );

  return (
    <motion.svg
      viewBox="-22 -22 44 40"
      width={size}
      height={size * 0.9}
      className="overflow-visible"
      animate={pulse ? { scale: [1, 1.04, 1] } : undefined}
      transition={{ duration: 3.6, repeat: Infinity, ease: 'easeInOut' }}
    >
      <defs>
        {/* Soft glow underneath the strokes */}
        <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="0.9" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        {/* Gradient stroke: sky → indigo */}
        <linearGradient id="heart-stroke" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#38bdf8" />
          <stop offset="50%" stopColor={color} />
          <stop offset="100%" stopColor="#4f46e5" />
        </linearGradient>
        {/* Subtle radial fill for depth */}
        <radialGradient id="heart-fill" cx="50%" cy="40%" r="60%">
          <stop offset="0%" stopColor="rgba(59,130,246,0.18)" />
          <stop offset="100%" stopColor="rgba(59,130,246,0)" />
        </radialGradient>
      </defs>

      {/* Outer halo — thick, low-opacity, blurred (the "love" glow) */}
      <motion.path
        d={path}
        fill="none"
        stroke="url(#heart-stroke)"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.18}
        filter="url(#glow)"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 2.4, ease: 'easeInOut' }}
      />

      {/* Soft fill */}
      <motion.path
        d={path}
        fill="url(#heart-fill)"
        stroke="none"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1.4, delay: 1.2, ease: 'easeOut' }}
      />

      {/* Crisp main stroke — drawn in over 2 seconds */}
      <motion.path
        d={path}
        fill="none"
        stroke="url(#heart-stroke)"
        strokeWidth={0.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 2, ease: 'easeInOut' }}
      />

      {/* A second, slower trace at a different stroke for layered look */}
      <motion.path
        d={path}
        fill="none"
        stroke="#0ea5e9"
        strokeWidth={0.3}
        strokeDasharray="0.4 0.6"
        strokeLinecap="round"
        opacity={0.55}
        initial={{ pathLength: 0, rotate: 0 }}
        animate={{ pathLength: 1, rotate: 360 }}
        transition={{
          pathLength: { duration: 3, ease: 'easeInOut' },
          rotate: { duration: 80, ease: 'linear', repeat: Infinity },
        }}
        style={{ transformOrigin: 'center' }}
      />

      {/* Floating particles along the curve — twinkling */}
      {particles.map((p, i) => (
        <motion.circle
          key={i}
          cx={p.x}
          cy={p.y}
          r={0.45}
          fill="#3b82f6"
          initial={{ scale: 0, opacity: 0 }}
          animate={{
            scale: [0, 1, 0.6, 1, 0],
            opacity: [0, 1, 0.7, 1, 0],
          }}
          transition={{
            duration: 4.2,
            delay: 1.8 + i * 0.18,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        />
      ))}

      {/* Tiny center dot — anchor */}
      <motion.circle
        cx={0}
        cy={-1}
        r={0.7}
        fill="#2563eb"
        initial={{ scale: 0 }}
        animate={{ scale: [0, 1.2, 1] }}
        transition={{ duration: 0.6, delay: 2.2, ease: 'backOut' }}
      />
    </motion.svg>
  );
};
