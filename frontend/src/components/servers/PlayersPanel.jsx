import React, { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useServerSocket } from '../../hooks/useSocket';
import { getPlayers, getPlayerEvents } from '../../services/api';
import { Users, ChevronRight, Sword, MessageSquare, Terminal, LogIn, LogOut } from 'lucide-react';
import clsx from 'clsx';

const EVENT_ICONS = {
  join:    { Icon: LogIn,         color: '#4ade80' },
  leave:   { Icon: LogOut,        color: '#6B6B76' },
  death:   { Icon: Sword,         color: '#F87171' },
  command: { Icon: Terminal,      color: '#FBBF24' },
  chat:    { Icon: MessageSquare, color: '#60a5fa' },
};

function PlayerAvatar({ username, uuid, online }) {
  const src = uuid
    ? `https://crafatar.com/avatars/${uuid}?size=40&overlay`
    : `https://mc-heads.net/avatar/${username}/40`;

  return (
    <div className="relative flex-shrink-0">
      <img
        src={src}
        alt={username}
        className="w-10 h-10 rounded"
        style={{ imageRendering: 'pixelated' }}
        onError={e => { e.target.src = `https://mc-heads.net/avatar/steve/40`; }}
      />
      <span
        className={clsx(
          'absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2',
          online ? 'bg-green-400' : 'bg-[#3a3a42]'
        )}
        style={{ borderColor: 'var(--bg-sidebar)' }}
      />
    </div>
  );
}

function PlayerRow({ player, serverId, selected, onSelect }) {
  const { data: events = [], isLoading } = useQuery({
    queryKey: ['player-events', serverId, player.username],
    queryFn: () => getPlayerEvents(serverId, player.username),
    enabled: selected,
    staleTime: 30_000,
  });

  return (
    <div>
      {/* Player header */}
      <button
        className={clsx(
          'w-full flex items-center gap-3 px-4 py-3 transition-colors text-left',
          selected
            ? 'bg-[rgba(var(--accent-rgb),0.08)]'
            : 'hover:bg-[rgba(255,255,255,0.03)]'
        )}
        onClick={onSelect}
      >
        <PlayerAvatar username={player.username} uuid={player.uuid} online={player.online} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-[#F0F0F0] truncate">{player.username}</span>
            {player.online && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-400">
                En ligne
              </span>
            )}
          </div>
          <span className="text-[11px] text-[#4A4A55]">
            {player.last_seen
              ? `Vu le ${new Date(player.last_seen).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`
              : `Première connexion ${new Date(player.first_seen).toLocaleDateString('fr-FR')}`}
          </span>
        </div>
        <ChevronRight
          size={14}
          className={clsx('text-[#4A4A55] transition-transform flex-shrink-0', selected && 'rotate-90')}
        />
      </button>

      {/* Event history */}
      {selected && (
        <div
          className="mx-3 mb-2 rounded overflow-hidden"
          style={{ background: 'var(--bg)', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          {isLoading ? (
            <div className="text-[11px] text-[#4A4A55] px-3 py-2">Chargement...</div>
          ) : events.length === 0 ? (
            <div className="text-[11px] text-[#4A4A55] px-3 py-2">Aucun événement enregistré.</div>
          ) : (
            <div className="max-h-48 overflow-y-auto">
              {events.map((ev, i) => {
                const cfg = EVENT_ICONS[ev.type] || EVENT_ICONS.chat;
                return (
                  <div
                    key={i}
                    className="flex items-start gap-2 px-3 py-1.5"
                    style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}
                  >
                    <cfg.Icon size={11} className="flex-shrink-0 mt-0.5" style={{ color: cfg.color }} />
                    <div className="flex-1 min-w-0">
                      {ev.detail && (
                        <span className="text-[11px] font-mono text-[#9B9BA6] break-all">{ev.detail}</span>
                      )}
                      {!ev.detail && (
                        <span className="text-[11px] text-[#6B6B76] capitalize">{ev.type}</span>
                      )}
                    </div>
                    <span className="text-[10px] text-[#3A3A42] flex-shrink-0 ml-1">
                      {new Date(ev.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function PlayersPanel({ server }) {
  const [selected, setSelected] = useState(null);

  const { data: players = [], refetch } = useQuery({
    queryKey: ['players', server.id],
    queryFn: () => getPlayers(server.id),
    staleTime: 30_000,
  });

  // Mise à jour temps réel via socket
  const handlePlayersUpdate = useCallback(({ serverId, players: updated }) => {
    if (serverId !== server.id) return;
    refetch();
  }, [server.id, refetch]);

  useServerSocket(server.id, server.container_id, { 'players:update': handlePlayersUpdate });

  const online = players.filter(p => p.online);
  const offline = players.filter(p => !p.online);

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ background: 'var(--bg)' }}>

      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2 flex-shrink-0"
        style={{ background: 'var(--bg-sidebar)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}
      >
        <div className="flex items-center gap-2">
          <Users size={13} strokeWidth={1.5} className="text-[#6B6B76]" />
          <span className="text-[11px] font-semibold text-[#6B6B76] font-mono uppercase tracking-widest">Joueurs</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-green-400 font-mono">{online.length} en ligne</span>
          <span className="text-[11px] text-[#4A4A55] font-mono">{players.length} total</span>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {players.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-[#4A4A55]">
            <Users size={20} strokeWidth={1} />
            <span className="text-sm">Aucun joueur enregistré</span>
            <span className="text-xs text-center max-w-xs">
              Les joueurs apparaissent ici dès leur première connexion au serveur.
            </span>
          </div>
        ) : (
          <div>
            {online.length > 0 && (
              <>
                <div className="px-4 py-1.5 text-[10px] font-semibold text-green-400 uppercase tracking-widest bg-green-500/5">
                  En ligne — {online.length}
                </div>
                {online.map(p => (
                  <PlayerRow
                    key={p.username}
                    player={p}
                    serverId={server.id}
                    selected={selected === p.username}
                    onSelect={() => setSelected(selected === p.username ? null : p.username)}
                  />
                ))}
              </>
            )}
            {offline.length > 0 && (
              <>
                <div className="px-4 py-1.5 text-[10px] font-semibold text-[#4A4A55] uppercase tracking-widest"
                  style={{ borderTop: online.length > 0 ? '1px solid rgba(255,255,255,0.04)' : undefined }}>
                  Hors ligne — {offline.length}
                </div>
                {offline.map(p => (
                  <PlayerRow
                    key={p.username}
                    player={p}
                    serverId={server.id}
                    selected={selected === p.username}
                    onSelect={() => setSelected(selected === p.username ? null : p.username)}
                  />
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
