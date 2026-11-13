import React, { useState } from 'react';
import { useI18n } from '../../../i18n';
import { useQueryClient } from '@tanstack/react-query';
import { importWorld } from '../../../services/api';
import Modal from '../../ui/Modal';
import toast from 'react-hot-toast';
import { Upload, Globe } from 'lucide-react';

export default function WorldImportModal({ server, onClose }) {
  const { t } = useI18n();
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const qc = useQueryClient();

  async function handleImport() {
    if (!file) return;
    setUploading(true);
    try {
      await importWorld(server.id, file);
      toast.success(t('worldImport.success'));
      qc.invalidateQueries({ queryKey: ['server', server.id] });
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || t('worldImport.error'));
    } finally {
      setUploading(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={t('worldImport.title')} size="sm">
      <div className="p-6 space-y-4">
        <p className="text-sm text-fg-2">{t('worldImport.description')}</p>
        <div
          className="rounded-xl p-6 text-center cursor-pointer transition-all duration-200"
          style={{
            border: `2px dashed ${file ? 'rgba(var(--accent-rgb),0.4)' : 'rgba(var(--tint-rgb),0.1)'}`,
            background: file ? 'rgba(var(--accent-rgb),0.04)' : 'transparent',
          }}
        >
          <input type="file" accept=".zip" id="world-import-file" className="hidden"
            onChange={e => setFile(e.target.files[0] || null)} />
          <label htmlFor="world-import-file" className="cursor-pointer">
            {file ? (
              <div className="space-y-1">
                <p className="text-accent font-medium text-sm">{file.name}</p>
                <p className="text-fg-2 text-xs">{(file.size / 1024 / 1024).toFixed(1)} Mo</p>
              </div>
            ) : (
              <div className="space-y-2">
                <Globe size={22} strokeWidth={1.5} className="mx-auto text-fg-3" />
                <p className="text-sm text-fg-2">{t('worldImport.selectFile')}</p>
              </div>
            )}
          </label>
        </div>
        <div className="flex gap-3">
          <button className="btn-ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn-primary ml-auto gap-2" onClick={handleImport} disabled={!file || uploading}>
            <Upload size={13} strokeWidth={1.5} />
            {uploading ? t('worldImport.loading') : t('worldImport.submit')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
