import React, { useState } from 'react';
import Modal from '../ui/Modal';
import { createSource, testSource } from '../../services/api';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';

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

export default function SourceForm({ onClose }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', base_url: '', api_key: '', format: 'curseforge', field_mapping_json: '' });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const [createdId, setCreatedId] = useState(null);

  function applyPreset(preset) {
    setForm(f => ({ ...f, name: preset.name, base_url: preset.base_url, format: preset.format }));
  }

  function set(field, value) {
    setForm(f => ({ ...f, [field]: value }));
    setTestResult(null);
  }

  async function handleTest() {
    if (!form.name || !form.base_url) {
      toast.error('Remplissez le nom et l\'URL avant de tester');
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      // Crée temporairement ou utilise un id temporaire
      let id = createdId;
      if (!id) {
        const src = await createSource({
          name: form.name + ' (test)',
          base_url: form.base_url,
          api_key: form.api_key || undefined,
          format: form.format,
          field_mapping_json: form.field_mapping_json ? JSON.parse(form.field_mapping_json) : undefined,
        });
        id = src.id;
        setCreatedId(id);
      }
      const result = await testSource(id);
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, error: err.message });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    try {
      let mapping = undefined;
      if (form.field_mapping_json.trim()) {
        mapping = JSON.parse(form.field_mapping_json);
      }
      if (!createdId) {
        await createSource({
          name: form.name,
          base_url: form.base_url,
          api_key: form.api_key || undefined,
          format: form.format,
          field_mapping_json: mapping,
        });
      }
      qc.invalidateQueries({ queryKey: ['sources'] });
      toast.success(`Source "${form.name}" ajoutée`);
      onClose();
    } catch (err) {
      if (err instanceof SyntaxError) {
        toast.error('Le mapper JSON est invalide');
      } else {
        toast.error(err.response?.data?.error || 'Erreur lors de la création');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Ajouter une source de modpacks" size="md">
      <form onSubmit={handleSave} className="p-6 space-y-4">
        {/* Presets */}
        <div>
          <label className="label">Présets</label>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map(p => (
              <button key={p.name} type="button" className="btn-ghost text-xs py-1"
                onClick={() => applyPreset(p)}>
                {p.name}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="label">Nom de la source *</label>
          <input className="input" value={form.name} onChange={e => set('name', e.target.value)} required placeholder="Mon API de modpacks" />
        </div>

        <div>
          <label className="label">URL de base *</label>
          <input className="input" value={form.base_url} onChange={e => set('base_url', e.target.value)} required placeholder="https://api.example.com/v1" />
        </div>

        <div>
          <label className="label">Clé API (optionnelle)</label>
          <input className="input" type="password" value={form.api_key} onChange={e => set('api_key', e.target.value)} placeholder="Stockée chiffrée en AES-256" />
        </div>

        <div>
          <label className="label">Format *</label>
          <select className="input" value={form.format} onChange={e => set('format', e.target.value)}>
            {FORMATS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>

        {form.format === 'custom' && (
          <div>
            <label className="label">Mapper JSON (champs → chemins dans la réponse)</label>
            <textarea
              className="input font-mono text-xs"
              rows={6}
              value={form.field_mapping_json}
              onChange={e => set('field_mapping_json', e.target.value)}
              placeholder={`{\n  "_searchEndpoint": "search",\n  "_queryParam": "query",\n  "_itemsPath": "data.items",\n  "id": "id",\n  "name": "title",\n  "description": "description",\n  "downloadUrl": "files.0.url",\n  "version": "version",\n  "mcVersion": "gameVersion"\n}`}
            />
          </div>
        )}

        {/* Test */}
        <div className="flex items-center gap-3">
          <button type="button" className="btn-secondary" onClick={handleTest} disabled={testing}>
            {testing ? 'Test en cours...' : 'Tester la connexion'}
          </button>
          {testResult && (
            <span className={testResult.ok ? 'text-green-400 text-sm' : 'text-red-400 text-sm'}>
              {testResult.ok ? '✓ Connexion OK' : `✗ ${testResult.error}`}
            </span>
          )}
        </div>

        <div className="flex gap-3 pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <button type="button" className="btn-ghost" onClick={onClose}>Annuler</button>
          <button type="submit" className="btn-primary ml-auto" disabled={saving}>
            {saving ? 'Enregistrement...' : 'Ajouter la source'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
