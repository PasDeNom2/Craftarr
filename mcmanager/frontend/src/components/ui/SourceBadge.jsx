import React from 'react';
import clsx from 'clsx';

const SOURCES = {
  curseforge: { label: 'CurseForge', color: '#F97316', bg: 'rgba(249,115,22,0.1)',  border: 'rgba(249,115,22,0.25)'  },
  modrinth:   { label: 'Modrinth',   color: '#4ADE80', bg: 'rgba(74,222,128,0.08)', border: 'rgba(74,222,128,0.2)'   },
};

export default function SourceBadge({ source, sourceName, className }) {
  const s = SOURCES[source];

  if (s) {
    return (
      <span
        className={clsx('inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium', className)}
        style={{ color: s.color, background: s.bg, border: `1px solid ${s.border}` }}
      >
        {s.label}
      </span>
    );
  }

  return (
    <span
      className={clsx('inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium', className)}
      style={{ color: '#F0F0F0', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
    >
      {sourceName || source}
    </span>
  );
}
