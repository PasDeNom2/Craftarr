import React, { useState } from 'react';
import { useI18n } from '../../../i18n';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { updateServer, getModpackVersions } from '../../../services/api';
import { useServerStore } from '../../../store';
import Modal from '../../ui/Modal';
import toast from 'react-hot-toast';
import { RotateCcw } from 'lucide-react';

const RELEASE_TYPE_LABEL = { 1: 'Release', 2: 'Beta', 3: 'Alpha' };

export default function UpdateModal({ server, onClose }) {
  const { t } = useI18n();
  const [selectedVersionId, setSelectedVersionId] = useState('');
  const qc = useQueryClient();
  const { updateServer: patchStore } = useServerStore();

  const { data: versions = [], isLoading } = useQuery({
    queryKey: ['modpack-versions', server.modpack_source, server.modpack_id],
    queryFn: () => getModpackVersions(server.modpack_source, server.modpack_id),
    staleTime: 60000,
  });

  const doUpdate = useMutation({
    mutationFn: () => updateServer(server.id, selectedVersionId || undefined),
    onSuccess: (data) => {
      if (data.upToDate) toast.success(t('update.upToDate'));
      else {
        toast.success(t('update.successVersion', { version: data.version }));
        patchStore(server.id, { status: 'updating' });
      }
      qc.invalidateQueries({ queryKey: ['server', server.id] });
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.error || t('update.error')),
  });

  return (
    <Modal open onClose={onClose} title={t('update.title')} size="md">
      <div className="p-6 space-y-5">
        <div className="card space-y-1 text-sm">
          <p className="text-fg-2 text-xs uppercase tracking-[0.08em]">{t('update.currentVersion')}</p>
          <p className="font-medium text-fg">{server.modpack_version || t('serverSettings.unknown')}</p>
        </div>
        <div>
          <label className="label">{t('update.targetVersion')}</label>
          {isLoading ? (
            <div className="input text-fg-3 text-sm animate-pulse">{t('update.loadingVersions')}</div>
          ) : (
            <select className="input" value={selectedVersionId} onChange={e => setSelectedVersionId(e.target.value)}>
              <option value="">{t('update.latestAvailable')}</option>
              {versions.map((v) => {
                const label = v.displayName || v.name || v.versionNumber || v.id;
                const type = RELEASE_TYPE_LABEL[v.releaseType] || '';
                const mcVer = (v.mcVersions || v.game_versions || []).filter(x => /^(1|2[6-9])\.\d+/.test(x)).slice(0, 2).join(', ');
                const isCurrent = String(v.id) === String(server.modpack_version_id);
                return (
                  <option key={v.id} value={String(v.id)}>
                    {isCurrent ? '> ' : ''}{label}{type ? ` [${type}]` : ''}{mcVer ? ` — MC ${mcVer}` : ''}{isCurrent ? ` ${t('update.currentLabel')}` : ''}
                  </option>
                );
              })}
            </select>
          )}
          <p className="text-xs text-fg-2 mt-1">{t('update.backupNote')}</p>
        </div>
        <div className="flex gap-3 pt-2" style={{ borderTop: '1px solid rgba(var(--tint-rgb),0.06)' }}>
          <button className="btn-ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn-primary ml-auto gap-2" onClick={() => doUpdate.mutate()} disabled={doUpdate.isPending}>
            <RotateCcw size={13} strokeWidth={1.5} />
            {doUpdate.isPending ? t('update.loading') : t('update.submit')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
