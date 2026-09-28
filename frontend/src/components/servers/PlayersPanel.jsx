import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getPlayers, getPlayerEvents, kickPlayer, warnPlayer, banPlayer, unbanPlayer, opPlayer, deopPlayer } from '../../services/api';
import { getSocket } from '../../hooks/useSocket';
import { useI18n } from '../../i18n';
import toast from 'react-hot-toast';
import { format } from 'date-fns';
import { parseDbDate } from '../../utils/dates';
import {
  Users, ChevronRight, ChevronLeft, Search, AlertTriangle, Ban,
  LogOut, MessageSquareWarning, ShieldCheck, Clock, Hash, Crown,
} from 'lucide-react';
import clsx from 'clsx';
import Modal from '../ui/Modal';



function PlayerAvatar({ username, size = 32, className = '' }) {
  const [err, setErr] = useState(false);
  if (err) {
    return (
      <div
        className={`flex items-center justify-center text-sm font-bold ${className}`}
        style={{ width: size, height: size, background: 'rgba(255,255,255,0.06)', color: 'var(--fg)' }}
      >
        {username[0].toUpperCase()}
      </div>
    );
  }
  return (
    <img
      src={`https://mc-heads.net/avatar/${username}/${size}`}
      alt={username}
      width={size}
      height={size}
      className={className}
      onError={() => setErr(true)}
      style={{ imageRendering: 'pixelated' }}
    />
  );
}

const EVENT_ICONS = {
  join:    { icon: '→', color: 'var(--accent)' },
  leave:   { icon: '←', color: 'var(--fg-2)' },
  chat:    { icon: '💬', color: 'var(--info)' },
  command: { icon: '/', color: 'var(--warn)' },
  death:   { icon: '💀', color: 'var(--danger)' },
  warn:    { icon: '⚠', color: 'var(--orange)' },
  kick:    { icon: '🥾', color: 'var(--orange)' },
  ban:     { icon: '🔨', color: 'var(--danger)' },
  unban:   { icon: '✓', color: 'var(--accent)' },
};

function ActionModal({ title, placeholder, onConfirm, onClose, confirmLabel, confirmClass = 'btn-danger' }) {
  const [reason, setReason] = useState('');
  const { t } = useI18n();
  return (
    <Modal open onClose={onClose} title={title} size="sm">
      <form className="px-6 pb-6 space-y-4" onSubmit={e => { e.preventDefault(); onConfirm(reason); }}>
        <input className="input w-full" placeholder={placeholder} value={reason} onChange={e => setReason(e.target.value)} autoFocus />
        <div className="flex gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className={`${confirmClass} ml-auto`}>{confirmLabel}</button>
        </div>
      </form>
    </Modal>
  );
}

function PlayerEvents({ server, player, onBack }) {
  const { t } = useI18n();

  const { data: events = [], isLoading } = useQuery({
    queryKey: ['player-events', server.id, player.username],
    queryFn: () => getPlayerEvents(server.id, player.username, { limit: 200 }),
    refetchInterval: 10000,
  });

  const typeLabel = {
    join: t('players.eventJoin'), leave: t('players.eventLeave'),
    chat: t('players.eventChat'), command: t('players.eventCommand'),
    death: t('players.eventDeath'), warn: t('players.eventWarn'),
    kick: t('players.eventKick'), ban: t('players.eventBan'),
    unban: t('players.eventUnban'),
  };

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center gap-3">
        <button className="icon-btn !h-9 !min-w-9" onClick={onBack} title={t('players.backToList')}>
          <ChevronLeft size={18} />
        </button>
        <div className="flex items-center gap-2">
          <PlayerAvatar username={player.username} size={40} className="rounded-xl" />
          <div>
            <p className="text-[17px] font-semibold text-fg">{player.username}</p>
            <p className="text-xs text-fg-2">{events.length} {t('players.events')}</p>
          </div>
          {player.is_banned === 1 && (
            <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(var(--danger-rgb),0.1)', color: 'var(--danger)', border: '1px solid rgba(var(--danger-rgb),0.2)' }}>
              {t('players.banned')}
            </span>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="text-center text-fg-2 py-8 text-sm">{t('common.loading')}</div>
      ) : events.length === 0 ? (
        <div className="text-center py-12 text-sm text-fg-2">{t('players.noEvents')}</div>
      ) : (
        <div className="card !p-0 overflow-hidden divide-y divide-white/[0.06] stagger-fast">
          {events.map(ev => {
            const meta = EVENT_ICONS[ev.type] || { icon: '•', color: 'var(--fg-2)' };
            return (
              <div key={ev.id}
                className="flex items-start gap-3 px-4 py-2.5"
              >
                <span className="text-sm w-5 text-center shrink-0 mt-0.5" style={{ color: meta.color }}>{meta.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-medium" style={{ color: meta.color }}>{typeLabel[ev.type] || ev.type}</span>
                    {ev.detail && <span className="text-xs text-fg truncate max-w-xs font-mono">{ev.detail}</span>}
                  </div>
                </div>
                <span className="text-[11px] text-fg-3 shrink-0">
                  {(() => { try { return format(new Date(ev.timestamp.replace(' ', 'T') + 'Z'), 'dd/MM/yyyy HH:mm'); } catch { return ev.timestamp; } })()}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function PlayersPanel({ server }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const [modal, setModal] = useState(null); // { type: 'kick'|'warn'|'ban', player }

  const { data: players = [], isLoading } = useQuery({
    queryKey: ['players', server.id],
    queryFn: () => getPlayers(server.id),
    refetchInterval: 15000,
  });

  // Mise à jour temps réel du statut en ligne via WebSocket
  useEffect(() => {
    const socket = getSocket();
    const handler = ({ serverId, username, is_online }) => {
      if (serverId !== server.id) return;
      qc.setQueryData(['players', server.id], (old = []) =>
        old.map(p => p.username === username ? { ...p, is_online } : p)
      );
    };
    socket.on('player:status', handler);
    return () => socket.off('player:status', handler);
  }, [server.id, qc]);

  const kickMut = useMutation({
    mutationFn: ({ username, reason }) => kickPlayer(server.id, username, reason),
    onSuccess: () => { toast.success(t('players.kickSuccess')); qc.invalidateQueries({ queryKey: ['players', server.id] }); },
    onError: () => toast.error(t('players.actionError')),
  });
  const warnMut = useMutation({
    mutationFn: ({ username, reason }) => warnPlayer(server.id, username, reason),
    onSuccess: () => { toast.success(t('players.warnSuccess')); qc.invalidateQueries({ queryKey: ['players', server.id] }); },
    onError: () => toast.error(t('players.actionError')),
  });
  const banMut = useMutation({
    mutationFn: ({ username, reason }) => banPlayer(server.id, username, reason),
    onSuccess: () => { toast.success(t('players.banSuccess')); qc.invalidateQueries({ queryKey: ['players', server.id] }); },
    onError: () => toast.error(t('players.actionError')),
  });
  const unbanMut = useMutation({
    mutationFn: ({ username }) => unbanPlayer(server.id, username),
    onSuccess: () => { toast.success(t('players.unbanSuccess')); qc.invalidateQueries({ queryKey: ['players', server.id] }); },
    onError: () => toast.error(t('players.actionError')),
  });
  const opMut = useMutation({
    mutationFn: ({ username }) => opPlayer(server.id, username),
    onSuccess: () => { toast.success(t('players.opSuccess')); qc.invalidateQueries({ queryKey: ['players', server.id] }); },
    onError: () => toast.error(t('players.actionError')),
  });
  const deopMut = useMutation({
    mutationFn: ({ username }) => deopPlayer(server.id, username),
    onSuccess: () => { toast.success(t('players.deopSuccess')); qc.invalidateQueries({ queryKey: ['players', server.id] }); },
    onError: () => toast.error(t('players.actionError')),
  });

  if (selectedPlayer) {
    return (
      <PlayerEvents
        server={server}
        player={selectedPlayer}
        onBack={() => setSelectedPlayer(null)}
      />
    );
  }

  const filtered = players.filter(p =>
    !search || p.username.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-4 max-w-3xl">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-[17px] font-semibold text-fg">{t('players.title')}</h3>
          <p className="text-xs text-fg-2 mt-0.5">
            {players.length} {t('players.totalPlayers')}
            {players.filter(p => p.is_banned).length > 0 && (
              <span className="ml-2" style={{ color: 'var(--danger)' }}>
                · {players.filter(p => p.is_banned).length} {t('players.banned')}
              </span>
            )}
          </p>
        </div>
        <div className="relative">
          <Search size={13} strokeWidth={1.75} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-3 pointer-events-none" />
          <input
            className="input !h-9 !rounded-full !pl-8 text-xs w-52"
            placeholder={t('players.search')}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {isLoading ? (
        <div className="text-center text-fg-2 py-8 text-sm">{t('common.loading')}</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 space-y-3">
          <div className="w-10 h-10 rounded-xl mx-auto flex items-center justify-center"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <Users size={18} strokeWidth={1.5} className="text-fg-3" />
          </div>
          <p className="text-sm text-fg-2">{search ? t('players.noResults') : t('players.noPlayers')}</p>
          {!search && <p className="text-xs text-fg-3">{t('players.noPlayersHint')}</p>}
        </div>
      ) : (
        <div className="card !p-0 overflow-hidden divide-y divide-white/[0.06] stagger-fast">
          {filtered.map(player => (
            <div
              key={player.username}
              className="flex items-center gap-3 px-4 py-3 group transition-colors duration-150 hover:bg-white/[0.03]"
              style={player.is_banned ? { background: 'rgba(var(--danger-rgb),0.05)' } : undefined}
            >
              {/* Avatar */}
              <div className="shrink-0 relative" style={{ opacity: player.is_banned ? 0.5 : 1 }}>
                <PlayerAvatar username={player.username} size={38} className="rounded-xl" />
                {player.is_online === 1 && (
                  <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2"
                    style={{ background: 'var(--accent)', borderColor: 'rgb(30,30,36)', boxShadow: '0 0 6px var(--accent)' }} />
                )}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[14px] font-medium text-fg">{player.username}</span>
                  {player.is_op === 1 && (
                    <span className="flex items-center gap-0.5 text-[10px] px-2 py-0.5 rounded-full font-semibold" style={{ background: 'rgba(var(--warn-rgb),0.1)', color: 'var(--warn)' }}>
                      <Crown size={9} strokeWidth={2} />
                      {t('players.op')}
                    </span>
                  )}
                  {player.is_banned === 1 && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold" style={{ background: 'rgba(var(--danger-rgb),0.12)', color: 'var(--danger)' }}>
                      {t('players.banned')}
                    </span>
                  )}
                </div>
                <div className="flex gap-3 text-[11px] text-fg-3 mt-0.5 flex-wrap">
                  <span className="flex items-center gap-1">
                    <Hash size={10} />
                    {player.join_count} {t('players.connections')}
                  </span>
                  {player.last_seen && (
                    <span className="flex items-center gap-1">
                      <Clock size={10} />
                      {(parseDbDate(player.last_seen) ? format(parseDbDate(player.last_seen), 'dd/MM/yyyy HH:mm') : '—')}
                    </span>
                  )}
                  {player.is_banned === 1 && player.ban_reason && (
                    <span className="text-danger">{player.ban_reason}</span>
                  )}
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1 shrink-0">
                {/* Bouton unban toujours visible pour les joueurs bannis */}
                {player.is_banned === 1 && (
                  <button
                    className="btn-secondary !h-8 !px-2.5 text-[11.5px] gap-1"
                    onClick={() => unbanMut.mutate({ username: player.username })}
                    disabled={unbanMut.isPending}
                    style={{ color: 'var(--accent)' }}
                  >
                    <ShieldCheck size={11} strokeWidth={1.5} />
                    {t('players.unban')}
                  </button>
                )}
                {/* Actions secondaires visibles au survol */}
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                  <button
                    className="btn-secondary !h-8 !px-2.5 text-[11.5px] gap-1"
                    onClick={() => setSelectedPlayer(player)}
                    title={t('players.viewLogs')}
                  >
                    <ChevronRight size={11} strokeWidth={1.5} />
                    {t('players.logs')}
                  </button>
                  {player.is_banned !== 1 && (
                    player.is_op === 1 ? (
                      <button
                        className="btn-secondary !h-8 !px-2.5 text-[11.5px] gap-1"
                        onClick={() => deopMut.mutate({ username: player.username })}
                        disabled={deopMut.isPending}
                        title={t('players.deop')}
                        style={{ color: 'var(--warn)' }}
                      >
                        <Crown size={11} strokeWidth={1.5} />
                      </button>
                    ) : (
                      <button
                        className="btn-secondary !h-8 !px-2.5 text-[11.5px] gap-1"
                        onClick={() => opMut.mutate({ username: player.username })}
                        disabled={opMut.isPending}
                        title={t('players.op')}
                        style={{ color: 'var(--fg-2)' }}
                      >
                        <Crown size={11} strokeWidth={1.5} />
                      </button>
                    )
                  )}
                  {server.status === 'running' && player.is_banned !== 1 && (
                    <>
                      <button
                        className="btn-secondary !h-8 !px-2.5 text-[11.5px] gap-1"
                        onClick={() => setModal({ type: 'warn', player })}
                        title={t('players.warn')}
                        style={{ color: 'var(--orange)' }}
                      >
                        <AlertTriangle size={11} strokeWidth={1.5} />
                      </button>
                      <button
                        className="btn-secondary !h-8 !px-2.5 text-[11.5px] gap-1"
                        onClick={() => setModal({ type: 'kick', player })}
                        title={t('players.kick')}
                      >
                        <LogOut size={11} strokeWidth={1.5} />
                      </button>
                    </>
                  )}
                  {player.is_banned !== 1 && (
                    <button
                      className="btn-danger !h-8 !px-2.5 text-[11.5px] gap-1"
                      onClick={() => setModal({ type: 'ban', player })}
                      title={t('players.ban')}
                    >
                      <Ban size={11} strokeWidth={1.5} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Action modals */}
      {modal?.type === 'kick' && (
        <ActionModal
          title={`${t('players.kick')} ${modal.player.username}`}
          placeholder={t('players.reasonPlaceholder')}
          confirmLabel={t('players.kick')}
          onConfirm={(reason) => { kickMut.mutate({ username: modal.player.username, reason: reason || 'Kicked by admin' }); setModal(null); }}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'warn' && (
        <ActionModal
          title={`${t('players.warn')} ${modal.player.username}`}
          placeholder={t('players.reasonPlaceholder')}
          confirmLabel={t('players.warn')}
          confirmClass="btn-secondary"
          onConfirm={(reason) => { warnMut.mutate({ username: modal.player.username, reason: reason || 'Warning from admin' }); setModal(null); }}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'ban' && (
        <ActionModal
          title={`${t('players.ban')} ${modal.player.username}`}
          placeholder={t('players.reasonPlaceholder')}
          confirmLabel={t('players.ban')}
          onConfirm={(reason) => { banMut.mutate({ username: modal.player.username, reason: reason || 'Banned by admin' }); setModal(null); }}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}
