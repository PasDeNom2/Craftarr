import React from 'react';
import clsx from 'clsx';
import { Layers } from 'lucide-react';

/** Marque Craftarr : carré blanc + icône (DA noir et blanc). */
export function LogoMark({ size = 32, className }) {
  return (
    <div
      className={clsx('rounded-lg bg-fg flex items-center justify-center shrink-0', className)}
      style={{ width: size, height: size, borderRadius: Math.round(size / 4) }}
    >
      <Layers size={Math.round(size / 2)} strokeWidth={2} className="text-black" />
    </div>
  );
}

export default function Logo({ size = 32, showName = true, className }) {
  return (
    <span className={clsx('inline-flex items-center gap-3', className)}>
      <LogoMark size={size} />
      {showName && <span className="font-semibold text-fg text-sm tracking-tight">Craftarr</span>}
    </span>
  );
}
