import React, { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { useServerSocket } from '../../hooks/useSocket';
import { sendRcon, confirmClientPack, cancelInstall } from '../../services/api';
import { useLogsStore } from '../../store';
import { useI18n } from '../../i18n';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { Terminal, ChevronDown, Trash2, AlertTriangle } from 'lucide-react';

function classifyLine(line) {
  const l = line.toLowerCase();
  if (l.includes('error') || l.includes('exception') || l.includes('fatal')) return 'error';
  if (l.includes('warn')) return 'warn';
  if (l.includes('joined the game') || l.includes('logged in')) return 'join';
  if (l.includes('left the game') || l.includes('lost connection')) return 'leave';
  if (l.includes('[server]') || l.includes('[minecraft]')) return 'server';
  return 'info';
}

export default function Console({ server }) {
  const { t } = useI18n();
  const { logs, appendLog, clearLogs } = useLogsStore();
  const rawLines = logs[server.id] || [];
  const lines = rawLines.filter(line => !line.includes('RCON'));
  const [command, setCommand] = useState('');
  const [commandHistory, setCommandHistory] = useState([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [sending, setSending] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [unread, setUnread] = useState(0);
  const [installProgress, setInstallProgress] = useState(null);
  const [noServerPack, setNoServerPack] = useState(null); // { modpackName }
  const [confirming, setConfirming] = useState(false);
  const containerRef = useRef(null);
  const inputRef = useRef(null);
  const lastScrolledCount = useRef(0);

  const handleLog = useCallback(({ serverId, line }) => {
    if (serverId !== server.id) return;
    appendLog(serverId, line);
  }, [server.id, appendLog]);

  const handleInstallProgress = useCallback(({ serverId, step, message, percent }) => {
    if (serverId !== server.id) return;
    setInstallProgress({ step, message, percent });
  }, [server.id]);

  const handleNoServerPack = useCallback(({ serverId, modpackName }) => {
    if (serverId !== server.id) return;
    setNoServerPack({ modpackName });
  }, [server.id]);

  useServerSocket(server.id, server.container_id, {
    log: handleLog,
    'install:progress': handleInstallProgress,
    'install:no-server-pack': handleNoServerPack,
  });

  useEffect(() => {
    if (server.status !== 'installing') { setInstallProgress(null); setNoServerPack(null); }
  }, [server.status]);

  async function handleConfirmClientPack() {
    setConfirming(true);
    try { await confirmClientPack(server.id); setNoServerPack(null); } catch {}
    setConfirming(false);
  }

  async function handleCancelInstall() {
    try { await cancelInstall(server.id); setNoServerPack(null); } catch {}
  }

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (autoScroll) {
      el.scrollTop = el.scrollHeight;
      lastScrolledCount.current = lines.length;
      setUnread(0);
    } else {
      const newLines = lines.length - lastScrolledCount.current;
      if (newLines > 0) setUnread(newLines);
    }
  }, [lines.length, autoScroll]);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    if (atBottom && !autoScroll) {
      setAutoScroll(true);
      setUnread(0);
      lastScrolledCount.current = lines.length;
    } else if (!atBottom && autoScroll) {
      setAutoScroll(false);
    }
  }

  function scrollToBottom() {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setAutoScroll(true);
    setUnread(0);
    lastScrolledCount.current = lines.length;
  }

  async function handleSend(e) {
    e.preventDefault();
    const cmd = command.trim();
    if (!cmd || sending) return;
    setSending(true);
    try {
      const { response } = await sendRcon(server.id, cmd);
      appendLog(server.id, `> ${cmd}${response ? ` -> ${response}` : ''}`);
      setCommandHistory(h => [cmd, ...h.filter(c => c !== cmd)].slice(0, 50));
      setHistoryIdx(-1);
      setCommand('');
    } catch (err) {
      toast.error(t('console.rconError') + ' : ' + (err.response?.data?.error || err.message));
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const idx = Math.min(historyIdx + 1, commandHistory.length - 1);
      setHistoryIdx(idx);
      setCommand(commandHistory[idx] ?? '');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const idx = Math.max(historyIdx - 1, -1);
      setHistoryIdx(idx);
      setCommand(idx === -1 ? '' : commandHistory[idx] ?? '');
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ background: 'var(--bg)' }}>

      {/* Toolbar */}
      <div
        className="flex items-center justify-between px-4 py-2 flex-shrink-0"
        style={{ background: 'var(--bg-sidebar)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}
      >
        <div className="flex items-center gap-2">
          <Terminal size={13} strokeWidth={1.5} className="text-[#6B6B76]" />
          <span className="text-[11px] font-semibold text-[#6B6B76] font-mono uppercase tracking-widest">Console</span>
          {lines.length > 0 && (
            <span className="text-[10px] text-[#4A4A55] font-mono">{lines.length}</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            className="flex items-center gap-1 text-[11px] text-[#4A4A55] hover:text-[#6B6B76] transition-colors"
            onClick={() => clearLogs(server.id)}
          >
            <Trash2 size={11} strokeWidth={1.5} />
            {t('console.clear')}
          </button>
          <button
            className={clsx(
              'flex items-center gap-1 text-[11px] px-2 py-0.5 rounded transition-colors',
              autoScroll
                ? 'text-[var(--accent)]'
                : 'text-[#4A4A55] hover:text-[#6B6B76]'
            )}
            onClick={scrollToBottom}
          >
            <ChevronDown size={11} strokeWidth={1.5} />
            {t('console.autoScroll')}
            {!autoScroll && unread > 0 && (
              <span
                className="text-[9px] font-bold px-1 rounded-full ml-0.5"
                style={{ background: 'var(--accent)', color: 'var(--bg)' }}
              >
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Install progress bar */}
      {server.status === 'installing' && !noServerPack && (
        <div className="flex-shrink-0 px-4 py-2" style={{ background: 'var(--bg-sidebar)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-mono text-[#6B6B76] truncate max-w-[80%]">
              {installProgress?.message ?? t('console.installing')}
            </span>
            <span className="text-[11px] font-mono ml-2 flex-shrink-0" style={{ color: 'var(--accent)' }}>
              {installProgress?.percent != null ? `${installProgress.percent}%` : '…'}
            </span>
          </div>
          <div className="w-full rounded-full overflow-hidden" style={{ height: 3, background: 'rgba(255,255,255,0.06)' }}>
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${installProgress?.percent ?? 0}%`,
                background: 'var(--accent)',
              }}
            />
          </div>
        </div>
      )}

      {/* No server pack — demande confirmation */}
      {noServerPack && (
        <div
          className="flex-shrink-0 px-4 py-3 flex flex-col gap-2"
          style={{ background: 'rgba(251,191,36,0.06)', borderBottom: '1px solid rgba(251,191,36,0.15)' }}
        >
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} strokeWidth={1.5} className="text-[#FBBF24] mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-[12px] font-semibold text-[#FBBF24]">{t('console.noServerPack')}</p>
              <p className="text-[11px] text-[#6B6B76] mt-0.5">{t('console.noServerPackDesc')}</p>
            </div>
          </div>
          <div className="flex gap-2 mt-1">
            <button
              className="btn-primary text-xs py-1.5 px-3"
              onClick={handleConfirmClientPack}
              disabled={confirming}
            >
              {confirming ? '…' : t('console.useClientPack')}
            </button>
            <button
              className="btn-secondary text-xs py-1.5 px-3"
              onClick={handleCancelInstall}
              disabled={confirming}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Logs */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-3 space-y-px"
        onClick={() => inputRef.current?.focus()}
      >
        {lines.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-[#4A4A55]">
            <Terminal size={20} strokeWidth={1} />
            <span className="text-sm font-mono">{t('console.noLogs')}</span>
          </div>
        ) : (
          lines.map((line, i) => {
            const type = classifyLine(line);
            const colors = {
              error:  '#F87171',
              warn:   '#FBBF24',
              join:   'var(--accent)',
              leave:  '#6B6B76',
              server: '#F0F0F0',
              info:   '#F0F0F0',
            };
            return (
              <div
                key={i}
                className="px-1 break-all font-mono text-[13px] leading-[1.5]"
                style={{
                  color: colors[type],
                  borderBottom: '1px solid rgba(255,255,255,0.03)',
                }}
              >
                {line}
              </div>
            );
          })
        )}
      </div>

      {/* "New lines" badge */}
      {!autoScroll && unread > 0 && (
        <div className="flex justify-center py-1" style={{ background: 'rgba(13,13,16,0.8)', borderTop: '1px solid rgba(255,255,255,0.04)' }}>
          <button
            onClick={scrollToBottom}
            className="flex items-center gap-1 text-xs px-3 py-1 rounded-full transition-colors"
            style={{ color: 'var(--accent)', background: 'rgba(var(--accent-rgb),0.08)', border: '1px solid rgba(var(--accent-rgb),0.2)' }}
          >
            <ChevronDown size={12} strokeWidth={1.5} />
            {t('console.newLines', { count: unread })}
          </button>
        </div>
      )}

      {/* RCON input */}
      <form
        onSubmit={handleSend}
        className="flex gap-2 px-3 py-2 flex-shrink-0"
        style={{ background: 'var(--bg-sidebar)', borderTop: '1px solid rgba(255,255,255,0.04)' }}
      >
        <span className="font-mono text-sm self-center select-none" style={{ color: 'var(--accent)' }}>{'>'}</span>
        <input
          ref={inputRef}
          className="flex-1 bg-transparent border-none outline-none text-sm font-mono text-[#F0F0F0] disabled:opacity-40"
          style={{ caretColor: 'var(--accent)' }}
          placeholder={server.status === 'running' ? t('console.placeholder') : t('console.stoppedPlaceholder')}
          value={command}
          onChange={e => { setCommand(e.target.value); setHistoryIdx(-1); }}
          onKeyDown={handleKeyDown}
          disabled={sending || server.status !== 'running'}
          autoComplete="off"
          spellCheck={false}
        />
        {command.trim() && (
          <button
            type="submit"
            className="text-xs text-[#6B6B76] hover:text-[#F0F0F0] font-mono disabled:opacity-40 transition-colors"
            disabled={sending || server.status !== 'running'}
          >
            {sending ? '...' : t('console.send')}
          </button>
        )}
      </form>
    </div>
  );
}
