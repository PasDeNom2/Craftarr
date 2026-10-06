import React from 'react';
import clsx from 'clsx';

// Une pastille de la couleur de la plateforme suffit à la reconnaître
const SOURCES = {
  curseforge: { label: 'CurseForge', color: '#F16436' },
  modrinth:   { label: 'Modrinth',   color: '#1BD96A' },
};

export default function SourceBadge({ source, sourceName, className }) {
  const s = SOURCES[source];
  return (
    <span className={clsx('inline-flex items-center gap-1.5 text-[11.5px] text-fg-3 font-medium whitespace-nowrap', className)}>
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: s?.color || 'var(--fg-3)' }} />
      {s?.label || sourceName || source}
    </span>
  );
}
