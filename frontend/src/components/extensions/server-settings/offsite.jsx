import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceToNow } from 'date-fns';
import { CloudUpload, RotateCcw } from 'lucide-react';
import toast from 'react-hot-toast';
import { patchServer } from '../../../services/api';
import {
  getServerOffsite,
  runServerOffsiteBackup,
  restoreServerOffsiteSnapshot,
} from '../../../services/features/offsite';
import { useI18n } from '../../../i18n';
import { useServerStore } from '../../../store';
import Switch from '../../ui/Switch';
import ConfirmDialog from '../../ui/ConfirmDialog';
import { parseDbDate } from '../../../utils/dates';
import { useDateLocale } from '../../../utils/dateLocale';

export const block = { id: 'offsite', order: 40 };

function formatBytes(bytes) {
  if (!bytes) return '0 Ko';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} Go`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} Mo`;
  return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
}

export default function OffsiteServerBlock({ server }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const locale = useDateLocale();
  const patchStore = useServerStore(s => s.updateServer);
  const [toRestore, setToRestore] = useState(null);

  const qKey = ['server-offsite', server.id];
  const { data, isLoading } = useQuery({
    queryKey: qKey,
    queryFn: () => getServerOffsite(server.id),
    refetchInterval: (query) => {
      const d = query.state.data;
      const busy = d?.active || d?.runs?.some(r => r.status === 'running');
      return busy ? 3000 : 30000;
    },
  });

  const enabled = data?.enabled ?? !!server.offsite_enabled;
  const runs = data?.runs || [];
  const snapshots = data?.snapshots || [];
  const hasRunning = !!(data?.active || runs.some(r => r.status === 'running'));

  const toggleMut = useMutation({
    mutationFn: (next) => patchServer(server.id, { offsite_enabled: next }),
    onSuccess: (updated) => {
      patchStore(server.id, updated);
      qc.invalidateQueries({ queryKey: ['server', server.id] });
      qc.invalidateQueries({ queryKey: qKey });
      toast.success(t('server.settings.saved'));
    },
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  const runMut = useMutation({
    mutationFn: () => runServerOffsiteBackup(server.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qKey });
      toast.success(t('offsite.runQueued'));
    },
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  const restoreMut = useMutation({
    mutationFn: (snapshotId) => restoreServerOffsiteSnapshot(server.id, snapshotId),
    onSuccess: () => {
      setToRestore(null);
      qc.invalidateQueries({ queryKey: ['server', server.id] });
      qc.invalidateQueries({ queryKey: qKey });
      toast.success(t('offsite.restoreSuccess'));
    },
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3 px-1">
        <h3 className="text-[13px] font-semibold text-fg">{t('offsite.serverTitle')}</h3>
        <button
          type="button"
          className="btn-secondary !h-8 !px-3 text-xs"
          disabled={!data?.configured || runMut.isPending || hasRunning}
          onClick={() => runMut.mutate()}
        >
          <CloudUpload size={13} strokeWidth={1.75} />
          {hasRunning || runMut.isPending ? t('offsite.runningNow') : t('offsite.runNow')}
        </button>
      </div>

      <div className="card !p-0 overflow-hidden divide-y divide-line">
        <div className="px-4 py-3 min-h-[52px] flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[13.5px] text-fg">{t('offsite.serverToggle')}</p>
            <p className="text-[12px] text-fg-3 mt-0.5">{t('offsite.serverToggleHint')}</p>
          </div>
          <Switch
            checked={enabled}
            onChange={(next) => toggleMut.mutate(next)}
            disabled={toggleMut.isPending}
            label={t('offsite.serverToggle')}
          />
        </div>

        {!isLoading && data && !data.configured && (
          <div className="px-4 py-2.5 text-[12px] text-fg-3">
            {t('offsite.notConfiguredHint')}
          </div>
        )}

        <div className="px-4 py-3 space-y-2">
          <p className="text-[12px] font-medium text-fg-2">{t('offsite.runsTitle')}</p>
          {isLoading ? (
            <div className="skeleton h-10" />
          ) : runs.length === 0 ? (
            <p className="text-[12px] text-fg-3">{t('offsite.noRuns')}</p>
          ) : (
            <div className="divide-y divide-line rounded-lg border border-line bg-bg/40">
              {runs.slice(0, 5).map((run) => {
                const date = parseDbDate(run.started_at);
                const statusColor = run.status === 'success'
                  ? 'var(--success)'
                  : run.status === 'failed'
                    ? 'var(--danger)'
                    : 'var(--info)';
                const statusLabel = run.status === 'success'
                  ? t('offsite.statusSuccess')
                  : run.status === 'failed'
                    ? t('offsite.statusFailed')
                    : t('offsite.statusRunning');
                return (
                  <div key={run.id} className="px-3 py-2 flex items-center justify-between gap-3 text-xs">
                    <div className="min-w-0 flex items-center gap-2">
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ background: statusColor }}
                      />
                      <span className="font-medium text-fg">{statusLabel}</span>
                      {date && (
                        <span className="text-fg-3">
                          {format(date, 'dd/MM/yyyy · HH:mm')}
                        </span>
                      )}
                      {run.snapshot_id && (
                        <span className="font-mono text-fg-2">{run.snapshot_id.slice(0, 8)}</span>
                      )}
                    </div>
                    <div className="text-fg-3 shrink-0 font-mono truncate max-w-[14rem]" title={run.message || ''}>
                      {run.status === 'success' && run.added_bytes > 0
                        ? `+${formatBytes(run.added_bytes)}`
                        : run.status === 'failed' && run.message
                          ? run.message
                          : ''}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-4 py-3 space-y-2">
          <p className="text-[12px] font-medium text-fg-2">{t('offsite.snapshotsTitle')}</p>
          {data?.snapshots_error && (
            <p className="text-[12px] text-danger">{data.snapshots_error}</p>
          )}
          {isLoading ? (
            <div className="skeleton h-12" />
          ) : snapshots.length === 0 ? (
            <p className="text-[12px] text-fg-3">{t('offsite.noSnapshots')}</p>
          ) : (
            <div className="divide-y divide-line rounded-lg border border-line bg-bg/40">
              {snapshots.map((snap) => {
                const date = parseDbDate(snap.time);
                return (
                  <div key={snap.id} className="px-3 py-2.5 flex items-center justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono font-medium text-fg">{snap.short_id}</span>
                        {date && (
                          <span className="text-fg-2">
                            {format(date, 'dd/MM/yyyy · HH:mm')}
                          </span>
                        )}
                        {date && (
                          <span className="text-fg-3">
                            {formatDistanceToNow(date, { addSuffix: true, locale })}
                          </span>
                        )}
                      </div>
                      {snap.size ? (
                        <p className="text-fg-3 font-mono mt-0.5">{formatBytes(snap.size)}</p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="btn-secondary !h-7 !px-2.5 text-xs shrink-0"
                      onClick={() => setToRestore(snap)}
                    >
                      <RotateCcw size={12} strokeWidth={2} />
                      {t('offsite.restore')}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!toRestore}
        onClose={() => setToRestore(null)}
        onConfirm={() => restoreMut.mutate(toRestore.id)}
        busy={restoreMut.isPending}
        tone="default"
        title={t('offsite.restoreTitle')}
        message={t('offsite.restoreConfirm', { id: toRestore?.short_id || '' })}
        confirmLabel={t('offsite.restore')}
      />
    </section>
  );
}
