import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import {
  ChevronLeft, Crown, Copy, Eye, Heart, Drumstick, Sparkles, MapPin, Skull, Clock, Activity, Timer, Swords, Footprints,
  Pickaxe, Award, LogIn, LogOut, MessageSquare, Terminal, AlertTriangle, Ban, ShieldCheck, Search, Gamepad2, X, Hammer,
} from 'lucide-react';
import { getPlayerProfile, getPlayerEvents } from '../../../services/api';
import { useI18n } from '../../../i18n';
import { useDateLocale } from '../../../utils/dateLocale';
import { parseDbDate } from '../../../utils/dates';
import Segmented from '../../ui/Segmented';
import { PlayerAvatar, Kpi, BarList, Pill, SectionCard } from './parts';
import { formatDuration, formatNumber, formatDistance, humanizeId, sessionRanges, dailyActivity, hourly } from './playerUtils';
import PlayerActions from './PlayerActions';

const EVENT_META = {
  join: { Icon: LogIn, color: 'var(--success)' },
  leave: { Icon: LogOut, color: 'var(--fg-3)' },
  chat: { Icon: MessageSquare, color: 'var(--info)' },
  command: { Icon: Terminal, color: 'var(--purple)' },
  death: { Icon: Skull, color: 'var(--danger)' },
  advancement: { Icon: Award, color: 'var(--warn)' },
  warn: { Icon: AlertTriangle, color: 'var(--orange)' },
  kick: { Icon: LogOut, color: 'var(--orange)' },
  ban: { Icon: Ban, color: 'var(--danger)' },
  unban: { Icon: ShieldCheck, color: 'var(--success)' },
};
const EVENT_FILTERS = {
  all: null, sessions: 'join,leave', chat: 'chat', command: 'command', death: 'death', advancement: 'advancement', moderation: 'warn,kick,ban,unban',
};
const DIMENSIONS = { 'minecraft:overworld': 'overworld', 'minecraft:the_nether': 'nether', 'minecraft:the_end': 'end' };
const GAMEMODES = ['survival', 'creative', 'adventure', 'spectator'];

function copy(text, t) {
  navigator.clipboard?.writeText(text).then(() => toast.success(t('players.copied')), () => {});
}

// ─── Inventaire ───────────────────────────────────────────────
function ItemSlot({ item, selected, t }) {
  if (!item) return <div className={clsx('aspect-square rounded-[10px] bg-tint/[0.035]', selected && 'ring-2 ring-tint/40')} />;
  const { name, mod } = humanizeId(item.id);
  const label = item.name || name;
  const tip = [label, item.name ? name : null, item.id, item.enchants?.length ? item.enchants.map(e => `${humanizeId(e.id).name} ${e.level}`).join(', ') : null,
    item.damage ? t('players.durabilityUsed', { n: item.damage }) : null].filter(Boolean).join('\n');
  return (
    <div title={tip}
      className={clsx('relative aspect-square rounded-[10px] p-1 flex flex-col justify-center items-center text-center overflow-hidden transition-transform hover:scale-[1.04]',
        selected && 'ring-2 ring-tint/50')}
      style={{
        background: item.enchants?.length ? 'linear-gradient(135deg, rgba(191,90,242,0.22), rgba(var(--tint-rgb),0.05))' : 'rgba(var(--tint-rgb),0.07)',
        boxShadow: item.name ? 'inset 0 0 0 1px rgba(255,214,10,0.35)' : 'inset 0 0 0 1px rgba(var(--tint-rgb),0.06)',
      }}>
      <span className="text-[9px] leading-[1.15] text-fg line-clamp-3 break-words">{label}</span>
      {mod && <span className="text-[7.5px] text-fg-3 truncate max-w-full">{mod}</span>}
      {item.count > 1 && <span className="absolute bottom-0.5 right-1 text-[10px] font-bold text-fg tabular-nums" style={{ textShadow: '0 1px 2px #000' }}>{item.count}</span>}
    </div>
  );
}

function SlotGrid({ items, from, to, cols = 9, selectedSlot, t }) {
  const bySlot = new Map(items.map(i => [i.slot, i]));
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {Array.from({ length: to - from }, (_, i) => from + i).map(s => (
        <ItemSlot key={s} item={bySlot.get(s)} selected={selectedSlot === s} t={t} />
      ))}
    </div>
  );
}

function Inventory({ player, t }) {
  const eq = player.equipment || {};
  return (
    <div className="space-y-4">
      <SectionCard title={t('players.armor')}>
        <div className="grid grid-cols-5 sm:grid-cols-9 gap-1.5 max-w-[640px]">
          {['head', 'chest', 'legs', 'feet'].map(s => <ItemSlot key={s} item={eq[s]} t={t} />)}
          <ItemSlot item={eq.offhand} t={t} />
        </div>
        <p className="text-[10.5px] text-fg-3 mt-2">{t('players.armorHint')}</p>
      </SectionCard>
      <SectionCard title={t('players.inventory')}>
        <div className="max-w-[640px] space-y-3">
          <SlotGrid items={player.inventory} from={9} to={36} t={t} />
          <div className="h-px bg-tint/[0.06]" />
          <SlotGrid items={player.inventory} from={0} to={9} selectedSlot={player.selectedSlot} t={t} />
        </div>
      </SectionCard>
      <SectionCard title={t('players.enderChest')}>
        <div className="max-w-[640px]"><SlotGrid items={player.enderChest} from={0} to={27} t={t} /></div>
      </SectionCard>
    </div>
  );
}

// ─── Statistiques détaillées ─────────────────────────────────
function StatsTab({ stats, t }) {
  const distances = Object.entries(stats.distances || {}).filter(([k]) => k !== 'fall').sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ id: k, label: t(`players.dist.${k}`), value: v }));
  const misc = [
    ['sleeps', stats.sleeps], ['jumps', stats.jumps], ['fishCaught', stats.fishCaught], ['animalsBred', stats.animalsBred],
    ['trades', stats.trades], ['enchants', stats.enchants], ['chestsOpened', stats.chestsOpened], ['playerKills', stats.playerKills],
    ['itemsCrafted', stats.itemsCrafted], ['damageDealt', stats.damageDealt], ['damageTaken', stats.damageTaken],
  ].filter(([, v]) => v);
  const modStats = (stats.custom || []).filter(s => !s.id.startsWith('minecraft:'));
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      <SectionCard title={t('players.distances')}><BarList items={distances} format={formatDistance} empty="—" color="var(--info)" /></SectionCard>
      <SectionCard title={t('players.misc')}>
        <div className="grid grid-cols-2 gap-2">
          {misc.map(([k, v]) => (
            <div key={k} className="rounded-xl bg-tint/[0.04] px-3 py-2">
              <p className="text-[10.5px] text-fg-3">{t(`players.stat.${k}`)}</p>
              <p className="text-[15px] font-semibold text-fg tabular-nums">{formatNumber(v)}</p>
            </div>
          ))}
          {stats.timeSinceDeathSeconds > 0 && (
            <div className="rounded-xl bg-tint/[0.04] px-3 py-2">
              <p className="text-[10.5px] text-fg-3">{t('players.stat.timeSinceDeath')}</p>
              <p className="text-[15px] font-semibold text-fg">{formatDuration(stats.timeSinceDeathSeconds)}</p>
            </div>
          )}
        </div>
      </SectionCard>
      <SectionCard title={t('players.topMined')}><BarList items={stats.topMined} empty="—" color="var(--orange)" /></SectionCard>
      <SectionCard title={t('players.topKilled')}><BarList items={stats.topKilled} empty="—" color="var(--danger)" /></SectionCard>
      <SectionCard title={t('players.topCrafted')}><BarList items={stats.topCrafted} empty="—" color="var(--purple)" /></SectionCard>
      <SectionCard title={t('players.topUsed')}><BarList items={stats.topUsed} empty="—" color="var(--accent)" /></SectionCard>
      {stats.topKilledBy?.length > 0 && (
        <SectionCard title={t('players.topKilledBy')}><BarList items={stats.topKilledBy} color="var(--danger)" /></SectionCard>
      )}
      {modStats.length > 0 && (
        <SectionCard title={t('players.modStats')}>
          <ul className="divide-y divide-tint/[0.05]">
            {modStats.map(s => {
              const { name, mod } = humanizeId(s.id);
              return (
                <li key={s.id} className="flex items-center gap-2 py-1.5 text-[12.5px]">
                  <span className="text-fg">{name}</span><span className="text-[10px] text-fg-3">{mod}</span>
                  <span className="ml-auto font-mono text-fg-2 tabular-nums">{formatNumber(s.value)}</span>
                </li>
              );
            })}
          </ul>
        </SectionCard>
      )}
    </div>
  );
}

// ─── Journal ─────────────────────────────────────────────────
function Journal({ server, username, t, lang }) {
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const typeLabel = type => t(`players.event${type[0].toUpperCase()}${type.slice(1)}`);

  useEffect(() => { const h = setTimeout(() => setQuery(q.trim()), 300); return () => clearTimeout(h); }, [q]);

  const load = useCallback(async (reset) => {
    setLoading(true);
    try {
      const before = reset ? undefined : events[events.length - 1]?.id;
      const page = await getPlayerEvents(server.id, username, { limit: 100, type: EVENT_FILTERS[filter] || undefined, q: query || undefined, before });
      setEvents(prev => (reset ? page : [...prev, ...page]));
      setDone(page.length < 100);
    } catch { toast.error(t('common.error')); }
    finally { setLoading(false); }
  }, [server.id, username, filter, query, events, t]);

  useEffect(() => { load(true); }, [filter, query]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const out = [];
    for (const e of events) {
      const d = parseDbDate(e.timestamp);
      const key = d ? d.toDateString() : '?';
      if (!out.length || out[out.length - 1].key !== key) out.push({ key, date: d, items: [] });
      out[out.length - 1].items.push({ ...e, date: d });
    }
    return out;
  }, [events]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Segmented size="sm" value={filter} onChange={setFilter} items={Object.keys(EVENT_FILTERS).map(k => ({ id: k, label: t(`players.jf.${k}`) }))} />
        <div className="relative ml-auto">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-3 pointer-events-none" />
          <input className="input !h-9 !pl-8 !pr-8 text-xs w-56" placeholder={t('players.searchEvents')} value={q} onChange={e => setQ(e.target.value)} />
          {q && <button className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-3 hover:text-fg" onClick={() => setQ('')}><X size={12} /></button>}
        </div>
      </div>
      {groups.length === 0 && !loading ? (
        <div className="card text-center py-10 text-sm text-fg-2">{t('players.noEvents')}</div>
      ) : (
        <div className="space-y-3">
          {groups.map(g => (
            <div key={g.key}>
              <p className="eyebrow px-1 mb-1.5 capitalize">{g.date ? g.date.toLocaleDateString(lang, { weekday: 'long', day: 'numeric', month: 'long' }) : '—'}</p>
              <div className="card !p-0 overflow-hidden divide-y divide-tint/[0.05]">
                {g.items.map(ev => {
                  const meta = EVENT_META[ev.type] || { Icon: Activity, color: 'var(--fg-2)' };
                  const timeout = ev.type === 'leave' && /timed out|timeout/i.test(ev.detail || '');
                  return (
                    <div key={ev.id} className="flex items-start gap-3 px-4 py-2.5">
                      <span className="w-7 h-7 rounded-[9px] flex items-center justify-center shrink-0 bg-tint/[0.06]" style={{ color: meta.color }}>
                        <meta.Icon size={13} strokeWidth={2} />
                      </span>
                      <div className="flex-1 min-w-0 pt-0.5">
                        <span className="text-[12px] font-medium mr-2" style={{ color: meta.color }}>{typeLabel(ev.type)}</span>
                        {ev.detail && (
                          <span className={clsx('text-[12.5px] break-words', ev.type === 'chat' ? 'text-fg' : 'text-fg-2', ev.type === 'command' && 'font-mono', timeout && '!text-warn')}>
                            {ev.detail}
                          </span>
                        )}
                      </div>
                      <span className="text-[11px] text-fg-3 font-mono shrink-0 pt-1">{ev.date?.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {!done && (
            <button className="btn-secondary mx-auto flex" onClick={() => load(false)} disabled={loading}>{loading ? '…' : t('players.loadMore')}</button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Sessions ────────────────────────────────────────────────
function SessionsTab({ list, t, lang }) {
  if (!list.length) return <div className="card text-center py-10 text-sm text-fg-2">{t('players.noSessions')}</div>;
  const max = Math.max(...list.map(s => s.duration || 0), 1);
  const reasonLabel = r => (!r ? null : r === 'server_stop' ? t('players.reasonServerStop') : r === 'unknown' ? t('players.reasonUnknown') : r);
  return (
    <div className="card !p-0 overflow-hidden divide-y divide-tint/[0.05]">
      {list.map(s => {
        const start = parseDbDate(s.joined_at);
        const end = parseDbDate(s.left_at);
        const bad = s.reason && /timed out|timeout|exception|error/i.test(s.reason);
        return (
          <div key={s.id} className="flex items-center gap-3 px-4 py-2.5 text-[12.5px]">
            <span className="w-28 shrink-0 text-fg-2 capitalize">{start?.toLocaleDateString(lang, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
            <span className="w-28 shrink-0 font-mono text-fg-2 text-[11.5px]">
              {start?.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })} → {end ? end.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' }) : '…'}
            </span>
            <div className="flex-1 h-2 rounded-full bg-tint/[0.05] overflow-hidden min-w-[60px]">
              <div className="h-full rounded-full" style={{ width: `${Math.max(2, ((s.duration || 0) / max) * 100)}%`, background: end ? 'var(--purple)' : 'var(--accent)' }} />
            </div>
            <span className="w-16 text-right font-semibold text-fg tabular-nums">{formatDuration(s.duration)}</span>
            <span className="w-40 hidden md:block truncate text-right">
              {!end ? <Pill tone="var(--success)" bg="rgba(var(--success-rgb),0.12)">{t('players.inProgress')}</Pill>
                : reasonLabel(s.reason) && <Pill tone={bad ? 'var(--warn)' : 'var(--fg-3)'} bg={bad ? 'rgba(var(--warn-rgb),0.12)' : undefined}>{reasonLabel(s.reason)}</Pill>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Succès ──────────────────────────────────────────────────
function AdvancementsTab({ adv, lang, t }) {
  if (!adv?.done?.length) return <div className="card text-center py-10 text-sm text-fg-2">{t('players.noAdvancements')}</div>;
  return (
    <div className="card !p-0 overflow-hidden divide-y divide-tint/[0.05]">
      {adv.done.map(a => {
        const { name, mod } = humanizeId(a.id);
        const d = a.doneAt ? new Date(a.doneAt) : null;
        const category = a.id.split(':')[1]?.split('/')[0];
        return (
          <div key={a.id} className="flex items-center gap-3 px-4 py-2.5">
            <span className="w-7 h-7 rounded-[9px] flex items-center justify-center shrink-0" style={{ color: 'var(--warn)', background: 'rgba(var(--warn-rgb),0.1)' }}><Award size={13} /></span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-fg truncate">{name}</p>
              <p className="text-[10.5px] text-fg-3 truncate">{[mod || 'minecraft', category].filter(Boolean).join(' · ')}</p>
            </div>
            <span className="text-[11px] text-fg-3 shrink-0">{d?.toLocaleDateString(lang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Fiche ───────────────────────────────────────────────────
export default function PlayerProfile({ server, username, listEntry, actions, onBack }) {
  const { t, lang } = useI18n();
  const locale = useDateLocale();
  const [tab, setTab] = useState('journal');
  const [showIp, setShowIp] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['player-profile', server.id, username],
    queryFn: () => getPlayerProfile(server.id, username),
    refetchInterval: 30000,
  });

  const p = { ...listEntry, ...(data?.player || {}) };
  const world = data?.world || {};
  const stats = world.stats;
  const vitals = world.player;
  const sess = data?.sessions;
  const ranges = useMemo(() => sessionRanges((sess?.list || []).map(s => ({ ...s, username }))), [sess, username]);
  const daily = useMemo(() => dailyActivity(ranges, 30), [ranges]);
  const hours = useMemo(() => hourly(ranges), [ranges]);
  const first = parseDbDate(p.first_seen);
  const last = parseDbDate(p.last_seen);
  const onlineSince = parseDbDate(listEntry?.online_since);
  const dim = vitals?.dimension;
  const dimName = DIMENSIONS[dim] ? t(`players.dim.${DIMENSIONS[dim]}`) : humanizeId(dim || '').name;
  const tp = vitals?.pos ? `/execute in ${dim} run tp ${username} ${vitals.pos.map(v => Math.floor(v)).join(' ')}` : null;

  return (
    <div className="space-y-4 max-w-6xl pb-8 tab-in">
      {/* En-tête */}
      <div className="glass rounded-2xl p-5 flex gap-5 items-start flex-wrap">
        <button className="icon-btn !h-9 !min-w-9 -ml-1" onClick={onBack} aria-label={t('players.backToList')} title={t('players.backToList')}>
          <ChevronLeft size={18} />
        </button>
        <PlayerAvatar username={username} size={56} variant="body" className="shrink-0 drop-shadow-[0_8px_20px_rgba(0,0,0,0.5)] -my-1" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-[24px] font-bold text-fg tracking-tight">{username}</h2>
            {p.is_online === 1
              ? <Pill tone="var(--success)" bg="rgba(var(--success-rgb),0.14)"><span className="w-1.5 h-1.5 rounded-full bg-success" /> {onlineSince ? t('players.onlineSince', { d: formatDuration((Date.now() - onlineSince) / 1000) }) : t('players.filterOnline')}</Pill>
              : last && <Pill>{t('players.lastSeen', { ago: formatDistanceToNow(last, { addSuffix: true, locale }) })}</Pill>}
            {p.is_op === 1 && <Pill tone="var(--warn)" bg="rgba(var(--warn-rgb),0.12)"><Crown size={9} /> OP</Pill>}
            {p.is_banned === 1 && <Pill tone="var(--danger)" bg="rgba(var(--danger-rgb),0.12)">{t('players.banned')}{p.ban_reason ? ` · ${p.ban_reason}` : ''}</Pill>}
          </div>
          <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-[11.5px] text-fg-3">
            {first && <span>{t('players.firstSeen')} : <span className="text-fg-2">{first.toLocaleDateString(lang, { day: 'numeric', month: 'long', year: 'numeric' })}</span></span>}
            {p.uuid && (
              <button className="font-mono hover:text-fg transition-colors inline-flex items-center gap-1" onClick={() => copy(p.uuid, t)} title={t('players.copy')}>
                {p.uuid} <Copy size={10} />
              </button>
            )}
            {p.last_ip && (
              <button className="inline-flex items-center gap-1 hover:text-fg transition-colors" onClick={() => setShowIp(v => !v)}>
                IP : <span className="font-mono">{showIp ? p.last_ip : '•••.•••.•••.•••'}</span> <Eye size={11} />
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <PlayerActions player={p} actions={actions} />
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="skeleton h-[92px]" />)}</div>
      ) : (
        <>
          {/* État en jeu */}
          {vitals && (
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 stagger">
              <div className="card !p-4">
                <p className="text-[12px] text-fg-2 font-medium flex items-center gap-1.5 mb-2"><Heart size={13} className="text-danger" fill="currentColor" /> {t('players.health')}</p>
                <p className="text-[20px] font-semibold text-fg tabular-nums">{Math.round(vitals.health * 10) / 10}<span className="text-[12px] text-fg-3"> / {vitals.maxHealth}</span></p>
                <div className="h-1.5 mt-2 rounded-full bg-tint/[0.08] overflow-hidden"><div className="h-full rounded-full bg-danger" style={{ width: `${Math.min(100, (vitals.health / vitals.maxHealth) * 100)}%` }} /></div>
              </div>
              <div className="card !p-4">
                <p className="text-[12px] text-fg-2 font-medium flex items-center gap-1.5 mb-2"><Drumstick size={13} className="text-orange" /> {t('players.food')}</p>
                <p className="text-[20px] font-semibold text-fg tabular-nums">{vitals.food}<span className="text-[12px] text-fg-3"> / 20</span></p>
                <div className="h-1.5 mt-2 rounded-full bg-tint/[0.08] overflow-hidden"><div className="h-full rounded-full" style={{ width: `${(vitals.food / 20) * 100}%`, background: 'var(--orange)' }} /></div>
              </div>
              <div className="card !p-4">
                <p className="text-[12px] text-fg-2 font-medium flex items-center gap-1.5 mb-2"><Sparkles size={13} className="text-accent" /> {t('players.xp')}</p>
                <p className="text-[20px] font-semibold text-fg tabular-nums">{vitals.xpLevel}</p>
                <div className="h-1.5 mt-2 rounded-full bg-tint/[0.08] overflow-hidden"><div className="h-full rounded-full bg-accent" style={{ width: `${(vitals.xpProgress || 0) * 100}%` }} /></div>
              </div>
              <div className="card !p-4">
                <p className="text-[12px] text-fg-2 font-medium flex items-center gap-1.5 mb-2"><Gamepad2 size={13} /> {t('players.gamemode')}</p>
                <p className="text-[16px] font-semibold text-fg">{t(`players.gm.${GAMEMODES[vitals.gameMode] || 'survival'}`)}</p>
              </div>
              <button className="card !p-4 text-left hover:bg-tint/[0.06] transition-colors col-span-2 md:col-span-1" onClick={() => tp && copy(tp, t)} title={tp ? t('players.copyTp') : undefined}>
                <p className="text-[12px] text-fg-2 font-medium flex items-center gap-1.5 mb-2"><MapPin size={13} className="text-info" /> {t('players.position')} <Copy size={10} className="ml-auto text-fg-3" /></p>
                <p className="text-[13px] font-mono font-semibold text-fg tabular-nums truncate">{vitals.pos ? vitals.pos.map(v => Math.round(v)).join('  ') : '—'}</p>
                <p className="text-[11px] text-fg-3 mt-1 truncate">{dimName}</p>
              </button>
              <div className="card !p-4 col-span-2 md:col-span-1">
                <p className="text-[12px] text-fg-2 font-medium flex items-center gap-1.5 mb-2"><Skull size={13} className="text-danger" /> {t('players.lastDeath')}</p>
                <p className="text-[13px] font-mono font-semibold text-fg tabular-nums truncate">{vitals.lastDeath ? vitals.lastDeath.pos.join('  ') : '—'}</p>
                {vitals.lastDeath && <p className="text-[11px] text-fg-3 mt-1 truncate">{DIMENSIONS[vitals.lastDeath.dimension] ? t(`players.dim.${DIMENSIONS[vitals.lastDeath.dimension]}`) : vitals.lastDeath.dimension}</p>}
              </div>
            </div>
          )}
          {vitals?.fileMtime && (
            <p className="text-[11px] text-fg-3 px-1 -mt-1">{t('players.dataUpdated', { ago: formatDistanceToNow(new Date(vitals.fileMtime), { addSuffix: true, locale }) })}</p>
          )}
          {!vitals && !stats && (
            <div className="card !py-3 text-[12px] text-fg-3">{t('players.noWorldData')}</div>
          )}

          {/* Chiffres clés */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 stagger">
            <Kpi icon={Clock} tone="var(--purple)" label={t('players.playtime')}
              value={formatDuration(stats?.playTimeSeconds || sess?.total || 0, { short: true })}
              sub={stats ? t('players.playtimeCraftarr', { d: formatDuration(sess?.total || 0) }) : null} />
            <Kpi icon={Activity} tone="var(--orange)" label={t('players.kpiSessions')} value={formatNumber(sess?.count || 0)}
              sub={sess?.count ? t('players.kpiAvg', { d: formatDuration(sess.total / sess.count) }) : null} />
            <Kpi icon={Timer} tone="var(--info)" label={t('players.longest')} value={formatDuration(sess?.longest || 0)} />
            <Kpi icon={Skull} tone="var(--danger)" label={t('players.deaths')} value={formatNumber(stats?.deaths ?? data?.eventCounts?.death ?? 0)} />
            <Kpi icon={Swords} tone="var(--danger)" label={t('players.mobKills')} value={formatNumber(stats?.mobKills ?? 0)} />
            <Kpi icon={Footprints} tone="var(--info)" label={t('players.distance')} value={formatDistance(stats?.distanceMeters ?? null)} />
            <Kpi icon={Pickaxe} tone="var(--orange)" label={t('players.blocksMined')} value={formatNumber(stats?.blocksMined ?? 0)}
              sub={stats?.itemsCrafted ? t('players.craftedSub', { n: formatNumber(stats.itemsCrafted) }) : null} />
            <Kpi icon={Award} tone="var(--warn)" label={t('players.advancements')} value={formatNumber(world.advancements?.doneCount ?? data?.eventCounts?.advancement ?? 0)}
              sub={world.advancements?.inProgress ? t('players.advInProgress', { n: world.advancements.inProgress }) : null} />
          </div>

          {/* Habitudes */}
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">
            <SectionCard title={t('players.last30')} className="lg:col-span-3">
              <ResponsiveContainer width="100%" height={150}>
                <BarChart data={daily.map(d => ({ label: d.day.toLocaleDateString(lang, { day: 'numeric', month: 'short' }), h: +(d.seconds / 3600).toFixed(2) }))} margin={{ top: 4, right: 0, left: -22, bottom: 0 }}>
                  <XAxis dataKey="label" tick={{ fontSize: 9.5, fill: 'rgba(235,235,245,0.35)' }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={16} />
                  <YAxis tick={{ fontSize: 9.5, fill: 'rgba(235,235,245,0.35)' }} axisLine={false} tickLine={false} width={40} />
                  <Tooltip cursor={{ fill: 'rgba(var(--tint-rgb),0.05)' }} content={({ active, payload }) => active && payload?.length ? (
                    <div className="glass-strong rounded-xl px-3 py-2 text-[11px]"><p className="text-fg font-semibold">{payload[0].payload.label}</p><p className="text-fg-2">{formatDuration(payload[0].payload.h * 3600)}</p></div>
                  ) : null} />
                  <Bar dataKey="h" fill="var(--purple)" radius={[5, 5, 2, 2]} maxBarSize={18} />
                </BarChart>
              </ResponsiveContainer>
            </SectionCard>
            <SectionCard title={t('players.usualHours')} className="lg:col-span-2">
              <div className="flex items-end gap-[3px] h-[118px]">
                {hours.map((v, h) => (
                  <div key={h} className="flex-1 rounded-t-[4px] min-h-[2px]" title={`${h}h — ${formatDuration(v)}`}
                    style={{ height: `${(v / Math.max(1, ...hours)) * 100}%`, background: 'var(--accent)', opacity: v ? 0.35 + 0.65 * (v / Math.max(1, ...hours)) : 0.12 }} />
                ))}
              </div>
              <div className="flex gap-[3px] mt-1">
                {hours.map((_, h) => <span key={h} className="flex-1 text-center text-[9px] text-fg-3">{h % 6 === 0 ? `${h}h` : ''}</span>)}
              </div>
            </SectionCard>
          </div>

          {/* Détails */}
          <div className="pt-1">
            <Segmented value={tab} onChange={setTab} items={[
              { id: 'journal', label: t('players.tabJournal'), icon: MessageSquare },
              { id: 'sessions', label: t('players.kpiSessions'), icon: Clock },
              ...(vitals ? [{ id: 'inventory', label: t('players.inventory'), icon: Hammer }] : []),
              ...(stats ? [{ id: 'stats', label: t('players.tabStats'), icon: Activity }] : []),
              ...(world.advancements ? [{ id: 'advancements', label: t('players.advancements'), icon: Award }] : []),
            ]} />
          </div>
          <div key={tab} className="tab-in">
            {tab === 'journal' && <Journal server={server} username={username} t={t} lang={lang} />}
            {tab === 'sessions' && <SessionsTab list={sess?.list || []} t={t} lang={lang} />}
            {tab === 'inventory' && vitals && <Inventory player={vitals} t={t} />}
            {tab === 'stats' && stats && <StatsTab stats={stats} t={t} />}
            {tab === 'advancements' && <AdvancementsTab adv={world.advancements} lang={lang} t={t} />}
          </div>
        </>
      )}
    </div>
  );
}
