import React from 'react';
import clsx from 'clsx';

/**
 * Marque Craftarr : un bloc isométrique (face herbe = couleur d'accent du thème)
 * avec un liseré « pixel » qui déborde sur les côtés, façon bloc d'herbe.
 */
export function LogoMark({ size = 32, className, glow = false }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={clsx('shrink-0', className)}
      style={glow ? { filter: 'drop-shadow(0 0 10px rgba(var(--accent-rgb),0.45))' } : undefined}
      aria-hidden="true"
    >
      {/* faces latérales (terre) */}
      <polygon points="3,10 16,17 16,30 3,23" fill="var(--surface-3)" />
      <polygon points="29,10 29,23 16,30 16,17" fill="var(--surface-2)" />
      {/* liseré d'herbe en escalier */}
      <polygon points="3,10 16,17 16,20 12,18 12,20 8,17.8 8,16 5,14.4 5,15.5 3,14.4" fill="var(--accent)" opacity="0.85" />
      <polygon points="29,10 16,17 16,20 19,18.4 19,20 23,17.8 23,16 26,14.4 26,15.6 29,14" fill="var(--accent)" opacity="0.65" />
      {/* face du dessus */}
      <polygon points="16,3 29,10 16,17 3,10" fill="var(--accent)" />
      <polygon points="16,3 29,10 16,17 3,10" fill="url(#logo-sheen)" />
      <defs>
        <linearGradient id="logo-sheen" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.35" />
          <stop offset="0.6" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/** Logo complet : bloc + nom en police pixel. */
export default function Logo({ size = 30, showName = true, className }) {
  return (
    <span className={clsx('inline-flex items-center gap-2.5', className)}>
      <LogoMark size={size} glow />
      {showName && (
        <span className="font-pixel text-[15px] leading-none tracking-wide text-fg">
          CRAFT<span className="text-accent">ARR</span>
        </span>
      )}
    </span>
  );
}
