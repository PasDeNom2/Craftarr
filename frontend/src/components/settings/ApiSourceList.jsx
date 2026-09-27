import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Plus, Upload, Download, Link2, Trash2 } from 'lucide-react';
import { getSources, updateSource, deleteSource, testSource, exportSources, importSources } from '../../services/api';
import { useI18n } from '../../i18n';
import SourceBadge from '../ui/SourceBadge';
import ConfirmDialog from '../ui/ConfirmDialog';
import SourceForm from './SourceForm';

function Toggle({ checked, onChange, label }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors"
      style={{ background: checked ? 'var(--accent)' : 'var(--surface-3)', boxShadow: 'inset 0 0 0 1px var(--line)' }}
    >
      <span
        className="inline-block h-3.5 w-3.5 rounded-[4px] transition-transform"
        style={{
          background: checked ? 'var(--accent-ink)' : 'var(--fg-2)',
          transform: checked ? 'translateX(19px)' : 'translateX(3px)',
          transitionTimingFunction: 'cubic-bezier(.16,1,.3,1)',
        }}
      />
    </button>
  );
}

export default function ApiSourceList() {
  const qc = useQueryClient();
  const { t } = useI18n();
  const [showForm, setShowForm] = useState(false);
  const [toDelete, setToDelete] = useState(null);

  const { data: sources = [], isLoading } = useQuery({ queryKey: ['sources'], queryFn: getSources });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }) => updateSource(id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sources'] }),
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  const remove = useMutation({
    mutationFn: (id) => deleteSource(id),
    onSuccess: () => { setToDelete(null); qc.invalidateQueries({ queryKey: ['sources'] }); toast.success(t('sources.deleteSuccess')); },
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  async function handleTest(source) {
    const id = toast.loading(t('sources.testing'));
    try {
      const result = await testSource(source.id);
      toast.dismiss(id);
      if (result.ok) toast.success(`${source.name} — ${t('sources.testSuccess')}`);
      else toast.error(`${source.name} — ${result.error || t('sources.testError')}`);
    } catch {
      toast.dismiss(id);
      toast.error(`${source.name} — ${t('sources.testError')}`);
    }
  }

  async function handleExport() {
    const data = await exportSources();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'craftarr-sources.json'; a.click();
    URL.revokeObjectURL(url);
  }

  async function handleImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const result = await importSources(JSON.parse(await file.text()));
      qc.invalidateQueries({ queryKey: ['sources'] });
      toast.success(t('sources.imported', { count: result.imported }));
    } catch {
      toast.error(t('sources.invalidJson'));
    }
    e.target.value = '';
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs text-fg-2"><span className="font-pixel text-fg">{sources.length}</span> {t('sources.title').toLowerCase()}</p>
        <div className="flex gap-2">
          <button className="btn-ghost text-xs px-3 py-1.5" onClick={handleExport}>
            <Upload size={13} strokeWidth={1.75} /> {t('sources.export')}
          </button>
          <label className="btn-ghost text-xs px-3 py-1.5 cursor-pointer">
            <Download size={13} strokeWidth={1.75} /> {t('sources.import')}
            <input type="file" accept=".json" className="hidden" onChange={handleImport} />
          </label>
          <button className="btn-primary text-xs px-3 py-1.5" onClick={() => setShowForm(true)}>
            <Plus size={13} strokeWidth={2.25} /> {t('sources.add')}
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">{[0, 1].map(i => <div key={i} className="skeleton h-16" />)}</div>
      ) : sources.length === 0 ? (
        <p className="text-center text-sm text-fg-2 py-8">{t('sources.noSources')}</p>
      ) : (
        <div className="space-y-2">
          {sources.map(source => (
            <div
              key={source.id}
              className="flex items-center gap-4 px-4 py-3 rounded-xl bg-bg-2 border border-line transition-opacity"
              style={{ opacity: source.enabled ? 1 : 0.55 }}
            >
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm text-fg">{source.name}</span>
                  <SourceBadge source={source.id} sourceName={source.name} />
                  {source.is_builtin && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-md text-fg-3 bg-surface-2 border border-line">{t('sources.builtin')}</span>
                  )}
                </div>
                <p className="text-xs text-fg-3 truncate font-mono">{source.base_url}</p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button className="btn-ghost text-xs px-2.5 py-1.5" onClick={() => handleTest(source)}>
                  <Link2 size={12} strokeWidth={1.75} /> {t('sources.test')}
                </button>
                <Toggle
                  checked={!!source.enabled}
                  label={source.name}
                  onChange={() => toggle.mutate({ id: source.id, enabled: !source.enabled })}
                />
                {!source.is_builtin && (
                  <button
                    className="p-1.5 rounded-lg text-fg-3 hover:text-danger hover:bg-surface-2 transition-colors"
                    onClick={() => setToDelete(source)}
                    title={t('sources.delete')}
                    aria-label={t('sources.delete')}
                  >
                    <Trash2 size={14} strokeWidth={1.75} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && <SourceForm onClose={() => setShowForm(false)} />}
      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => remove.mutate(toDelete.id)}
        busy={remove.isPending}
        title={t('sources.delete')}
        message={`${toDelete?.name || ''} — ${t('sources.deleteConfirm')}`}
        confirmLabel={t('sources.delete')}
      />
    </div>
  );
}
