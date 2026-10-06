import React from 'react';
import { Crown, Ban, ShieldCheck, AlertTriangle, LogOut } from 'lucide-react';
import { useI18n } from '../../../i18n';

/** Boutons de modération (liste et fiche joueur). */
export default function PlayerActions({ player, actions, compact }) {
  const { t } = useI18n();
  const btn = compact ? 'btn-secondary !h-8 !px-2.5 text-[11.5px] gap-1' : 'btn-secondary !h-9 text-[12.5px]';
  if (player.is_banned) {
    return (
      <button className={btn} style={{ color: 'var(--success)' }} onClick={() => actions.unban(player)} disabled={actions.busy}>
        <ShieldCheck size={13} /> {t('players.unban')}
      </button>
    );
  }
  return (
    <>
      <button className={btn} onClick={() => actions.toggleOp(player)} disabled={actions.busy} title={player.is_op ? t('players.deop') : t('players.op')}
        style={{ color: player.is_op ? 'var(--warn)' : undefined }}>
        <Crown size={13} /> {!compact && (player.is_op ? t('players.deop') : t('players.op'))}
      </button>
      {actions.running && player.is_online === 1 && (
        <>
          <button className={btn} onClick={() => actions.ask('warn', player)} title={t('players.warn')} style={{ color: 'var(--orange)' }}>
            <AlertTriangle size={13} /> {!compact && t('players.warn')}
          </button>
          <button className={btn} onClick={() => actions.ask('kick', player)} title={t('players.kick')}>
            <LogOut size={13} /> {!compact && t('players.kick')}
          </button>
        </>
      )}
      <button className={compact ? 'btn-danger !h-8 !px-2.5 text-[11.5px]' : 'btn-danger !h-9 text-[12.5px]'} onClick={() => actions.ask('ban', player)} title={t('players.ban')}>
        <Ban size={13} /> {!compact && t('players.ban')}
      </button>
    </>
  );
}
