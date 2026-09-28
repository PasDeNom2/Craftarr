import React, { useState } from 'react';
import clsx from 'clsx';
import { formatDuration, humanizeId, weekdayNames, formatNumber } from './playerUtils';

export function PlayerAvatar({ username, size = 32, className = '', variant = 'avatar' }) {
  const [err, setErr] = useState(false);
  if (err) {
    return (
      <div className={clsx('flex items-center justify-center font-bold text-fg bg-white/[0.08]', className)} style={{ width: size, height: variant === 'body' ? size * 2 : size, fontSize: size * 0.4 }}>
        {username[0]?.toUpperCase()}
      </div>
    );
  }
  const src = variant === 'body'
    ? `https://mc-heads.net/body/${encodeURIComponent(username)}/${size * 2}`
    : `https://mc-heads.net/avatar/${encodeURIComponent(username)}/${size * 2}`;
  return (
    <img src={src} alt="" width={size} className={className} onError={() => setErr(true)} style={{ imageRendering: 'pixelated' }} />
  );
}

/** Tuile de chiffre clé */
export function Kpi({ icon: Icon, label, value, sub, tone = 'var(--fg)', className }) {
  return (
    <div className={clsx('card !p-4 min-w-0', className)}>
      <div className="flex items-center gap-2 mb-2.5">
        {Icon && (
          <span className="w-7 h-7 rounded-[9px] flex items-center justify-center bg-white/[0.07] shrink-0" style={{ color: tone }}>
            <Icon size={14} strokeWidth={2} />
          </span>
        )}
        <p className="text-[12px] text-fg-2 font-medium truncate">{label}</p>
      </div>
      <p className="text-[24px] leading-none font-semibold tracking-tight tabular-nums text-fg truncate">{value}</p>
      {sub && <p className="text-[11px] text-fg-3 mt-1.5 truncate">{sub}</p>}
    </div>
  );
}

/** Carte de chaleur jour × heure */
export function Heatmap({ grid, locale }) {
  const max = Math.max(1, ...grid.flat());
  const days = weekdayNames(locale);
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[440px]">
        {grid.map((row, d) => (
          <div key={d} className="flex items-center gap-[3px] mb-[3px]">
            <span className="w-9 shrink-0 text-[10px] text-fg-3 capitalize">{days[d]}</span>
            {row.map((v, h) => (
              <div
                key={h}
                title={`${days[d]} ${h}h — ${formatDuration(v)}`}
                className="flex-1 aspect-square rounded-[4px] transition-colors"
                style={{ background: v ? `rgba(var(--accent-rgb), ${0.12 + 0.88 * (v / max)})` : 'rgba(255,255,255,0.04)' }}
              />
            ))}
          </div>
        ))}
        <div className="flex gap-[3px] pl-9">
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h} className="flex-1 text-center text-[9px] text-fg-3 tabular-nums">{h % 3 === 0 ? h : ''}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Liste « top » avec barres (blocs minés, mobs tués…) */
export function BarList({ items, format = formatNumber, empty, color = 'var(--accent)' }) {
  if (!items?.length) return <p className="text-xs text-fg-3 py-2">{empty}</p>;
  const max = Math.max(...items.map(i => i.value));
  return (
    <ul className="space-y-1.5">
      {items.map(it => {
        const { name, mod } = humanizeId(it.id);
        return (
          <li key={it.id} className="relative h-8 rounded-[10px] overflow-hidden bg-white/[0.03]" title={it.id}>
            <div className="absolute inset-y-0 left-0 rounded-[10px] transition-[width] duration-700"
              style={{ width: `${Math.max(2, (it.value / max) * 100)}%`, background: color, opacity: 0.22 }} />
            <div className="relative h-full flex items-center gap-2 px-3 text-[12.5px]">
              <span className="text-fg truncate">{it.label || name}</span>
              {mod && <span className="text-[10px] text-fg-3 truncate">{mod}</span>}
              <span className="ml-auto font-mono text-fg-2 tabular-nums shrink-0">{format(it.value)}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Petite capsule d'état */
export function Pill({ children, tone = 'var(--fg-2)', bg, className }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 text-[10.5px] px-2 py-0.5 rounded-full font-semibold whitespace-nowrap', className)}
      style={{ color: tone, background: bg || 'rgba(255,255,255,0.08)' }}>
      {children}
    </span>
  );
}

export function SectionCard({ title, right, children, className }) {
  return (
    <section className={clsx('card !p-4', className)}>
      {(title || right) && (
        <div className="flex items-center justify-between gap-3 mb-3">
          <h4 className="text-[13px] font-semibold text-fg">{title}</h4>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}
