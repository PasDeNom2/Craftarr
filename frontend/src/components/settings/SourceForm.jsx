import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Plug, CheckCircle2, XCircle } from 'lucide-react';
import Modal from '../ui/Modal';
import { createSource, testSource, updateSource, deleteSource } from '../../services/api';
import { useI18n } from '../../i18n';

const FORMATS = [
  { value: 'curseforge', label: 'CurseForge-compatible' },
  { value: 'modrinth', label: 'Modrinth-compatible' },
  { value: 'custom', label: 'Custom (mapper JSON)' },
];

const PRESETS = [
  { name: 'ATLauncher', base_url: 'https://api.atlauncher.com/v1', format: 'custom' },
  { name: 'FTB (Feed The Beast)', base_url: 'https://api.feed-the-beast.com/v1', format: 'custom' },
  { name: 'Technic Platform', base_url: 'https://api.technicpack.net/v1', format: 'custom' },
];

const MAPPER_EXAMPLE = `{
  "_searchEndpoint": "search",
  "_queryParam": "query",
  "_itemsPath": "data.items",
  "id": "id",
  "name": "title",
  "description": "description",
  "downloadUrl": "files.0.url",
  "version": "version",
  "mcVersion": "gameVersion"
}`;

export default function SourceForm({ onClose }) {
  const qc = useQueryClient();
  const { t } = useI18n();
  const [form, setForm] = useState({ name: '', base_url: '', api_key: '', format: 'curseforge', field_mapping_json: '' });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [saving, setSaving] = useState(false);
  // Le test a besoin d'une source enregistrée : on la crée une fois, puis on la met à jour à l'enregistrement
  const [draftId, setDraftId] = useState(null);

  function set(field, value) {
    setForm(f => ({ ...f, [field]: value }));
    setTestResult(null);
  }

  function payload() {
    return {
      name: form.name.trim(),
      base_url: form.base_url.trim(),
      api_key: form.api_key || undefined,
      format: form.format,
      field_mapping_json: form.field_mapping_json.trim() ? JSON.parse(form.field_mapping_json) : undefined,
    };
  }

  // Annuler après un test : ne pas laisser de source brouillon en base
  function close() {
    if (draftId) deleteSource(draftId).finally(() => qc.invalidateQueries({ queryKey: ['sources'] }));
    onClose();
  }

  async function handleTest() {
    if (!form.name || !form.base_url) return toast.error(t('sources.fillFirst'));
    setTesting(true);
    setTestResult(null);
    try {
      const data = payload();
      let id = draftId;
      if (id) await updateSource(id, data);
      else { id = (await createSource(data)).id; setDraftId(id); }
      setTestResult(await testSource(id));
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof SyntaxError ? t('sources.invalidMapper') : (err.response?.data?.error || err.message) });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const data = payload();
      if (draftId) await updateSource(draftId, data);
      else await createSource(data);
      qc.invalidateQueries({ queryKey: ['sources'] });
      toast.success(t('sources.created', { name: data.name }));
      onClose();
    } catch (err) {
      toast.error(err instanceof SyntaxError ? t('sources.invalidMapper') : (err.response?.data?.error || t('common.error')));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={close} title={t('sources.formTitle')} icon={Plug} size="md">
      <form onSubmit={handleSave} className="p-6 space-y-4">
        <div>
          <label className="label">{t('sources.presets')}</label>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map(p => (
              <button
                key={p.name} type="button"
                className="text-xs px-2.5 py-1 rounded-lg bg-surface-2 border border-line text-fg-2 hover:text-fg hover:border-line-strong transition-colors"
                onClick={() => setForm(f => ({ ...f, name: p.name, base_url: p.base_url, format: p.format }))}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="label">{t('sources.name')} *</label>
            <input className="input" value={form.name} onChange={e => set('name', e.target.value)} required placeholder={t('sources.namePlaceholder')} />
          </div>
          <div>
            <label className="label">{t('sources.type')} *</label>
            <select className="input" value={form.format} onChange={e => set('format', e.target.value)}>
              {FORMATS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label className="label">{t('sources.url')} *</label>
          <input className="input font-mono" value={form.base_url} onChange={e => set('base_url', e.target.value)} required placeholder="https://api.example.com/v1" />
        </div>

        <div>
          <label className="label">{t('sources.apiKey')} <span className="normal-case tracking-normal text-fg-3">({t('common.optional')})</span></label>
          <input className="input" type="password" value={form.api_key} onChange={e => set('api_key', e.target.value)} placeholder={t('sources.apiKeyHint')} autoComplete="off" />
        </div>

        {form.format === 'custom' && (
          <div className="fade-in">
            <label className="label">{t('sources.mapper')}</label>
            <textarea
              className="input font-mono text-xs" rows={7}
              value={form.field_mapping_json} onChange={e => set('field_mapping_json', e.target.value)}
              placeholder={MAPPER_EXAMPLE}
            />
          </div>
        )}

        <div className="flex items-center gap-3 flex-wrap">
          <button type="button" className="btn-secondary" onClick={handleTest} disabled={testing}>
            <Plug size={14} strokeWidth={1.75} /> {testing ? t('sources.testing') : t('sources.testConnection')}
          </button>
          {testResult && (
            <span className={`inline-flex items-center gap-1.5 text-sm fade-in ${testResult.ok ? 'text-accent' : 'text-danger'}`}>
              {testResult.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
              {testResult.ok ? t('sources.testSuccess') : testResult.error}
            </span>
          )}
        </div>

        <div className="flex gap-3 pt-4 border-t border-line">
          <button type="button" className="btn-ghost" onClick={close}>{t('common.cancel')}</button>
          <button type="submit" className="btn-primary ml-auto" disabled={saving}>
            {saving ? t('sources.saving') : t('sources.add')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
