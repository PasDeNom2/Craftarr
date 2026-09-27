import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceToNow } from 'date-fns';
import toast from 'react-hot-toast';
import { HardDrive, RotateCcw, Trash2, Plus, Clock, Hand, ArrowUpCircle, FolderInput } from 'lucide-react';
import { getBackups, deleteBackup, restoreBackup, backupServer } from '../../services/api';
import { useI18n } from '../../i18n';
import ConfirmDialog from '../ui/ConfirmDialog';
import { parseDbDate } from '../../utils/dates';
import { useDateLocale } from '../../utils/dateLocale';

function formatSize(bytes) {
  if (!bytes) return '0 Mo';
  if (bytes > 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} Go`;
  if (bytes > 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} Mo`;
  return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
}

// Chaque type de backup a sa couleur et son icône
const TRIGGERS = {
  scheduled:    { icon: Clock,         color: 'var(--info)',   rgb: 'var(--info-rgb)',   key: 'backups.triggerScheduled' },
  manual:       { icon: Hand,          color: 'var(--accent)', rgb: 'var(--accent-rgb)', key: 'backups.triggerManual' },
  'pre-update': { icon: ArrowUpCircle, color: 'var(--purple)', rgb: 'var(--purple-rgb)', key: 'backups.triggerPreUpdate' },
  'pre-import': { icon: FolderInput,   color: 'var(--warn)',   rgb: 'var(--warn-rgb)',   key: 'backups.triggerPreImport' },
};

export default function BackupList({ server }) {
  const qc = useQueryClient();
  const { t } = useI18n();
  const locale = useDateLocale();
  const qKey = ['backups', server.id];
  const [toRestore, setToRestore] = useState(null);
  const [toDelete, setToDelete] = useState(null);

  const { data: backups = [], isLoading } = useQuery({
    queryKey: qKey,
    queryFn: () => getBackups(server.id),
    refetchInterval: 30000,
  });

  const doBackup = useMutation({
    mutationFn: () => backupServer(server.id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qKey }); toast.success(t('backups.createSuccess')); },
    onError: (err) => toast.error(err.response?.data?.error || t('backups.error')),
  });

  const doDelete = useMutation({
    mutationFn: (bid) => deleteBackup(server.id, bid),
    onSuccess: () => { setToDelete(null); qc.invalidateQueries({ queryKey: qKey }); toast.success(t('backups.deleteSuccess')); },
    onError: (err) => toast.error(err.response?.data?.error || t('backups.error')),
  });

  const doRestore = useMutation({
    mutationFn: (bid) => restoreBackup(server.id, bid),
    onSuccess: () => {
      setToRestore(null);
      qc.invalidateQueries({ queryKey: ['server', server.id] });
      toast.success(t('backups.restoreSuccess'));
    },
    onError: (err) => toast.error(err.response?.data?.error || t('backups.error')),
  });

  const totalSize = backups.reduce((n, b) => n + (b.size_bytes || 0), 0);

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h3 className="font-display text-lg font-semibold text-fg">{t('backups.title')}</h3>
          <p className="text-xs text-fg-2 mt-1">
            <span className="font-pixel text-fg">{backups.length}</span> {t('backups.available')}
            {backups.length > 0 && <span className="text-fg-3"> · {formatSize(totalSize)}</span>}
          </p>
        </div>
        <button className="btn-primary" onClick={() => doBackup.mutate()} disabled={doBackup.isPending}>
          <Plus size={14} strokeWidth={2.25} />
          {doBackup.isPending ? t('backups.creating') : t('backups.create')}
        </button>
      </div>

      {isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map(i => <div key={i} className="skeleton h-[68px]" />)}</div>
      ) : backups.length === 0 ? (
        <div className="card text-center py-14">
          <div className="w-12 h-12 rounded-xl mx-auto flex items-center justify-center bg-surface-2 border border-line">
            <HardDrive size={20} strokeWidth={1.5} className="text-fg-3" />
          </div>
          <p className="text-sm text-fg-2 mt-4">{t('backups.noBackups')}</p>
        </div>
      ) : (
        <ol className="relative space-y-2">
          {backups.map((b, idx) => {
            const trig = TRIGGERS[b.trigger] || TRIGGERS.manual;
            const Icon = trig.icon;
            const date = parseDbDate(b.created_at);
            return (
              <li
                key={b.id}
                className="card card-interactive card-in flex items-center gap-4 !py-3.5 !px-4"
                style={{ animationDelay: `${Math.min(idx, 10) * 25}ms` }}
              >
                <div
                  className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: `rgba(${trig.rgb},0.1)`, border: `1px solid rgba(${trig.rgb},0.25)`, color: trig.color }}
                >
                  <Icon size={16} strokeWidth={1.75} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-sm font-medium text-fg" title={date ? format(date, 'dd/MM/yyyy HH:mm:ss') : ''}>
                      {date ? format(date, 'dd/MM/yyyy · HH:mm') : '—'}
                    </span>
                    {date && <span className="text-xs text-fg-3">{formatDistanceToNow(date, { addSuffix: true, locale })}</span>}
                  </div>
                  <div className="flex gap-2 text-xs mt-0.5 flex-wrap items-center">
                    <span style={{ color: trig.color }}>{t(trig.key)}</span>
                    <span className="text-fg-3">·</span>
                    <span className="text-fg-2 font-mono">{formatSize(b.size_bytes)}</span>
                    {b.modpack_version_at_backup && (
                      <>
                        <span className="text-fg-3">·</span>
                        <span className="text-fg-3 truncate max-w-[16rem]">{b.modpack_version_at_backup}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <button className="btn-secondary text-xs px-3 py-1.5" onClick={() => setToRestore(b)} title={t('backups.restore')}>
                    <RotateCcw size={12} strokeWidth={2} /> {t('backups.restore')}
                  </button>
                  <button
                    className="btn-danger px-2 py-1.5"
                    onClick={() => setToDelete(b)}
                    title={t('backups.delete')}
                    aria-label={t('backups.delete')}
                  >
                    <Trash2 size={13} strokeWidth={1.75} />
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <ConfirmDialog
        open={!!toRestore}
        onClose={() => setToRestore(null)}
        onConfirm={() => doRestore.mutate(toRestore.id)}
        busy={doRestore.isPending}
        tone="default"
        title={t('backups.restore')}
        message={t('backups.confirmRestore')}
        confirmLabel={t('backups.restore')}
      />
      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => doDelete.mutate(toDelete.id)}
        busy={doDelete.isPending}
        title={t('backups.delete')}
        message={t('backups.confirmDelete')}
        confirmLabel={t('backups.delete')}
      />
    </div>
  );
}
