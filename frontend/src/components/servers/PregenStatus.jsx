import React from 'react';
import clsx from 'clsx';
import { Mountain, Pause, Check, RotateCw, AlertTriangle, Clock } from 'lucide-react';
import { useI18n } from '../../i18n';
import { PREGEN_WORLDS } from '../catalog/PregenOption';

const TONE = {
  running: 'var(--info)', paused: 'var(--warn)', done: 'var(--success)',
  needs_restart: 'var(--warn)', error: 'var(--danger)', unsupported: 'var(--fg-3)', pending: 'var(--fg-2)',
};
const ICON = { running: Mountain, paused: Pause, done: Check, needs_restart: RotateCw, error: AlertTriangle, unsupported: AlertTriangle, pending: Clock };

/** Progression de la pré-génération Chunky (réglages + panneau en direct). */
export default function PregenStatus({ server, compact }) {
  const { t } = useI18n();
  if (!server.pregen_enabled) return null;
  const status = server.pregen_status || 'pending';
  const pct = status === 'done' ? 100 : Math.max(0, Math.min(100, +server.pregen_progress || 0));
  const tone = TONE[status] || 'var(--fg-2)';
  const Icon = ICON[status] || Clock;
  const label = t(`pregen.status.${status}`);
  // Plusieurs dimensions : laquelle est en cours (ex. « Nether · 2/3 »)
  const worlds = server.pregen_worlds || [];
  const idx = Math.min(server.pregen_world_index || 0, Math.max(0, worlds.length - 1));
  const worldKey = PREGEN_WORLDS.find(w => w.id === worlds[idx])?.key;
  const worldLabel = worlds.length > 1 && worldKey && ['running', 'paused'].includes(status)
    ? `${t(`pregen.worlds.${worldKey}`)} · ${idx + 1}/${worlds.length}` : null;

  return (
    <div className={clsx(compact ? 'space-y-2' : 'space-y-2.5')}>
      <div className="flex items-start gap-2.5 min-w-0">
        <Icon size={15} strokeWidth={1.75} className={clsx('shrink-0 mt-0.5', status === 'running' && 'animate-pulse')} style={{ color: tone }} />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-fg leading-tight">{label}</p>
          {worldLabel && <p className="text-[12px] text-fg-3 mt-0.5">{worldLabel}</p>}
        </div>
        <span className="shrink-0 whitespace-nowrap text-[13px] font-semibold tabular-nums" style={{ color: tone }}>{pct.toFixed(pct >= 10 || pct === 0 ? 0 : 1)} %</span>
      </div>
      <div className="h-1.5 rounded-full bg-tint/[0.08] overflow-hidden">
        <div
          className={clsx('h-full rounded-full transition-[width] duration-1000 ease-out', status === 'running' && 'pregen-bar')}
          style={{ width: `${pct}%`, backgroundColor: tone }}
        />
      </div>
      {(server.pregen_eta && status === 'running') && (
        <p className="text-[11px] text-fg-3">{t('pregen.eta', { eta: server.pregen_eta })}</p>
      )}
      {status === 'error' && server.pregen_message && (
        <p className="text-[11px] text-danger break-words">{server.pregen_message}</p>
      )}
    </div>
  );
}
