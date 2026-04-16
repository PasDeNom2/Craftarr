import React, { useState, useEffect } from 'react';
import Modal from '../ui/Modal';
import { createServer, getModpackVersions } from '../../services/api';
import { useServerStore } from '../../store';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { Rocket, Globe } from 'lucide-react';

const RELEASE_TYPE_LABEL = { 1: 'Release', 2: 'Beta', 3: 'Alpha' };
const LOADER_LABELS = { forge: 'Forge', neoforge: 'NeoForge', fabric: 'Fabric', quilt: 'Quilt', vanilla: 'Vanilla' };

export default function DeployModal({ modpack, onClose }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: modpack ? `${modpack.name.slice(0, 30)} Server` : '',
    port: 25565,
    ram_mb: 4096,
    max_players: 20,
    seed: '',
    whitelist_enabled: false,
    version_id: '',
  });
  const [worldFile, setWorldFile] = useState(null);
  const [deploying, setDeploying] = useState(false);
  const { addServer } = useServerStore();

  const { data: versions = [], isLoading: versionsLoading } = useQuery({
    queryKey: ['modpack-versions', modpack?.source, modpack?.id],
    queryFn: () => getModpackVersions(modpack.source, modpack.id),
    enabled: !!modpack,
    staleTime: 300000,
  });

  useEffect(() => {
    if (versions.length > 0 && !form.version_id) {
      setForm(f => ({ ...f, version_id: String(versions[0].id) }));
    }
  }, [versions]);

  const selectedVersion = versions.find(v => String(v.id) === form.version_id);
  const detectedLoaders = selectedVersion?.loaders || [];
  const detectedMcVersions = (selectedVersion?.mcVersions || selectedVersion?.game_versions || []).filter(v => /^1\.\d+/.test(v));

  async function handleDeploy(e) {
    e.preventDefault();
    setDeploying(true);
    try {
      const server = await createServer({
        name: form.name,
        port: form.port,
        ram_mb: form.ram_mb,
        max_players: form.max_players,
        seed: form.seed || undefined,
        whitelist_enabled: form.whitelist_enabled,
        modpack_id: modpack.id,
        modpack_name: modpack.name,
        modpack_source: modpack.source,
        modpack_version_id: form.version_id || undefined,
        mc_version: detectedMcVersions[0] || modpack.mcVersions?.[0] || null,
        loader_type: detectedLoaders[0] || 'forge',
      });
      addServer(server);
      if (worldFile) {
        const formData = new FormData();
        formData.append('world', worldFile);
        fetch(`/api/servers/${server.id}/world-import`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${localStorage.getItem('mcm_token')}` },
          body: formData,
        }).catch(console.error);
      }
      onClose();
      navigate(`/servers/${server.id}`);
    } catch (err) {
      setDeploying(false);
      toast.error(err.response?.data?.error || 'Erreur lors du déploiement');
    }
  }

  function set(field, value) {
    setForm(f => ({ ...f, [field]: value }));
  }

  if (!modpack) return null;

  return (
    <Modal open={!!modpack} onClose={onClose} title={`Déployer : ${modpack?.name}`} size="lg">
      <div className="p-6">
        <form onSubmit={handleDeploy} className="space-y-5">
          {/* Version selector */}
          <div>
            <label className="label">Version du modpack</label>
            {versionsLoading ? (
              <div className="input text-[#4A4A55] text-sm">Chargement des versions...</div>
            ) : versions.length === 0 ? (
              <div className="input text-[#4A4A55] text-sm">Aucune version disponible</div>
            ) : (
              <select className="input" value={form.version_id} onChange={e => set('version_id', e.target.value)}>
                {versions.map(v => {
                  const label = v.displayName || v.name || v.versionNumber || v.id;
                  const type = RELEASE_TYPE_LABEL[v.releaseType] || '';
                  const mcVer = (v.mcVersions || v.game_versions || []).filter(x => /^1\.\d+/.test(x)).slice(0, 2).join(', ');
                  return (
                    <option key={v.id} value={String(v.id)}>
                      {label}{type ? ` [${type}]` : ''}{mcVer ? ` — MC ${mcVer}` : ''}
                    </option>
                  );
                })}
              </select>
            )}
          </div>

          {/* Auto-detected info */}
          {selectedVersion && (detectedLoaders.length > 0 || detectedMcVersions.length > 0) && (
            <div className="flex gap-2 flex-wrap">
              {detectedMcVersions.length > 0 && (
                <span
                  className="text-xs px-2 py-1 rounded-md text-[#6B6B76]"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
                >
                  MC {detectedMcVersions.slice(0, 2).join(', ')}
                </span>
              )}
              {detectedLoaders.map(l => (
                <span
                  key={l}
                  className="text-xs px-2 py-1 rounded-md text-[#6B6B76]"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
                >
                  {LOADER_LABELS[l] || l}
                </span>
              ))}
              <span className="text-xs text-[#4A4A55] self-center">Loader détecté automatiquement</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="label">Nom du serveur</label>
              <input className="input" value={form.name} onChange={e => set('name', e.target.value)} required />
            </div>
            <div>
              <label className="label">Port</label>
              <input className="input" type="number" min="1024" max="65535" value={form.port} onChange={e => set('port', +e.target.value)} />
            </div>
            <div>
              <label className="label">Joueurs max</label>
              <input className="input" type="number" min="1" max="100" value={form.max_players} onChange={e => set('max_players', +e.target.value)} />
            </div>
          </div>

          {/* RAM slider */}
          <div>
            <div className="flex justify-between mb-1.5">
              <label className="label mb-0">RAM allouée</label>
              <span className="text-sm font-semibold text-[#F0F0F0]">
                {form.ram_mb >= 1024 ? `${form.ram_mb / 1024} Go` : `${form.ram_mb} Mo`}
              </span>
            </div>
            <input
              type="range" min="1024" max="32768" step="512"
              value={form.ram_mb}
              onChange={e => set('ram_mb', +e.target.value)}
              className="w-full"
              style={{ accentColor: '#4ADE80' }}
            />
            <div className="flex justify-between text-[11px] text-[#4A4A55] mt-1">
              <span>1 Go</span><span>32 Go</span>
            </div>
          </div>

          <div>
            <label className="label">Seed (optionnel)</label>
            <input className="input" value={form.seed} onChange={e => set('seed', e.target.value)} placeholder="Aléatoire si vide" />
          </div>

          {/* World import */}
          <div>
            <label className="label">
              Importer un dossier world
              <span className="ml-2 text-[#4A4A55] font-normal normal-case tracking-normal">— zip optionnel</span>
            </label>
            <div
              className="rounded-xl p-4 text-center cursor-pointer transition-all duration-200"
              style={{
                border: `2px dashed ${worldFile ? 'rgba(74,222,128,0.4)' : 'rgba(255,255,255,0.1)'}`,
                background: worldFile ? 'rgba(74,222,128,0.04)' : 'transparent',
              }}
            >
              <input type="file" accept=".zip" className="hidden" id="world-upload"
                onChange={e => setWorldFile(e.target.files[0] || null)} />
              <label htmlFor="world-upload" className="cursor-pointer">
                {worldFile ? (
                  <div className="space-y-1">
                    <p className="text-[#4ADE80] text-sm font-medium">{worldFile.name}</p>
                    <p className="text-[#4A4A55] text-xs">{(worldFile.size / 1024 / 1024).toFixed(1)} Mo</p>
                    <button type="button" className="text-xs text-[#F87171] hover:text-red-400 transition-colors"
                      onClick={e => { e.preventDefault(); setWorldFile(null); }}>
                      Retirer
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Globe size={20} strokeWidth={1.5} className="mx-auto text-[#4A4A55]" />
                    <p className="text-sm text-[#6B6B76]">Cliquez pour sélectionner un .zip</p>
                  </div>
                )}
              </label>
            </div>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" className="w-4 h-4 rounded" checked={form.whitelist_enabled}
              onChange={e => set('whitelist_enabled', e.target.checked)}
              style={{ accentColor: '#4ADE80' }} />
            <span className="text-sm text-[#6B6B76]">Activer la whitelist</span>
          </label>

          <button type="submit" className="btn-primary w-full justify-center py-2.5 gap-2" disabled={deploying}>
            <Rocket size={14} strokeWidth={1.5} />
            {deploying ? 'Création en cours...' : 'Déployer ce serveur'}
          </button>
        </form>
      </div>
    </Modal>
  );
}
