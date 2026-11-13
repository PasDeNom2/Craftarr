import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceToNow } from 'date-fns';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import {
  Stethoscope, Activity, Cpu, Download, ExternalLink, Copy, RotateCcw,
  FileText, FileWarning, Share2, AlertTriangle, CheckCircle2, RefreshCw, Loader2, Info,
} from 'lucide-react';
import {
  getDiagnostics, getDiagnosticFile, installSpark, runSparkProfile, shareDiagnosticFile,
} from '../../../services/features/diagnostics';
import { restartServer } from '../../../services/api';
import { getSocket } from '../../../hooks/useSocket';
import { useI18n } from '../../../i18n';
import { useDateLocale } from '../../../utils/dateLocale';
import Segmented from '../../ui/Segmented';
import ConfirmDialog from '../../ui/ConfirmDialog';

export const tab = {
  id: 'diagnostics',
  Icon: Stethoscope,
  labelKey: 'diagnostics.tab',
  order: 55,
};

function formatSize(bytes) {
  if (!bytes) return '0 o';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
  return `${bytes} o`;
}

const errMsg = (err, fallback) => err?.response?.data?.error || err?.message || fallback;

export default function DiagnosticsTab({ server }) {
  const { t } = useI18n();
  const locale = useDateLocale();
  const qc = useQueryClient();

  const [filter, setFilter] = useState('all');
  const [selectedName, setSelectedName] = useState(null);
  const [needsRestart, setNeedsRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [sparkState, setSparkState] = useState(null);
  const [shareTarget, setShareTarget] = useState(null);
  const [shareResult, setShareResult] = useState(null);

  const diagQuery = useQuery({
    queryKey: ['diagnostics', server.id],
    queryFn: () => getDiagnostics(server.id),
    staleTime: 10_000,
  });

  const fileQuery = useQuery({
    queryKey: ['diagnostics-file', server.id, selectedName],
    queryFn: () => getDiagnosticFile(server.id, selectedName),
    enabled: !!selectedName,
  });

  // Réinitialise l'état local si l'utilisateur change de serveur
  useEffect(() => {
    setSelectedName(null);
    setShareTarget(null);
    setShareResult(null);
    setNeedsRestart(false);
    setSparkState(null);
  }, [server.id]);

  // Synchronise l'état spark initial depuis GET et les mises à jour temps réel Socket.IO
  useEffect(() => {
    if (diagQuery.data?.spark?.state) {
      setSparkState(diagQuery.data.spark.state);
    }
  }, [diagQuery.data?.spark?.state]);

  useEffect(() => {
    const socket = getSocket();
    const subscribe = () => socket.emit('logs:subscribe', { serverId: server.id });
    if (socket.connected) subscribe();
    socket.on('connect', subscribe);

    const onSpark = (payload) => {
      if (payload?.serverId !== server.id) return;
      setSparkState(payload);
    };
    socket.on('diagnostics:spark', onSpark);

    return () => {
      socket.off('connect', subscribe);
      socket.off('diagnostics:spark', onSpark);
    };
  }, [server.id]);

  const installMut = useMutation({
    mutationFn: () => installSpark(server.id),
    onSuccess: (res) => {
      if (res.installed) {
        toast.success(t('diagnostics.sparkInstallSuccess', { file: res.file }));
        setNeedsRestart(true);
      } else {
        toast(t('diagnostics.sparkInstallAlready'));
      }
      qc.invalidateQueries({ queryKey: ['diagnostics', server.id] });
    },
    onError: (err) => toast.error(errMsg(err, t('common.error'))),
  });

  const profileMut = useMutation({
    mutationFn: (kind) => runSparkProfile(server.id, kind),
    onMutate: (kind) => {
      setSparkState({ status: 'running', kind, startedAt: Date.now(), url: null, error: null });
    },
    onSuccess: (res) => {
      setSparkState(res.state || { status: 'done', kind: res.kind, url: res.url, error: null });
      toast.success(t('diagnostics.sparkDone'));
    },
    onError: (err) => {
      const msg = errMsg(err, t('common.error'));
      setSparkState(prev => ({ ...(prev || {}), status: 'error', url: null, error: msg }));
      toast.error(msg);
    },
  });

  const shareMut = useMutation({
    mutationFn: (name) => shareDiagnosticFile(server.id, name),
    onSuccess: (res) => {
      setShareTarget(null);
      setShareResult(res);
      toast.success(t('diagnostics.shareSuccess'));
    },
    onError: (err) => toast.error(errMsg(err, t('common.error'))),
  });

  async function handleRestart() {
    setRestarting(true);
    try {
      await restartServer(server.id);
      setNeedsRestart(false);
      toast.success(t('server.restarted'));
      qc.invalidateQueries({ queryKey: ['server', server.id] });
    } catch (err) {
      toast.error(errMsg(err, t('common.error')));
    } finally {
      setRestarting(false);
    }
  }

  async function copyText(text, successKey) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t(successKey));
    } catch {
      toast(text);
    }
  }

  const spark = diagQuery.data?.spark;
  const crashReports = useMemo(() => diagQuery.data?.crashReports || [], [diagQuery.data]);
  const logs = useMemo(() => diagQuery.data?.logs || [], [diagQuery.data]);

  const visibleFiles = useMemo(() => {
    if (filter === 'crash') return crashReports;
    if (filter === 'log') return logs;
    return [...crashReports, ...logs];
  }, [filter, crashReports, logs]);

  const isRunning = server.status === 'running';
  const isBusy = ['installing', 'updating'].includes(server.status);
  const sparkProfiling = sparkState?.status === 'running' || profileMut.isPending;

  const problems = shareResult?.insights?.analysis?.problems || shareResult?.insights?.problems || [];
  const infoItems = shareResult?.insights?.analysis?.information || shareResult?.insights?.information || [];

  return (
    <div className="space-y-6">
      {/* ── Section spark ── */}
      <section className="card space-y-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h3 className="text-sm font-semibold text-fg flex items-center gap-2">
                <Activity size={16} strokeWidth={1.75} className="text-fg-2" />
                {t('diagnostics.sparkTitle')}
              </h3>
              {spark && (
                <span
                  className="badge border"
                  style={spark.installed
                    ? { borderColor: 'rgba(var(--success-rgb),0.35)', background: 'rgba(var(--success-rgb),0.1)', color: 'var(--success)' }
                    : { borderColor: 'var(--line-strong)', background: 'var(--surface-2)', color: 'var(--fg-2)' }}
                >
                  {spark.builtin
                    ? t('diagnostics.sparkBuiltin')
                    : spark.installed
                      ? t('diagnostics.sparkInstalled', { file: spark.file })
                      : t('diagnostics.sparkNotInstalled')}
                </span>
              )}
            </div>
            <p className="text-xs text-fg-2">{t('diagnostics.sparkSubtitle')}</p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {spark && !spark.installed && spark.canInstall && (
              <button
                type="button"
                className="btn-primary"
                onClick={() => installMut.mutate()}
                disabled={installMut.isPending || isBusy}
              >
                {installMut.isPending ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} strokeWidth={1.75} />}
                {installMut.isPending ? t('diagnostics.sparkInstalling') : t('diagnostics.sparkInstall')}
              </button>
            )}
            {spark?.installed && (
              <>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => profileMut.mutate('profiler')}
                  disabled={!isRunning || sparkProfiling}
                >
                  {sparkProfiling && sparkState?.kind === 'profiler'
                    ? <Loader2 size={14} className="animate-spin" />
                    : <Activity size={14} strokeWidth={1.75} />}
                  {sparkProfiling && sparkState?.kind === 'profiler'
                    ? t('diagnostics.sparkProfiling')
                    : t('diagnostics.sparkProfile60')}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => profileMut.mutate('heap')}
                  disabled={!isRunning || sparkProfiling}
                >
                  {sparkProfiling && sparkState?.kind === 'heap'
                    ? <Loader2 size={14} className="animate-spin" />
                    : <Cpu size={14} strokeWidth={1.75} />}
                  {sparkProfiling && sparkState?.kind === 'heap'
                    ? t('diagnostics.sparkHeapRunning')
                    : t('diagnostics.sparkHeap')}
                </button>
              </>
            )}
          </div>
        </div>

        {spark && !spark.installed && !spark.canInstall && spark.reason && (
          <p className="text-xs text-fg-2">{spark.reason}</p>
        )}

        {spark?.installed && !isRunning && (
          <p className="text-xs text-fg-3">{t('diagnostics.sparkStartServerHint')}</p>
        )}

        {needsRestart && ['running', 'starting'].includes(server.status) && (
          <div className="rounded-xl border border-warn/30 bg-warn/[0.06] px-4 py-3 flex items-center gap-3 flex-wrap fade-in">
            <RotateCcw size={15} className="text-warn shrink-0" />
            <p className="text-[13px] text-fg flex-1 min-w-[200px]">{t('diagnostics.sparkRestartRequired')}</p>
            <button
              type="button"
              className="btn-primary !h-8"
              onClick={handleRestart}
              disabled={restarting}
            >
              {restarting ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
              {t('server.actions.restart')}
            </button>
          </div>
        )}

        {sparkState?.status === 'done' && sparkState.url && (
          <div
            className="rounded-xl border px-4 py-3 flex items-center gap-3 flex-wrap fade-in"
            style={{ borderColor: 'rgba(var(--success-rgb),0.3)', background: 'rgba(var(--success-rgb),0.06)' }}
          >
            <CheckCircle2 size={16} style={{ color: 'var(--success)' }} className="shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-xs text-fg-2">{t('diagnostics.sparkResultLabel')}</p>
              <a
                href={sparkState.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-mono text-fg underline underline-offset-2 break-all"
              >
                {sparkState.url}
              </a>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                className="btn-secondary !h-8"
                onClick={() => copyText(sparkState.url, 'diagnostics.sparkUrlCopied')}
              >
                <Copy size={13} /> {t('diagnostics.sparkCopyUrl')}
              </button>
              <a
                href={sparkState.url}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-primary !h-8"
              >
                <ExternalLink size={13} /> {t('diagnostics.sparkOpenReport')}
              </a>
            </div>
          </div>
        )}

        {sparkState?.status === 'error' && sparkState.error && (
          <div
            className="rounded-xl border px-4 py-3 flex items-center gap-3 fade-in"
            style={{ borderColor: 'rgba(var(--danger-rgb),0.35)', background: 'rgba(var(--danger-rgb),0.08)' }}
          >
            <AlertTriangle size={16} style={{ color: 'var(--danger)' }} className="shrink-0" />
            <p className="text-[13px] text-fg">{sparkState.error}</p>
          </div>
        )}
      </section>

      {/* ── Résultat partage mclo.gs ── */}
      {shareResult && (
        <section className="card space-y-4 fade-in">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="space-y-1 min-w-0">
              <h3 className="text-sm font-semibold text-fg flex items-center gap-2">
                <Share2 size={15} strokeWidth={1.75} className="text-fg-2 shrink-0" />
                <span className="truncate">{t('diagnostics.shareResultTitle', { name: shareResult.name })}</span>
              </h3>
              <a
                href={shareResult.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-mono text-fg underline underline-offset-2 break-all inline-block"
              >
                {shareResult.url}
              </a>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                className="btn-secondary !h-8"
                onClick={() => copyText(shareResult.url, 'diagnostics.sparkUrlCopied')}
              >
                <Copy size={13} /> {t('diagnostics.sparkCopyUrl')}
              </button>
              <a
                href={shareResult.url}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-primary !h-8"
              >
                <ExternalLink size={13} /> {t('diagnostics.sparkOpenReport')}
              </a>
            </div>
          </div>

          {shareResult.truncated && (
            <p className="text-xs text-warn">{t('diagnostics.shareTruncated')}</p>
          )}

          {shareResult.insights && (
            <div className="space-y-3 pt-2 border-t border-line">
              <p className="eyebrow">{t('diagnostics.insightsTitle')}</p>

              {infoItems.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {infoItems.map((item, idx) => (
                    <span key={idx} className="badge border border-line-strong bg-surface-2 text-fg-2 gap-1.5">
                      <Info size={11} />
                      <span>{item.label ? `${item.label}: ${item.value}` : item.message}</span>
                    </span>
                  ))}
                </div>
              )}

              {problems.length === 0 ? (
                <p className="text-xs text-fg-2">{t('diagnostics.insightsNoProblems')}</p>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-fg">
                    {t('diagnostics.insightsProblems', { count: problems.length })}
                  </p>
                  <ul className="space-y-2">
                    {problems.map((prob, idx) => (
                      <li key={idx} className="rounded-lg border border-warn/30 bg-warn/[0.06] p-3 space-y-1.5">
                        <p className="text-[13px] font-medium text-fg flex items-start gap-2">
                          <AlertTriangle size={14} className="text-warn shrink-0 mt-0.5" />
                          <span>{prob.message}</span>
                        </p>
                        {prob.solutions?.length > 0 && (
                          <div className="pl-5 space-y-1">
                            <p className="text-[11.5px] font-medium text-fg-2">{t('diagnostics.insightsSolutions')}</p>
                            <ul className="list-disc pl-4 space-y-0.5 text-xs text-fg-2">
                              {prob.solutions.map((sol, sIdx) => (
                                <li key={sIdx}>{sol.message}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* ── Section Rapports de crash et journaux ── */}
      <section className="card space-y-4">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold text-fg">{t('diagnostics.filesTitle')}</h3>
            <p className="text-xs text-fg-2 mt-1">{t('diagnostics.filesSubtitle')}</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Segmented
              size="sm"
              value={filter}
              onChange={setFilter}
              items={[
                { id: 'all', label: t('diagnostics.filterAll', { count: crashReports.length + logs.length }) },
                { id: 'crash', label: t('diagnostics.filterCrashes', { count: crashReports.length }) },
                { id: 'log', label: t('diagnostics.filterLogs', { count: logs.length }) },
              ]}
            />
            <button
              type="button"
              className="btn-secondary !h-8"
              onClick={() => diagQuery.refetch()}
              disabled={diagQuery.isFetching}
              aria-label={t('diagnostics.refresh')}
              title={t('diagnostics.refresh')}
            >
              <RefreshCw size={13} className={clsx(diagQuery.isFetching && 'animate-spin')} />
            </button>
          </div>
        </div>

        {diagQuery.isLoading ? (
          <div className="space-y-2">{[0, 1, 2].map(i => <div key={i} className="skeleton h-12" />)}</div>
        ) : diagQuery.isError ? (
          <div className="py-8 text-center space-y-3">
            <p className="text-sm text-danger">{t('diagnostics.loadError')}</p>
            <button type="button" className="btn-secondary" onClick={() => diagQuery.refetch()}>{t('catalog.retry')}</button>
          </div>
        ) : visibleFiles.length === 0 ? (
          <div className="py-10 text-center space-y-2">
            <FileText size={20} strokeWidth={1.5} className="text-fg-3 mx-auto" />
            <p className="text-sm text-fg-2">{t('diagnostics.emptyFiles')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-[340px_minmax(0,1fr)] gap-4 items-start">
            {/* Liste des fichiers */}
            <div className="border border-line rounded-xl overflow-hidden divide-y divide-line max-h-[540px] overflow-y-auto">
              {visibleFiles.map((f) => {
                const active = selectedName === f.name;
                const d = f.mtime ? new Date(f.mtime) : null;
                return (
                  <div
                    key={f.name}
                    className={clsx(
                      'flex items-center gap-2.5 px-3 py-2.5 row-hover',
                      active && 'bg-surface-2'
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedName(f.name)}
                      className="flex-1 min-w-0 text-left flex items-start gap-2.5"
                    >
                      {f.kind === 'crash'
                        ? <FileWarning size={15} className="text-danger shrink-0 mt-0.5" />
                        : <FileText size={15} className="text-fg-3 shrink-0 mt-0.5" />}
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium text-fg truncate" title={f.filename}>{f.filename}</p>
                        <div className="flex items-center gap-1.5 text-[11.5px] text-fg-3 flex-wrap mt-0.5">
                          <span className="font-mono">{formatSize(f.size)}</span>
                          {d && (
                            <>
                              <span>·</span>
                              <span title={format(d, 'dd/MM/yyyy HH:mm:ss')}>
                                {formatDistanceToNow(d, { addSuffix: true, locale })}
                              </span>
                            </>
                          )}
                          {f.kind === 'crash' && (
                            <span className="px-1.5 rounded border border-danger/30 text-danger text-[10.5px]">
                              {t('diagnostics.badgeCrash')}
                            </span>
                          )}
                          {f.compressed && (
                            <span className="px-1.5 rounded border border-line-strong text-fg-3 text-[10.5px]">
                              {t('diagnostics.badgeGzip')}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                    <button
                      type="button"
                      className="icon-btn shrink-0"
                      title={t('diagnostics.shareOnMclogs')}
                      aria-label={`${t('diagnostics.shareButton')} ${f.filename}`}
                      onClick={() => setShareTarget(f)}
                    >
                      <Share2 size={14} strokeWidth={1.75} />
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Aperçu et résumé */}
            <div className="min-w-0 space-y-3">
              {!selectedName ? (
                <div className="border border-line rounded-xl py-16 px-6 text-center">
                  <p className="text-sm text-fg-3">{t('diagnostics.selectFileHint')}</p>
                </div>
              ) : fileQuery.isLoading ? (
                <div className="skeleton h-72 w-full" />
              ) : fileQuery.isError ? (
                <div className="border border-line rounded-xl py-10 px-6 text-center space-y-3">
                  <p className="text-sm text-danger">{errMsg(fileQuery.error, t('diagnostics.fileLoadError'))}</p>
                </div>
              ) : fileQuery.data && (
                <>
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <p className="text-xs font-mono text-fg-2 truncate">{fileQuery.data.name}</p>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        className="btn-secondary !h-8"
                        onClick={() => copyText(fileQuery.data.content, 'diagnostics.contentCopied')}
                      >
                        <Copy size={13} /> {t('diagnostics.copyContent')}
                      </button>
                      <button
                        type="button"
                        className="btn-primary !h-8"
                        onClick={() => setShareTarget(fileQuery.data)}
                      >
                        <Share2 size={13} /> {t('diagnostics.shareOnMclogs')}
                      </button>
                    </div>
                  </div>

                  {fileQuery.data.summary && (
                    <div className="rounded-xl border border-danger/30 bg-danger/[0.05] p-3.5 space-y-2">
                      <p className="eyebrow">{t('diagnostics.summaryTitle')}</p>
                      {fileQuery.data.summary.description && (
                        <div>
                          <span className="text-xs font-medium text-fg-2">{t('diagnostics.summaryDescription')} : </span>
                          <span className="text-[13px] text-fg">{fileQuery.data.summary.description}</span>
                        </div>
                      )}
                      {fileQuery.data.summary.exception && (
                        <div>
                          <span className="text-xs font-medium text-fg-2">{t('diagnostics.summaryException')} : </span>
                          <code className="text-xs font-mono text-danger break-all">{fileQuery.data.summary.exception}</code>
                        </div>
                      )}
                      {fileQuery.data.summary.mod && (
                        <div>
                          <span className="text-xs font-medium text-fg-2">{t('diagnostics.summaryMod')} : </span>
                          <span className="badge border border-line-strong bg-surface-2 text-fg font-mono">
                            {fileQuery.data.summary.mod}
                          </span>
                        </div>
                      )}
                      {fileQuery.data.summary.atLine && (
                        <div>
                          <span className="text-xs font-medium text-fg-2">{t('diagnostics.summaryFrame')} : </span>
                          <code className="text-xs font-mono text-fg-2 break-all">{fileQuery.data.summary.atLine}</code>
                        </div>
                      )}
                    </div>
                  )}

                  {fileQuery.data.truncated && (
                    <p className="text-xs text-warn">{t('diagnostics.truncatedPreview')}</p>
                  )}

                  <pre className="well rounded-xl p-3.5 text-[12px] font-mono leading-relaxed max-h-[460px] overflow-auto whitespace-pre-wrap break-words">
                    {fileQuery.data.content}
                  </pre>
                </>
              )}
            </div>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={!!shareTarget}
        onClose={() => setShareTarget(null)}
        onConfirm={() => shareMut.mutate(shareTarget.name)}
        busy={shareMut.isPending}
        tone="default"
        title={t('diagnostics.shareConfirmTitle')}
        message={t('diagnostics.shareConfirmMessage', { name: shareTarget?.filename || '' })}
        confirmLabel={t('diagnostics.shareConfirmAction')}
      />
    </div>
  );
}
