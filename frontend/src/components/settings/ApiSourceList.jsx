import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getSources, updateSource, deleteSource, testSource, exportSources, importSources } from '../../services/api';
import SourceBadge from '../ui/SourceBadge';
import SourceForm from './SourceForm';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { Plus, Upload, Download, Link2, Trash2 } from 'lucide-react';

export default function ApiSourceList() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);

  const { data: sources = [], isLoading } = useQuery({
    queryKey: ['sources'],
    queryFn: getSources,
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }) => updateSource(id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sources'] }),
    onError: () => toast.error('Erreur'),
  });

  const remove = useMutation({
    mutationFn: (id) => deleteSource(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['sources'] }); toast.success('Source supprimée'); },
    onError: (err) => toast.error(err.response?.data?.error || 'Erreur'),
  });

  async function handleTest(source) {
    const t = toast.loading('Test en cours...');
    try {
      const result = await testSource(source.id);
      toast.dismiss(t);
      if (result.ok) toast.success(`${source.name} répond correctement`);
      else toast.error(`${source.name} : ${result.error}`);
    } catch {
      toast.dismiss(t);
      toast.error('Erreur lors du test');
    }
  }

  async function handleExport() {
    const data = await exportSources();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'mcmanager-sources.json'; a.click();
    URL.revokeObjectURL(url);
  }

  async function handleImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    try {
      const data = JSON.parse(text);
      const result = await importSources(data);
      qc.invalidateQueries({ queryKey: ['sources'] });
      toast.success(`${result.imported} source(s) importée(s)`);
    } catch {
      toast.error('Fichier JSON invalide');
    }
    e.target.value = '';
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[#6B6B76]">{sources.length} source{sources.length !== 1 ? 's' : ''}</p>
        <div className="flex gap-2">
          <button className="btn-secondary text-xs py-1.5 gap-1.5" onClick={handleExport}>
            <Upload size={11} strokeWidth={1.5} />
            Exporter
          </button>
          <label className="btn-secondary text-xs py-1.5 gap-1.5 cursor-pointer">
            <Download size={11} strokeWidth={1.5} />
            Importer
            <input type="file" accept=".json" className="hidden" onChange={handleImport} />
          </label>
          <button className="btn-primary text-xs py-1.5 gap-1.5" onClick={() => setShowForm(true)}>
            <Plus size={11} strokeWidth={2} />
            Ajouter
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-center text-[#6B6B76] py-6 text-sm">Chargement...</div>
      ) : (
        <div className="space-y-2">
          {sources.map(source => (
            <div
              key={source.id}
              className="flex items-center gap-4 px-4 py-3 rounded-xl group"
              style={{
                background: '#131316',
                border: '1px solid rgba(255,255,255,0.06)',
                opacity: source.enabled ? 1 : 0.5,
                transition: 'opacity 0.2s',
              }}
            >
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm text-[#F0F0F0]">{source.name}</span>
                  <SourceBadge source={source.id} sourceName={source.name} />
                  {source.is_builtin && (
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded-md text-[#4A4A55]"
                      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
                    >
                      Natif
                    </span>
                  )}
                </div>
                <p className="text-xs text-[#4A4A55] truncate font-mono">{source.base_url}</p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  className="text-xs text-[#4A4A55] hover:text-[#6B6B76] transition-colors flex items-center gap-1"
                  onClick={() => handleTest(source)}
                >
                  <Link2 size={11} strokeWidth={1.5} />
                  Tester
                </button>

                {/* Toggle */}
                <button
                  onClick={() => toggle.mutate({ id: source.id, enabled: !source.enabled })}
                  className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors"
                  style={{
                    background: source.enabled ? '#4ADE80' : 'rgba(255,255,255,0.1)',
                    transition: 'background 0.2s',
                  }}
                >
                  <span
                    className="inline-block h-3 w-3 rounded-full bg-white transition-transform"
                    style={{
                      transform: source.enabled ? 'translateX(20px)' : 'translateX(4px)',
                      transition: 'transform 0.2s',
                    }}
                  />
                </button>

                {!source.is_builtin && (
                  <button
                    className="p-1.5 rounded-lg text-[#4A4A55] hover:text-[#F87171] hover:bg-[#1C1C21] transition-colors"
                    onClick={() => { if (confirm('Supprimer cette source ?')) remove.mutate(source.id); }}
                    title="Supprimer"
                  >
                    <Trash2 size={12} strokeWidth={1.5} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && <SourceForm onClose={() => setShowForm(false)} />}
    </div>
  );
}
