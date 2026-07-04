import React from 'react';

interface LogoProps {
  size?: number;
  className?: string;
}

/** App mark — sky→violet gradient rounded square with a neutral receipt glyph. */
export const LogoMark: React.FC<LogoProps> = ({ size = 40, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 64 64"
    className={className}
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <defs>
      <linearGradient id="logoGrad" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#7dd3fc" />
        <stop offset="0.55" stopColor="#0ea5e9" />
        <stop offset="1" stopColor="#a855f7" />
      </linearGradient>
    </defs>
    <rect width="64" height="64" rx="14" fill="url(#logoGrad)" />
    {/* Receipt — rounded body with a zigzag torn edge */}
    <path
      d="M22 15 h20 v30 l-4 3 l-4 -3 l-4 3 l-4 -3 l-4 3 z"
      fill="white"
      fillOpacity="0.96"
    />
    {/* Text lines on the receipt */}
    <rect x="26" y="22" width="12" height="2.5" rx="1" fill="#0ea5e9" />
    <rect x="26" y="28" width="12" height="2.5" rx="1" fill="#0ea5e9" />
    <rect x="26" y="34" width="8" height="2.5" rx="1" fill="#0ea5e9" />
  </svg>
);

export const LogoWordmark: React.FC<{ className?: string }> = ({ className }) => (
  <p className={className}>
    <span className="bg-gradient-to-r from-sky-500 via-primary to-accent bg-clip-text text-transparent">
      Bill
    </span>
    <span className="text-foreground">Maker</span>
  </p>
);
