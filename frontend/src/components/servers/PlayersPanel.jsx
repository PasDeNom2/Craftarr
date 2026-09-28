import React, { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import {
  Users, Search, Crown, Ban, ShieldCheck, AlertTriangle, LogOut, Clock, Activity, TrendingUp, UserPlus, Wifi, ChevronRight, Trophy,
} from 'lucide-react';
import {
  getPlayers, getPlayersOverview, kickPlayer, warnPlayer, banPlayer, unbanPlayer, opPlayer, deopPlayer,
} from '../../services/api';
import { getSocket } from '../../hooks/useSocket';
import { useI18n } from '../../i18n';
import { useDateLocale } from '../../utils/dateLocale';
import { parseDbDate } from '../../utils/dates';
import Modal from '../ui/Modal';
import Segmented from '../ui/Segmented';
import PlayerProfile from './players/PlayerProfile';
import PlayerActions from './players/PlayerActions';
import { PlayerAvatar, Kpi, Heatmap, Pill, SectionCard } from './players/parts';
import { formatDuration, sessionRanges, dailyActivity, weekHeatmap } from './players/playerUtils';

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

/** Actions de modération partagées par la liste et la fiche joueur. */
function usePlayerActions(server) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['players', server.id] });
    qc.invalidateQueries({ queryKey: ['player-profile', server.id] });
  };
  const mk = (fn, okKey) => useMutation({ // eslint-disable-line react-hooks/rules-of-hooks
    mutationFn: fn,
    onSuccess: () => { toast.success(t(okKey)); refresh(); },
    onError: () => toast.error(t('players.actionError')),
  });
  const kick = mk(({ username, reason }) => kickPlayer(server.id, username, reason), 'players.kickSuccess');
  const warn = mk(({ username, reason }) => warnPlayer(server.id, username, reason), 'players.warnSuccess');
  const ban = mk(({ username, reason }) => banPlayer(server.id, username, reason), 'players.banSuccess');
  const unban = mk(({ username }) => unbanPlayer(server.id, username), 'players.unbanSuccess');
  const op = mk(({ username }) => opPlayer(server.id, username), 'players.opSuccess');
  const deop = mk(({ username }) => deopPlayer(server.id, username), 'players.deopSuccess');

  const ui = modal && (
    <ActionModal
      title={`${t(`players.${modal.type}`)} ${modal.player.username}`}
      placeholder={t('players.reasonPlaceholder')}
      confirmLabel={t(`players.${modal.type}`)}
      confirmClass={modal.type === 'warn' ? 'btn-secondary' : 'btn-danger'}
      onClose={() => setModal(null)}
      onConfirm={reason => {
        const username = modal.player.username;
        const fallback = { kick: 'Kicked by admin', warn: 'Warning from admin', ban: 'Banned by admin' }[modal.type];
        ({ kick, warn, ban })[modal.type].mutate({ username, reason: reason || fallback });
        setModal(null);
      }}
    />
  );
  return {
    ui,
    ask: (type, player) => setModal({ type, player }),
    unban: p => unban.mutate({ username: p.username }),
    toggleOp: p => (p.is_op ? deop : op).mutate({ username: p.username }),
    busy: unban.isPending || op.isPending || deop.isPending,
    running: server.status === 'running',
  };
}

const PERIODS = [7, 30, 90];

export default function PlayersPanel({ server }) {
  const { t, lang } = useI18n();
  const locale = useDateLocale();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const [days, setDays] = useState(30);
  const [sort, setSort] = useState('recent');
  const [filter, setFilter] = useState('all');
  const actions = usePlayerActions(server);

  const { data: players = [], isLoading } = useQuery({
    queryKey: ['players', server.id],
    queryFn: () => getPlayers(server.id),
    refetchInterval: 15000,
  });
  const { data: overview } = useQuery({
    queryKey: ['players-overview', server.id, days],
    queryFn: () => getPlayersOverview(server.id, days),
    refetchInterval: 60000,
  });

  // Statut en ligne en temps réel
  useEffect(() => {
    const socket = getSocket();
    const handler = ({ serverId, username, is_online }) => {
      if (serverId !== server.id) return;
      qc.setQueryData(['players', server.id], (old = []) => old.map(p => (p.username === username ? { ...p, is_online } : p)));
      qc.invalidateQueries({ queryKey: ['players', server.id] });
    };
    socket.on('player:status', handler);
    return () => socket.off('player:status', handler);
  }, [server.id, qc]);

  const ranges = useMemo(() => sessionRanges(overview?.sessions || []), [overview]);
  const since = Date.now() - days * 86_400_000;
  const daily = useMemo(() => dailyActivity(ranges, days), [ranges, days]);
  const heat = useMemo(() => weekHeatmap(ranges, since), [ranges]); // eslint-disable-line react-hooks/exhaustive-deps
  const periodSeconds = daily.reduce((a, d) => a + d.seconds, 0);
  const periodSessions = ranges.filter(r => r.start >= since).length;
  const activePlayers = new Set(ranges.filter(r => r.end >= since).map(r => r.username)).size;
  const leaderboard = useMemo(() => {
    const m = new Map();
    for (const r of ranges) {
      const s = (r.end - Math.max(r.start, since)) / 1000;
      if (s > 0) m.set(r.username, (m.get(r.username) || 0) + s);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [ranges]); // eslint-disable-line react-hooks/exhaustive-deps
  const chartData = daily.map(d => ({
    label: d.day.toLocaleDateString(lang, days > 30 ? { day: 'numeric', month: 'numeric' } : { day: 'numeric', month: 'short' }),
    hours: +(d.seconds / 3600).toFixed(2),
    players: d.players.size,
  }));

  if (selected) {
    const fresh = players.find(p => p.username === selected) || { username: selected };
    return (
      <>
        <PlayerProfile server={server} username={selected} listEntry={fresh} actions={actions} onBack={() => setSelected(null)} />
        {actions.ui}
      </>
    );
  }

  const counts = {
    all: players.length,
    online: players.filter(p => p.is_online === 1).length,
    ops: players.filter(p => p.is_op === 1).length,
    banned: players.filter(p => p.is_banned === 1).length,
  };
  const list = players
    .filter(p => !search || p.username.toLowerCase().includes(search.toLowerCase()))
    .filter(p => filter === 'all' || (filter === 'online' && p.is_online === 1) || (filter === 'ops' && p.is_op === 1) || (filter === 'banned' && p.is_banned === 1))
    .sort((a, b) => {
      if (sort === 'playtime') return (b.playtime_seconds || 0) - (a.playtime_seconds || 0);
      if (sort === 'name') return a.username.localeCompare(b.username);
      return (b.is_online - a.is_online) || String(b.last_seen).localeCompare(String(a.last_seen));
    });
  const totals = overview?.totals;
  const peakDate = parseDbDate(totals?.peak_at);

  return (
    <div className="space-y-4 max-w-6xl pb-8">
      {/* En-tête */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-[17px] font-semibold text-fg">{t('players.title')}</h3>
          <p className="text-xs text-fg-2 mt-0.5">{players.length} {t('players.totalPlayers')}</p>
        </div>
        <Segmented size="sm" value={days} onChange={setDays} items={PERIODS.map(n => ({ id: n, label: t('players.lastDays', { n }) }))} />
      </div>

      {/* Chiffres clés */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3 stagger">
        <Kpi icon={Users} label={t('players.kpiUnique')} value={totals?.players ?? players.length}
          sub={totals?.new_players ? t('players.kpiNew', { n: totals.new_players }) : t('players.kpiActive', { n: activePlayers })} tone="var(--info)" />
        <Kpi icon={Wifi} label={t('players.kpiOnline')} value={counts.online} sub={`/ ${server.max_players}`} tone="var(--accent)" />
        <Kpi icon={Clock} label={t('players.kpiPlaytime')} value={formatDuration(periodSeconds, { short: true })}
          sub={t('players.kpiTotal', { d: formatDuration(totals?.playtime_all || 0, { short: true }) })} tone="var(--purple)" />
        <Kpi icon={Activity} label={t('players.kpiSessions')} value={periodSessions}
          sub={periodSessions ? t('players.kpiAvg', { d: formatDuration(periodSeconds / Math.max(1, periodSessions)) }) : null} tone="var(--orange)" />
        <Kpi icon={TrendingUp} label={t('players.kpiPeak')} value={totals?.peak ?? '—'}
          sub={peakDate ? peakDate.toLocaleDateString(lang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null} tone="var(--warn)"
          className="col-span-2 md:col-span-1" />
      </div>

      {/* Activité */}
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-3">
        <SectionCard title={t('players.activity')} className="xl:col-span-3"
          right={<span className="text-[11px] text-fg-3">{t('players.activityHint')}</span>}>
          <ResponsiveContainer width="100%" height={190}>
            <BarChart data={chartData} margin={{ top: 4, right: 0, left: -18, bottom: 0 }}>
              <XAxis dataKey="label" tick={{ fontSize: 9.5, fill: 'rgba(235,235,245,0.35)' }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={14} />
              <YAxis tick={{ fontSize: 9.5, fill: 'rgba(235,235,245,0.35)' }} axisLine={false} tickLine={false} allowDecimals={false} width={40} />
              <Tooltip
                cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                content={({ active, payload }) => active && payload?.length ? (
                  <div className="glass-strong rounded-xl px-3 py-2 text-[11px]">
                    <p className="text-fg font-semibold">{payload[0].payload.label}</p>
                    <p className="text-fg-2">{formatDuration(payload[0].payload.hours * 3600)} · {t('players.nPlayers', { n: payload[0].payload.players })}</p>
                  </div>
                ) : null}
              />
              <Bar dataKey="hours" fill="var(--accent)" radius={[5, 5, 2, 2]} maxBarSize={22} />
            </BarChart>
          </ResponsiveContainer>
        </SectionCard>
        <SectionCard title={t('players.peakHours')} className="xl:col-span-2">
          <Heatmap grid={heat} locale={lang} />
        </SectionCard>
      </div>

      {/* Classement */}
      {leaderboard.length > 0 && (
        <SectionCard title={t('players.leaderboard')} right={<Trophy size={14} className="text-warn" />}>
          <ol className="space-y-1.5">
            {leaderboard.map(([name, secs], i) => (
              <li key={name}>
                <button onClick={() => setSelected(name)} className="w-full flex items-center gap-3 px-2 py-1.5 rounded-xl hover:bg-white/[0.05] transition-colors text-left">
                  <span className="w-5 text-center text-[12px] font-bold tabular-nums" style={{ color: ['#FFD60A', '#C7C7CC', '#D08A4E'][i] || 'var(--fg-3)' }}>{i + 1}</span>
                  <PlayerAvatar username={name} size={24} className="rounded-md" />
                  <span className="text-[13px] text-fg font-medium w-32 truncate">{name}</span>
                  <div className="flex-1 h-2 rounded-full bg-white/[0.06] overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${(secs / leaderboard[0][1]) * 100}%`, background: 'var(--purple)' }} />
                  </div>
                  <span className="w-16 text-right text-[12px] font-mono text-fg-2 tabular-nums">{formatDuration(secs, { short: secs >= 36000 })}</span>
                </button>
              </li>
            ))}
          </ol>
        </SectionCard>
      )}

      {/* Liste */}
      <div className="flex items-center gap-2 flex-wrap pt-2">
        <Segmented size="sm" value={filter} onChange={setFilter} items={[
          { id: 'all', label: t('players.filterAll'), badge: <span className="text-[10px] text-fg-3 font-mono">{counts.all}</span> },
          { id: 'online', label: t('players.filterOnline'), badge: counts.online ? <span className="text-[10px] font-mono" style={{ color: 'var(--accent)' }}>{counts.online}</span> : null },
          { id: 'ops', label: t('players.op'), badge: counts.ops ? <span className="text-[10px] text-fg-3 font-mono">{counts.ops}</span> : null },
          { id: 'banned', label: t('players.filterBanned'), badge: counts.banned ? <span className="text-[10px] font-mono" style={{ color: 'var(--danger)' }}>{counts.banned}</span> : null },
        ]} />
        <Segmented size="sm" value={sort} onChange={setSort} items={[
          { id: 'recent', label: t('players.sortRecent') },
          { id: 'playtime', label: t('players.sortPlaytime') },
          { id: 'name', label: t('players.sortName') },
        ]} />
        <div className="relative ml-auto">
          <Search size={13} strokeWidth={1.75} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-3 pointer-events-none" />
          <input className="input !h-9 !rounded-full !pl-8 text-xs w-52" placeholder={t('players.search')} value={search} onChange={e => setSearch(e.target.value)} />
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map(i => <div key={i} className="skeleton h-16" />)}</div>
      ) : list.length === 0 ? (
        <div className="card flex flex-col items-center py-14 gap-3 text-center">
          <span className="w-14 h-14 rounded-2xl bg-white/[0.06] flex items-center justify-center text-fg-3"><Users size={24} strokeWidth={1.5} /></span>
          <p className="text-sm text-fg-2">{search ? t('players.noResults') : t('players.noPlayers')}</p>
          {!search && <p className="text-xs text-fg-3">{t('players.noPlayersHint')}</p>}
        </div>
      ) : (
        <div className="card !p-0 overflow-hidden divide-y divide-white/[0.06] stagger-fast">
          {list.map(p => {
            const last = parseDbDate(p.last_seen);
            const onlineSince = parseDbDate(p.online_since);
            return (
              <div key={p.username} onClick={() => setSelected(p.username)}
                className="group flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-white/[0.04] transition-colors"
                style={p.is_banned ? { background: 'rgba(var(--danger-rgb),0.05)' } : undefined}>
                <div className="relative shrink-0" style={{ opacity: p.is_banned ? 0.5 : 1 }}>
                  <PlayerAvatar username={p.username} size={40} className="rounded-xl" />
                  {p.is_online === 1 && (
                    <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 pulse-dot"
                      style={{ background: 'var(--accent)', borderColor: 'rgb(30,30,36)' }} />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[14px] font-semibold text-fg">{p.username}</span>
                    {p.is_op === 1 && <Pill tone="var(--warn)" bg="rgba(var(--warn-rgb),0.12)"><Crown size={9} /> OP</Pill>}
                    {p.is_banned === 1 && <Pill tone="var(--danger)" bg="rgba(var(--danger-rgb),0.12)">{t('players.banned')}</Pill>}
                  </div>
                  <p className="text-[11.5px] text-fg-3 mt-0.5 truncate">
                    {p.is_online === 1 && onlineSince
                      ? <span style={{ color: 'var(--accent)' }}>{t('players.onlineSince', { d: formatDuration((Date.now() - onlineSince) / 1000) })}</span>
                      : last && t('players.lastSeen', { ago: formatDistanceToNow(last, { addSuffix: true, locale }) })}
                    {' · '}{t('players.nSessions', { n: p.session_count || p.join_count || 0 })}
                    {p.death_count > 0 && <> · {t('players.nDeaths', { n: p.death_count })}</>}
                    {p.is_banned === 1 && p.ban_reason && <span className="text-danger"> · {p.ban_reason}</span>}
                  </p>
                </div>
                <div className="hidden sm:block text-right shrink-0 mr-1">
                  <p className="text-[14px] font-semibold text-fg tabular-nums">{formatDuration(p.playtime_seconds || 0, { short: true })}</p>
                  <p className="text-[10.5px] text-fg-3">{t('players.playtimeTracked')}</p>
                </div>
                <div className="hidden md:flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                  <PlayerActions player={p} actions={actions} compact />
                </div>
                <ChevronRight size={16} className="text-fg-3 shrink-0" />
              </div>
            );
          })}
        </div>
      )}
      {actions.ui}
    </div>
  );
}
