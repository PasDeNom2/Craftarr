import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getPlayers, getPlayerEvents, kickPlayer, warnPlayer, banPlayer, unbanPlayer } from '../../services/api';
import { getSocket } from '../../hooks/useSocket';
import { useI18n } from '../../i18n';
import toast from 'react-hot-toast';
import { formatDistanceToNow } from 'date-fns';
import { fr, enUS, de, es, pt, it, nl, pl, cs, sv, ru, uk, ja, ko, zhCN, ar, tr } from 'date-fns/locale';
import {
  Users, ChevronRight, ChevronLeft, Search, AlertTriangle, Ban,
  LogOut, MessageSquareWarning, ShieldCheck, Clock, Hash,
} from 'lucide-react';
import clsx from 'clsx';

const DATE_FNS_LOCALES = { fr, en: enUS, de, es, pt, it, nl, pl, cs, sv, ru, uk, ja, ko, zh: zhCN, ar, tr };

function PlayerAvatar({ username, size = 32, className = '' }) {
  const [err, setErr] = useState(false);
  if (err) {
    return (
      <div
        className={`flex items-center justify-center text-sm font-bold ${className}`}
        style={{ width: size, height: size, background: 'rgba(255,255,255,0.06)', color: '#F0F0F0' }}
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
  join:    { icon: '→', color: '#4ADE80' },
  leave:   { icon: '←', color: '#6B6B76' },
  chat:    { icon: '💬', color: '#60A5FA' },
  command: { icon: '/', color: '#FBBF24' },
  death:   { icon: '💀', color: '#F87171' },
  warn:    { icon: '⚠', color: '#FB923C' },
  kick:    { icon: '🥾', color: '#FB923C' },
  ban:     { icon: '🔨', color: '#F87171' },
  unban:   { icon: '✓', color: '#4ADE80' },
};

function ActionModal({ title, placeholder, onConfirm, onClose, confirmLabel, confirmClass = 'btn-danger' }) {
  const [reason, setReason] = useState('');
  const { t } = useI18n();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }}>
      <div className="rounded-2xl p-6 space-y-4 w-full max-w-sm" style={{ background: '#131316', border: '1px solid rgba(255,255,255,0.08)' }}>
        <h3 className="text-sm font-semibold text-[#F0F0F0]">{title}</h3>
        <input
          className="input w-full"
          placeholder={placeholder}
          value={reason}
          onChange={e => setReason(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onConfirm(reason)}
          autoFocus
        />
        <div className="flex gap-2 pt-1">
          <button className="btn-ghost flex-1" onClick={onClose}>{t('common.cancel')}</button>
          <button className={`${confirmClass} flex-1`} onClick={() => onConfirm(reason)}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function PlayerEvents({ server, player, onBack }) {
  const { t, lang } = useI18n();
  const dateFnsLocale = DATE_FNS_LOCALES[lang] || enUS;

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
        <button className="btn-ghost text-xs py-1 px-2.5 gap-1.5" onClick={onBack}>
          <ChevronLeft size={13} strokeWidth={1.5} />
          {t('players.backToList')}
        </button>
        <div className="flex items-center gap-2">
          <PlayerAvatar username={player.username} size={32} className="rounded-lg" />
          <div>
            <p className="text-sm font-semibold text-[#F0F0F0]">{player.username}</p>
            <p className="text-xs text-[#6B6B76]">{events.length} {t('players.events')}</p>
          </div>
          {player.is_banned === 1 && (
            <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(248,113,113,0.1)', color: '#F87171', border: '1px solid rgba(248,113,113,0.2)' }}>
              {t('players.banned')}
            </span>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="text-center text-[#6B6B76] py-8 text-sm">{t('common.loading')}</div>
      ) : events.length === 0 ? (
        <div className="text-center py-12 text-sm text-[#6B6B76]">{t('players.noEvents')}</div>
      ) : (
        <div className="space-y-1">
          {events.map(ev => {
            const meta = EVENT_ICONS[ev.type] || { icon: '•', color: '#6B6B76' };
            return (
              <div key={ev.id}
                className="flex items-start gap-3 px-3 py-2 rounded-lg"
                style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}
              >
                <span className="text-sm w-5 text-center shrink-0 mt-0.5" style={{ color: meta.color }}>{meta.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-medium" style={{ color: meta.color }}>{typeLabel[ev.type] || ev.type}</span>
                    {ev.detail && <span className="text-xs text-[#C0C0C8] truncate max-w-xs font-mono">{ev.detail}</span>}
                  </div>
                </div>
                <span className="text-[11px] text-[#4A4A55] shrink-0">
                  {(() => { try { return formatDistanceToNow(new Date(ev.timestamp.replace(' ', 'T') + 'Z'), { locale: dateFnsLocale, addSuffix: true }); } catch { return ev.timestamp; } })()}
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
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const dateFnsLocale = DATE_FNS_LOCALES[locale] || enUS;
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
          <h3 className="text-sm font-semibold text-[#F0F0F0]">{t('players.title')}</h3>
          <p className="text-xs text-[#6B6B76] mt-0.5">
            {players.length} {t('players.totalPlayers')}
            {players.filter(p => p.is_banned).length > 0 && (
              <span className="ml-2" style={{ color: '#F87171' }}>
                · {players.filter(p => p.is_banned).length} {t('players.banned')}
              </span>
            )}
          </p>
        </div>
        <div className="relative">
          <Search size={13} strokeWidth={1.5} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#4A4A55]" />
          <input
            className="input pl-8 text-xs py-1.5 w-44"
            placeholder={t('players.search')}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {isLoading ? (
        <div className="text-center text-[#6B6B76] py-8 text-sm">{t('common.loading')}</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 space-y-3">
          <div className="w-10 h-10 rounded-xl mx-auto flex items-center justify-center"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <Users size={18} strokeWidth={1.5} className="text-[#4A4A55]" />
          </div>
          <p className="text-sm text-[#6B6B76]">{search ? t('players.noResults') : t('players.noPlayers')}</p>
          {!search && <p className="text-xs text-[#4A4A55]">{t('players.noPlayersHint')}</p>}
        </div>
      ) : (
        <div className="space-y-1.5">
          {filtered.map(player => (
            <div
              key={player.username}
              className="flex items-center gap-3 px-4 py-3 rounded-xl group transition-colors duration-150"
              style={{ background: '#131316', border: `1px solid ${player.is_banned ? 'rgba(248,113,113,0.15)' : 'rgba(255,255,255,0.06)'}` }}
            >
              {/* Avatar */}
              <div className="shrink-0 relative" style={{ opacity: player.is_banned ? 0.5 : 1 }}>
                <PlayerAvatar username={player.username} size={36} className="rounded-lg" />
                {player.is_online === 1 && (
                  <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2"
                    style={{ background: '#4ADE80', borderColor: '#131316' }} />
                )}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-[#F0F0F0]">{player.username}</span>
                  {player.is_banned === 1 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ background: 'rgba(248,113,113,0.1)', color: '#F87171' }}>
                      {t('players.banned')}
                    </span>
                  )}
                </div>
                <div className="flex gap-3 text-[11px] text-[#4A4A55] mt-0.5 flex-wrap">
                  <span className="flex items-center gap-1">
                    <Hash size={10} />
                    {player.join_count} {t('players.connections')}
                  </span>
                  {player.last_seen && (
                    <span className="flex items-center gap-1">
                      <Clock size={10} />
                      {formatDistanceToNow(new Date(player.last_seen), { locale: dateFnsLocale, addSuffix: true })}
                    </span>
                  )}
                  {player.is_banned === 1 && player.ban_reason && (
                    <span className="text-[#F87171]">{player.ban_reason}</span>
                  )}
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1 shrink-0">
                {/* Bouton unban toujours visible pour les joueurs bannis */}
                {player.is_banned === 1 && (
                  <button
                    className="btn-secondary text-[11px] py-1 px-2 gap-1"
                    onClick={() => unbanMut.mutate({ username: player.username })}
                    disabled={unbanMut.isPending}
                    style={{ color: '#4ADE80' }}
                  >
                    <ShieldCheck size={11} strokeWidth={1.5} />
                    {t('players.unban')}
                  </button>
                )}
                {/* Actions secondaires visibles au survol */}
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                  <button
                    className="btn-secondary text-[11px] py-1 px-2 gap-1"
                    onClick={() => setSelectedPlayer(player)}
                    title={t('players.viewLogs')}
                  >
                    <ChevronRight size={11} strokeWidth={1.5} />
                    {t('players.logs')}
                  </button>
                  {server.status === 'running' && player.is_banned !== 1 && (
                    <>
                      <button
                        className="btn-secondary text-[11px] py-1 px-2 gap-1"
                        onClick={() => setModal({ type: 'warn', player })}
                        title={t('players.warn')}
                        style={{ color: '#FB923C' }}
                      >
                        <AlertTriangle size={11} strokeWidth={1.5} />
                      </button>
                      <button
                        className="btn-secondary text-[11px] py-1 px-2 gap-1"
                        onClick={() => setModal({ type: 'kick', player })}
                        title={t('players.kick')}
                      >
                        <LogOut size={11} strokeWidth={1.5} />
                      </button>
                    </>
                  )}
                  {player.is_banned !== 1 && (
                    <button
                      className="btn-danger text-[11px] py-1 px-2 gap-1"
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
