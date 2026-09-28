import React, { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import {
  Terminal, ArrowDown, Trash2, AlertTriangle, Search, X, Copy, Download, WrapText, Clock,
  Pause, Play, ChevronRight, LogIn, LogOut, MessageSquare, Minus, Plus,
} from 'lucide-react';
import { useServerSocket } from '../../hooks/useSocket';
import { sendRcon, confirmClientPack, cancelInstall, getPlayers } from '../../services/api';
import { useLogsStore, useMetricsStore } from '../../store';
import { useI18n } from '../../i18n';
import { parseLine, groupEntries } from './console/parseLog';
import McText, { Highlight } from './console/McText';
import CommandInput from './console/CommandInput';
import LivePanel from './console/LivePanel';

// Bruit de fond de l'interrogation RCON de Craftarr (toutes les 15 s)
const NOISE = /Thread RCON (Client|Listener)/;
const PREFS_KEY = 'craftarr_console_prefs';

function loadPrefs() {
  try { return { wrap: true, timestamps: true, fontSize: 13, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; }
  catch { return { wrap: true, timestamps: true, fontSize: 13 }; }
}

const FILTERS = [
  { id: 'all', match: () => true },
  { id: 'warn', match: e => e.level === 'WARN' || e.level === 'ERROR' || e.kind === 'craftarr' },
  { id: 'error', match: e => e.level === 'ERROR' },
  { id: 'players', match: e => ['join', 'leave', 'chat'].includes(e.kind) },
  { id: 'commands', match: e => e.kind === 'command' },
];

const LEVEL_TONE = { WARN: 'var(--warn)', ERROR: 'var(--danger)' };

// ─── Une entrée de log ────────────────────────────────────────────────────────
function LogEntry({ entry, search, showTime, wrap }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const tone = LEVEL_TONE[entry.level];

  if (entry.kind === 'craftarr') {
    return (
      <div className="my-1 mx-1 flex gap-2 items-start rounded-md px-2.5 py-1.5 border" style={{ borderColor: 'rgba(var(--warn-rgb),0.3)', background: 'rgba(var(--warn-rgb),0.06)', color: 'var(--warn)' }}>
        <AlertTriangle size={13} className="shrink-0 mt-0.5" />
        <span className="font-sans text-[12.5px]"><Highlight text={entry.message} term={search} /></span>
      </div>
    );
  }

  if (entry.kind === 'command') {
    return (
      <div className="py-1 px-1 border-b border-white/[0.03]">
        <div className="flex gap-2 text-fg">
          <span className="text-fg-3 select-none">{'>'}</span>
          <span className="font-semibold"><Highlight text={entry.command} term={search} /></span>
        </div>
        {entry.message && (
          <div className={clsx('ml-4 mt-0.5 pl-2 border-l border-line text-fg-2', wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre')}>
            <McText text={entry.message} highlight={search} />
          </div>
        )}
      </div>
    );
  }

  const icon = entry.kind === 'join' ? LogIn : entry.kind === 'leave' ? LogOut : entry.kind === 'chat' ? MessageSquare : null;
  const color = tone || (entry.kind === 'join' ? 'var(--accent)' : entry.kind === 'leave' ? 'var(--fg-2)' : entry.level === 'DEBUG' ? 'var(--fg-3)' : 'var(--fg)');
  const Icon = icon;

  return (
    <div
      className="group relative px-1 py-[1px] border-b border-white/[0.03] hover:bg-white/[0.025]"
      style={tone ? { boxShadow: `inset 2px 0 0 ${tone}` } : undefined}
    >
      <div className={clsx('flex gap-2', wrap ? '' : 'whitespace-pre')}>
        {showTime && entry.time && <span className="text-fg-3 shrink-0 select-none tabular-nums">{entry.time}</span>}
        {tone && (
          <span className="shrink-0 text-[10px] font-semibold tracking-wide px-1 rounded self-start mt-[2px] leading-[15px]" style={{ color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)` }}>
            {entry.level}
          </span>
        )}
        {entry.logger && <span className="text-fg-3 shrink-0 hidden lg:inline">{entry.logger}</span>}
        <span className={clsx('min-w-0', wrap ? 'whitespace-pre-wrap break-words' : '')} style={{ color }}>
          {Icon && <Icon size={11} className="inline -mt-0.5 mr-1.5 opacity-80" />}
          {entry.kind === 'chat' ? (
            <>
              <span className="font-semibold text-fg">&lt;<Highlight text={entry.player} term={search} />&gt;</span>{' '}
              <span className="text-fg"><Highlight text={entry.chat} term={search} /></span>
            </>
          ) : (
            <McText text={entry.message} highlight={search} />
          )}
        </span>
      </div>
      {entry.trace && (
        <div className="ml-5">
          <button
            onClick={() => setOpen(o => !o)}
            className="flex items-center gap-1 text-[11px] text-fg-3 hover:text-fg-2 py-0.5"
          >
            <ChevronRight size={11} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }} />
            {t('console.stackTrace', { count: entry.trace.length })}
          </button>
          {open && (
            <pre className="text-[11.5px] text-fg-3 pl-3 border-l border-line whitespace-pre-wrap break-all fade-in">
              {entry.trace.join('\n')}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Console ──────────────────────────────────────────────────────────────────
export default function Console({ server }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { logs, appendLog, clearLogs } = useLogsStore();
  const updateMetrics = useMetricsStore(s => s.updateMetrics);
  const [prefs, setPrefs] = useState(loadPrefs);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [following, setFollowing] = useState(true);
  const [unread, setUnread] = useState(0);
  const [sending, setSending] = useState(false);
  const [installProgress, setInstallProgress] = useState(null);
  const [noServerPack, setNoServerPack] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [insert, setInsert] = useState(null);
  const containerRef = useRef(null);
  const inputRef = useRef(null);
  const lastCount = useRef(0);
  const playersRefresh = useRef(null);

  const running = server.status === 'running';

  function setPref(key, value) {
    setPrefs(p => {
      const next = { ...p, [key]: value };
      try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }

  // Joueurs connectés (rafraîchis aussi dès qu'un join/leave passe dans les logs)
  const { data: players = [] } = useQuery({
    queryKey: ['players', server.id],
    queryFn: () => getPlayers(server.id),
    refetchInterval: running ? 30000 : false,
    enabled: !!server.id,
  });
  const onlinePlayers = players.filter(p => p.is_online);

  const handleLog = useCallback(({ serverId, line }) => {
    if (serverId !== server.id) return;
    appendLog(serverId, line);
    if (/joined the game|left the game/.test(line)) {
      clearTimeout(playersRefresh.current);
      playersRefresh.current = setTimeout(() => qc.invalidateQueries({ queryKey: ['players', server.id] }), 800);
    }
  }, [server.id, appendLog, qc]);

  const handleMetrics = useCallback((data) => {
    if (data.serverId === server.id) updateMetrics(server.id, data);
  }, [server.id, updateMetrics]);

  useServerSocket(server.id, server.container_id, {
    log: handleLog,
    metrics: handleMetrics,
    'install:progress': ({ serverId, step, message, percent }) => { if (serverId === server.id) setInstallProgress({ step, message, percent }); },
    'install:no-server-pack': ({ serverId, modpackName }) => { if (serverId === server.id) setNoServerPack({ modpackName }); },
  });

  useEffect(() => () => clearTimeout(playersRefresh.current), []);
  useEffect(() => {
    if (server.status !== 'installing') { setInstallProgress(null); setNoServerPack(null); }
  }, [server.status]);

  // ── Préparation des entrées : bruit retiré, stacktraces regroupées, filtre + recherche
  const rawLines = logs[server.id] || [];
  const entries = useMemo(
    () => groupEntries(rawLines.filter(l => !NOISE.test(l)).map(parseLine)),
    [rawLines],
  );
  const counts = useMemo(() => Object.fromEntries(FILTERS.map(f => [f.id, entries.filter(f.match).length])), [entries]);
  const visible = useMemo(() => {
    const f = FILTERS.find(x => x.id === filter) || FILTERS[0];
    const q = search.trim().toLowerCase();
    return entries.filter(e => f.match(e) && (!q || e.raw.toLowerCase().includes(q) || e.trace?.some(l => l.toLowerCase().includes(q))));
  }, [entries, filter, search]);

  // ── Défilement : suit le bas tant qu'on n'est pas remonté
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (following) {
      el.scrollTop = el.scrollHeight;
      lastCount.current = visible.length;
      setUnread(0);
    } else if (visible.length > lastCount.current) {
      setUnread(visible.length - lastCount.current);
    }
  }, [visible.length, following]);

  function onScroll() {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 12;
    if (atBottom !== following) setFollowing(atBottom);
    if (atBottom) { setUnread(0); lastCount.current = visible.length; }
  }

  function jumpToBottom() {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setFollowing(true);
    setUnread(0);
    lastCount.current = visible.length;
  }

  // ── Commandes
  const runCommand = useCallback(async (cmd) => {
    if (/^stop(\s|$)/i.test(cmd)) {
      toast(t('console.useStopButton'), { icon: '⏹' });
      return false;
    }
    setSending(true);
    try {
      const { response } = await sendRcon(server.id, cmd);
      appendLog(server.id, `> ${cmd}${response ? ` -> ${response.trim()}` : ''}`);
      setFollowing(true);
      return true;
    } catch (err) {
      toast.error(`${t('console.rconError')} : ${err.response?.data?.error || err.message}`);
      return false;
    } finally {
      setSending(false);
    }
  }, [server.id, appendLog, t]);

  // ── Outils
  async function copyVisible() {
    const text = visible.map(e => [e.raw, ...(e.trace || [])].join('\n')).join('\n');
    try { await navigator.clipboard.writeText(text); toast.success(t('console.copied', { count: visible.length })); }
    catch { toast.error(t('common.error')); }
  }

  function download() {
    const text = rawLines.join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${server.name.replace(/[^a-z0-9_-]/gi, '_')}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const ToolButton = ({ active, onClick, title, children }) => (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={clsx('h-7 min-w-7 px-1.5 rounded-md flex items-center justify-center gap-1 text-[11px] transition-colors',
        active ? 'bg-surface-2 text-fg' : 'text-fg-3 hover:text-fg hover:bg-surface-2')}
    >
      {children}
    </button>
  );

  return (
    <div className="flex h-full overflow-hidden bg-bg">
      <div className="flex-1 flex flex-col min-w-0">
        {/* ── Barre d'outils ── */}
        <div className="flex items-center gap-3 px-3 h-11 shrink-0 border-b border-line bg-bg-2">
          <div className="flex items-center gap-0.5 p-0.5 rounded-lg border border-line" role="tablist">
            {FILTERS.map(f => (
              <button
                key={f.id}
                role="tab"
                aria-selected={filter === f.id}
                onClick={() => setFilter(f.id)}
                className={clsx('h-6 px-2.5 rounded-md text-[11px] font-medium flex items-center gap-1.5 transition-colors',
                  filter === f.id ? 'bg-fg text-black' : 'text-fg-2 hover:text-fg')}
              >
                {t(`console.filter.${f.id}`)}
                {f.id !== 'all' && counts[f.id] > 0 && (
                  <span className={clsx('font-mono text-[10px]', filter === f.id ? 'text-black/60' : 'text-fg-3')}
                    style={filter !== f.id && f.id === 'error' ? { color: 'var(--danger)' } : filter !== f.id && f.id === 'warn' ? { color: 'var(--warn)' } : undefined}>
                    {counts[f.id]}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="relative flex-1 max-w-xs">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3 pointer-events-none" />
            <input
              className="w-full h-7 pl-7 pr-14 rounded-md bg-bg border border-line text-xs text-fg placeholder:text-fg-3 outline-none focus:border-line-strong"
              placeholder={t('console.search')}
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') setSearch(''); }}
            />
            {search && (
              <span className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 text-[10px] text-fg-3 font-mono">
                {visible.length}
                <button onClick={() => setSearch('')} className="hover:text-fg" aria-label="×"><X size={11} /></button>
              </span>
            )}
          </div>

          <div className="ml-auto flex items-center gap-0.5">
            <ToolButton active={prefs.timestamps} onClick={() => setPref('timestamps', !prefs.timestamps)} title={t('console.timestamps')}><Clock size={13} /></ToolButton>
            <ToolButton active={prefs.wrap} onClick={() => setPref('wrap', !prefs.wrap)} title={t('console.wrap')}><WrapText size={13} /></ToolButton>
            <ToolButton onClick={() => setPref('fontSize', Math.max(11, prefs.fontSize - 1))} title={t('console.smaller')}><Minus size={12} /></ToolButton>
            <span className="text-[10px] font-mono text-fg-3 w-5 text-center">{prefs.fontSize}</span>
            <ToolButton onClick={() => setPref('fontSize', Math.min(17, prefs.fontSize + 1))} title={t('console.bigger')}><Plus size={12} /></ToolButton>
            <span className="w-px h-4 bg-line mx-1" />
            <ToolButton onClick={copyVisible} title={t('console.copy')}><Copy size={13} /></ToolButton>
            <ToolButton onClick={download} title={t('console.download')}><Download size={13} /></ToolButton>
            <ToolButton onClick={() => clearLogs(server.id)} title={t('console.clear')}><Trash2 size={13} /></ToolButton>
            <span className="w-px h-4 bg-line mx-1" />
            <ToolButton active={following} onClick={() => (following ? setFollowing(false) : jumpToBottom())} title={following ? t('console.pause') : t('console.resume')}>
              {following ? <Pause size={13} /> : <Play size={13} />}
            </ToolButton>
          </div>
        </div>

        {/* ── Installation en cours ── */}
        {server.status === 'installing' && !noServerPack && (
          <div className="shrink-0 px-4 py-2.5 border-b border-line bg-bg-2">
            <div className="flex items-center justify-between mb-1.5 gap-3">
              <span className="text-[11px] font-mono text-fg-2 truncate">{installProgress?.message ?? t('console.installing')}</span>
              <span className="text-[11px] font-mono text-fg-3">{installProgress?.percent ?? 0}%</span>
            </div>
            <div className="w-full rounded-full overflow-hidden h-[3px] bg-surface-2">
              <div className="h-full rounded-full transition-all duration-300 bg-fg" style={{ width: `${installProgress?.percent ?? 0}%` }} />
            </div>
          </div>
        )}

        {/* ── Pas de server pack : confirmation ── */}
        {noServerPack && (
          <div className="shrink-0 px-4 py-3 flex flex-col gap-2 border-b" style={{ background: 'rgba(var(--warn-rgb),0.06)', borderColor: 'rgba(var(--warn-rgb),0.15)' }}>
            <div className="flex items-start gap-2">
              <AlertTriangle size={14} strokeWidth={1.5} className="text-warn mt-0.5 shrink-0" />
              <div>
                <p className="text-[12px] font-semibold text-warn">{t('console.noServerPack')}</p>
                <p className="text-[11px] text-fg-2 mt-0.5">{t('console.noServerPackDesc')}</p>
              </div>
            </div>
            <div className="flex gap-2 mt-1">
              <button className="btn-primary text-xs py-1.5 px-3" disabled={confirming}
                onClick={async () => { setConfirming(true); try { await confirmClientPack(server.id); setNoServerPack(null); } catch {} setConfirming(false); }}>
                {confirming ? '…' : t('console.useClientPack')}
              </button>
              <button className="btn-secondary text-xs py-1.5 px-3" disabled={confirming}
                onClick={async () => { try { await cancelInstall(server.id); setNoServerPack(null); } catch {} }}>
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}

        {/* ── Logs ── */}
        <div className="relative flex-1 min-h-0">
          <div
            ref={containerRef}
            onScroll={onScroll}
            className="absolute inset-0 overflow-auto px-2 py-2 font-mono"
            style={{ fontSize: prefs.fontSize, lineHeight: 1.55 }}
            onMouseUp={() => { if (!window.getSelection()?.toString()) inputRef.current?.focus(); }}
          >
            {visible.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-2 text-fg-3">
                <Terminal size={20} strokeWidth={1} />
                <span className="text-sm">{entries.length === 0 ? t('console.noLogs') : t('console.noMatch')}</span>
              </div>
            ) : (
              visible.map((entry, i) => (
                <LogEntry key={i} entry={entry} search={search.trim()} showTime={prefs.timestamps} wrap={prefs.wrap} />
              ))
            )}
          </div>

          {!following && (
            <button
              onClick={jumpToBottom}
              className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full bg-fg text-black font-medium shadow-lg fade-in"
            >
              <ArrowDown size={12} strokeWidth={2} />
              {unread > 0 ? t('console.newLines', { count: unread > 999 ? '999+' : unread }) : t('console.resume')}
            </button>
          )}
        </div>

        <CommandInput
          serverId={server.id}
          disabled={!running || sending}
          sending={sending}
          onSend={runCommand}
          players={onlinePlayers.map(p => p.username)}
          inputRef={inputRef}
          insert={insert}
        />
      </div>

      <LivePanel
        server={server}
        onlinePlayers={onlinePlayers}
        onRun={runCommand}
        onPickPlayer={name => setInsert({ text: name, key: Date.now() })}
      />
    </div>
  );
}
