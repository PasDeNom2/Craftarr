import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getBackups, deleteBackup, restoreBackup, backupServer } from '../../services/api';
import { useI18n } from '../../i18n';
import { formatDistanceToNow } from 'date-fns';
import { fr, enUS, de, es, pt, it, nl, pl, cs, sv, ru, uk, ja, ko, zhCN, ar, tr } from 'date-fns/locale';
import toast from 'react-hot-toast';
import { HardDrive, RotateCcw, Trash2, Plus } from 'lucide-react';

const DATE_FNS_LOCALES = { fr, en: enUS, de, es, pt, it, nl, pl, cs, sv, ru, uk, ja, ko, zh: zhCN, ar, tr };

function formatSize(bytes) {
  if (!bytes) return '0 Mo';
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} Go`;
  return `${(bytes / 1024 / 1024).toFixed(0)} Mo`;
}

export default function BackupList({ server }) {
  const qc = useQueryClient();
  const { t, lang } = useI18n();
  const qKey = ['backups', server.id];
  const dateFnsLocale = DATE_FNS_LOCALES[lang] || enUS;

  const TRIGGER_LABELS = {
    manual:       t('backups.triggerManual'),
    'pre-update': t('backups.triggerPreUpdate'),
    scheduled:    t('backups.triggerScheduled'),
  };

  const { data: backups = [], isLoading } = useQuery({
    queryKey: qKey,
    queryFn: () => getBackups(server.id),
    refetchInterval: 30000,
  });

  const doBackup = useMutation({
    mutationFn: () => backupServer(server.id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qKey }); toast.success(t('backups.createSuccess')); },
    onError: () => toast.error(t('backups.error')),
  });

  const doDelete = useMutation({
    mutationFn: (bid) => deleteBackup(server.id, bid),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qKey }); toast.success(t('backups.deleteSuccess')); },
    onError: () => toast.error(t('backups.error')),
  });

  const doRestore = useMutation({
    mutationFn: (bid) => restoreBackup(server.id, bid),
    onSuccess: () => toast.success(t('backups.restoreSuccess')),
    onError: () => toast.error(t('backups.error')),
  });

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-[#F0F0F0]">{t('backups.title')}</h3>
          <p className="text-xs text-[#6B6B76] mt-0.5">
            {backups.length} {t('backups.available')}
          </p>
        </div>
        <button
          className="btn-primary text-xs py-1.5 gap-2"
          onClick={() => doBackup.mutate()}
          disabled={doBackup.isPending}
        >
          <Plus size={12} strokeWidth={2} />
          {doBackup.isPending ? t('backups.creating') : t('backups.create')}
        </button>
      </div>

      {isLoading ? (
        <div className="text-center text-[#6B6B76] py-8 text-sm">{t('common.loading')}</div>
      ) : backups.length === 0 ? (
        <div className="text-center py-12 space-y-3">
          <div
            className="w-10 h-10 rounded-xl mx-auto flex items-center justify-center"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
          >
            <HardDrive size={18} strokeWidth={1.5} className="text-[#4A4A55]" />
          </div>
          <p className="text-sm text-[#6B6B76]">{t('backups.noBackups')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {backups.map(b => (
            <div
              key={b.id}
              className="flex items-center gap-4 px-4 py-3 rounded-xl group"
              style={{ background: '#131316', border: '1px solid rgba(255,255,255,0.06)' }}
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-[#F0F0F0] truncate font-mono">{b.filename}</p>
                <div className="flex gap-3 text-xs text-[#6B6B76] mt-0.5 flex-wrap">
                  <span>{TRIGGER_LABELS[b.trigger] || b.trigger}</span>
                  <span>{formatSize(b.size_bytes)}</span>
                  {b.created_at && (
                    <span>{formatDistanceToNow(new Date(b.created_at), { locale: dateFnsLocale, addSuffix: true })}</span>
                  )}
                  {b.modpack_version_at_backup && (
                    <span className="text-[#4A4A55]">v{b.modpack_version_at_backup}</span>
                  )}
                </div>
              </div>
              <div className="flex gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                <button
                  className="btn-secondary text-xs py-1 px-2.5 gap-1.5"
                  onClick={() => {
                    if (confirm(t('backups.confirmRestore'))) doRestore.mutate(b.id);
                  }}
                  disabled={doRestore.isPending}
                  title={t('backups.restore')}
                >
                  <RotateCcw size={11} strokeWidth={1.5} />
                  {t('backups.restore')}
                </button>
                <button
                  className="btn-danger p-1.5 rounded-lg"
                  onClick={() => {
                    if (confirm(t('backups.confirmDelete'))) doDelete.mutate(b.id);
                  }}
                  title={t('backups.delete')}
                >
                  <Trash2 size={12} strokeWidth={1.5} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
