import React, { useState } from 'react';
import clsx from 'clsx';
import { Save, Sun, CloudSun, Users, Megaphone, Send } from 'lucide-react';
import { useMetricsStore } from '../../../store';
import { useI18n } from '../../../i18n';

function PlayerHead({ name, size = 22 }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="rounded-[4px] bg-surface-2 text-fg-2 text-[10px] font-bold flex items-center justify-center shrink-0" style={{ width: size, height: size }}>
        {name[0]?.toUpperCase()}
      </span>
    );
  }
  return (
    <img
      src={`https://mc-heads.net/avatar/${encodeURIComponent(name)}/${size * 2}`}
      alt="" width={size} height={size}
      className="rounded-[4px] shrink-0" style={{ imageRendering: 'pixelated' }}
      onError={() => setFailed(true)}
    />
  );
}

function Stat({ label, value, unit, sub, tone }) {
  return (
    <div className="rounded-2xl px-3 py-2.5 bg-white/[0.06] min-w-0">
      <p className="text-[10px] uppercase tracking-[0.08em] text-fg-3 font-medium truncate">{label}</p>
      <p className="mt-1 font-mono text-lg leading-none font-semibold truncate" style={{ color: tone || 'var(--fg)' }}>
        {value}{unit && <span className="text-[11px] text-fg-3 font-normal ml-1">{unit}</span>}
      </p>
      {sub && <p className="text-[10px] text-fg-3 mt-1 font-mono truncate">{sub}</p>}
    </div>
  );
}

function Section({ title, right, children }) {
  return (
    <section className="px-4 py-4 border-b border-white/[0.06] last:border-b-0">
      <div className="flex items-center justify-between mb-3">
        <h3 className="eyebrow">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

/** Panneau « en direct » à droite de la console : état, joueurs connectés, actions rapides. */
export default function LivePanel({ server, onlinePlayers, onRun, onPickPlayer }) {
  const { t } = useI18n();
  const metrics = useMetricsStore(s => s.metrics[server.id]);
  const [announce, setAnnounce] = useState('');
  const running = server.status === 'running';

  const tps = metrics?.tps?.tps1;
  const tpsTone = tps == null ? 'var(--fg-3)' : tps >= 18 ? 'var(--accent)' : tps >= 12 ? 'var(--warn)' : 'var(--danger)';
  const usedGb = metrics?.memUsed ? metrics.memUsed / 1024 : null;
  const allocGb = server.ram_mb / 1024;
  const memPct = usedGb ? Math.min(100, (usedGb / allocGb) * 100) : 0;
  const cpu = metrics?.cpu;

  const quick = [
    { icon: Save, label: t('console.quick.save'), cmd: 'save-all' },
    { icon: Sun, label: t('console.quick.day'), cmd: 'time set day' },
    { icon: CloudSun, label: t('console.quick.weather'), cmd: 'weather clear' },
    { icon: Users, label: t('console.quick.list'), cmd: 'list' },
  ];

  return (
    <aside className="glass w-[290px] shrink-0 rounded-[26px] overflow-y-auto hidden xl:block">
      <Section title={t('console.live')} right={running && <span className="status-block live text-accent" />}>
        <div className="grid grid-cols-2 gap-2">
          <Stat label="TPS" value={tps != null ? tps.toFixed(1) : '—'} tone={tpsTone} />
          <Stat label={t('console.players')} value={metrics?.players?.online ?? onlinePlayers.length} unit={`/ ${server.max_players}`} />
          <Stat label="CPU" value={cpu != null ? cpu.toFixed(0) : '—'} unit="%" />
          <Stat label="RAM" value={usedGb != null ? usedGb.toFixed(1) : '—'} unit={`/ ${allocGb} Go`} />
        </div>
        <div className="mt-2 h-1 rounded-full bg-surface-2 overflow-hidden" title={`${memPct.toFixed(0)} %`}>
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${memPct}%`, background: memPct > 90 ? 'var(--danger)' : memPct > 75 ? 'var(--warn)' : 'var(--fg)' }}
          />
        </div>
      </Section>

      <Section title={t('console.onlinePlayers')} right={<span className="text-[11px] font-mono text-fg-3">{onlinePlayers.length}</span>}>
        {onlinePlayers.length === 0 ? (
          <p className="text-xs text-fg-3">{t('console.noPlayersOnline')}</p>
        ) : (
          <ul className="space-y-0.5 -mx-1.5">
            {onlinePlayers.map(p => (
              <li key={p.username}>
                <button
                  className="w-full flex items-center gap-2.5 px-1.5 py-1.5 rounded-xl hover:bg-white/[0.08] active:scale-[0.98] transition-all text-left group"
                  onClick={() => onPickPlayer(p.username)}
                  title={t('console.insertPlayer')}
                >
                  <PlayerHead name={p.username} />
                  <span className="text-[13px] text-fg truncate flex-1">{p.username}</span>
                  {p.is_op ? <span className="text-[10px] text-warn font-mono">OP</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t('console.quickActions')}>
        <div className="grid grid-cols-2 gap-1.5">
          {quick.map(({ icon: Icon, label, cmd }) => (
            <button
              key={cmd}
              disabled={!running}
              onClick={() => onRun(cmd)}
              title={`/${cmd}`}
              className="flex items-center gap-2 px-3 py-2 rounded-full bg-white/[0.07] text-xs font-medium text-fg-2 hover:text-fg hover:bg-white/[0.13] active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              <Icon size={13} strokeWidth={1.5} className="shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          ))}
        </div>
        <form
          className="mt-2 flex items-center gap-1.5"
          onSubmit={e => { e.preventDefault(); if (announce.trim()) { onRun(`say ${announce.trim()}`); setAnnounce(''); } }}
        >
          <div className="relative flex-1">
            <Megaphone size={12} strokeWidth={1.5} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3" />
            <input
              className="input !h-9 !rounded-full !pl-7 text-xs"
              placeholder={t('console.quick.announce')}
              value={announce}
              onChange={e => setAnnounce(e.target.value)}
              disabled={!running}
            />
          </div>
          <button type="submit" disabled={!running || !announce.trim()} className={clsx('w-9 h-9 shrink-0 flex items-center justify-center rounded-full bg-fg text-black active:scale-90 disabled:opacity-30 transition-all')} aria-label={t('console.send')}>
            <Send size={12} strokeWidth={1.5} />
          </button>
        </form>
      </Section>
    </aside>
  );
}
