import React from 'react';
import clsx from 'clsx';
import { Mountain, Pause, Check, RotateCw, AlertTriangle, Clock } from 'lucide-react';
import { useI18n } from '../../i18n';

const TONE = {
  running: 'var(--info)', paused: 'var(--warn)', done: 'var(--accent)',
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

  return (
    <div className={clsx(compact ? 'space-y-2' : 'space-y-2.5')}>
      <div className="flex items-center gap-2 min-w-0">
        <span className="w-6 h-6 rounded-[8px] flex items-center justify-center shrink-0" style={{ color: tone, background: 'rgba(255,255,255,0.07)' }}>
          <Icon size={13} strokeWidth={2} className={clsx(status === 'running' && 'animate-pulse')} />
        </span>
        <span className="text-[13px] font-medium text-fg truncate">{label}</span>
        <span className="ml-auto font-mono text-[13px] font-semibold tabular-nums" style={{ color: tone }}>{pct.toFixed(pct >= 10 || pct === 0 ? 0 : 1)} %</span>
      </div>
      <div className="h-2 rounded-full bg-white/[0.08] overflow-hidden">
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
