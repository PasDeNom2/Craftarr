import React, { useState, useEffect } from 'react';
import Modal from '../ui/Modal';
import { createServer, getModpackVersions, uploadServerIcon } from '../../services/api';
import { useServerStore } from '../../store';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../../i18n';
import toast from 'react-hot-toast';
import { Rocket, Globe } from 'lucide-react';
import IconPicker from '../ui/IconPicker';
import PregenOption from './PregenOption';
import { nextFreePort, portTakenBy } from '../../utils/ports';

const RELEASE_TYPE_LABEL = { 1: 'Release', 2: 'Beta', 3: 'Alpha' };

export default function DeployModal({ modpack, onClose }) {
  const navigate = useNavigate();
  const { t } = useI18n();
  // Port par défaut = premier port libre (25565 est souvent déjà pris par un autre serveur)
  const allServers = useServerStore(s => s.servers);
  const [form, setForm] = useState({
    name: modpack ? `${modpack.name.slice(0, 30)} Server` : '',
    port: nextFreePort(allServers),
    ram_mb: 4096,
    max_players: 20,
    seed: '',
    whitelist_enabled: false,
    online_mode: true,
    version_id: '',
    pregen_enabled: false,
    pregen_radius: 3000,
    pregen_worlds: ['minecraft:overworld'],
  });
  const [worldFile, setWorldFile] = useState(null);
  const [iconFile, setIconFile] = useState(null);
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
  const detectedMcVersions = (selectedVersion?.mcVersions || selectedVersion?.game_versions || []).filter(v => /^(1\.\d+|2\d\.\d+)(\.\d+)?$/.test(v));

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
        online_mode: form.online_mode,
        modpack_id: modpack.id,
        modpack_name: modpack.name,
        modpack_source: modpack.source,
        modpack_version_id: form.version_id || undefined,
        mc_version: detectedMcVersions[0] || modpack.mcVersions?.[0] || null,
        loader_type: detectedLoaders[0] || 'forge',
        pregen_enabled: form.pregen_enabled,
        pregen_radius: form.pregen_radius,
        pregen_worlds: form.pregen_worlds,
      });
      addServer(server);
      if (iconFile) {
        uploadServerIcon(server.id, iconFile).catch(console.error);
      }
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
      toast.error(err.response?.data?.error || t('deploy.error'));
    }
  }

  function set(field, value) {
    setForm(f => ({ ...f, [field]: value }));
  }

  if (!modpack) return null;

  const portConflict = portTakenBy(allServers, form.port);

  return (
    <Modal open={!!modpack} onClose={onClose} title={`${t('deploy.title')} : ${modpack?.name}`} size="lg">
      <div className="p-6">
        <form onSubmit={handleDeploy} className="space-y-5">

          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="label">{t('deploy.serverName')}</label>
              <div className="flex items-center gap-2">
                <IconPicker value={iconFile} onChange={setIconFile} />
                <input className="input flex-1" value={form.name} onChange={e => set('name', e.target.value)} required />
              </div>
            </div>
            <div>
              <label className="label">{t('deploy.port')}</label>
              <input
                className="input" type="number" min="1024" max="65535" value={form.port}
                onChange={e => set('port', +e.target.value)}
                style={portConflict ? { borderColor: 'rgba(var(--danger-rgb),0.6)' } : undefined}
              />
              {portConflict && (
                <p className="text-[11px] text-danger mt-1.5 fade-in">
                  {t('deploy.portTaken', { name: portConflict.name })}
                  <button type="button" className="ml-1.5 underline hover:no-underline" onClick={() => set('port', nextFreePort(allServers))}>
                    {t('deploy.useFreePort', { port: nextFreePort(allServers) })}
                  </button>
                </p>
              )}
            </div>
            <div>
              <label className="label">{t('deploy.maxPlayers')}</label>
              <input className="input" type="number" min="1" max="100" value={form.max_players} onChange={e => set('max_players', +e.target.value)} />
            </div>
          </div>

          {/* Version selector */}
          <div>
            <label className="label">{t('deploy.version')}</label>
            {versionsLoading ? (
              <div className="input text-fg-3 text-sm">{t('deploy.versionLoading')}</div>
            ) : versions.length === 0 ? (
              <div className="input text-fg-3 text-sm">{t('deploy.versionNone')}</div>
            ) : (
              <select className="input" value={form.version_id} onChange={e => set('version_id', e.target.value)}>
                {versions.map(v => {
                  const label = v.displayName || v.name || v.versionNumber || v.id;
                  const type = RELEASE_TYPE_LABEL[v.releaseType] || '';
                  const mcVer = (v.mcVersions || v.game_versions || []).filter(x => /^(1|2\d)\.\d+(\.\d+)?$/.test(x)).slice(0, 2).join(', ');
                  return (
                    <option key={v.id} value={String(v.id)}>
                      {label}{type ? ` [${type}]` : ''}{mcVer ? ` — MC ${mcVer}` : ''}
                    </option>
                  );
                })}
              </select>
            )}
          </div>

          {/* RAM slider */}
          <div>
            <div className="flex justify-between mb-1.5">
              <label className="label mb-0">{t('deploy.ram')}</label>
              <span className="text-sm font-semibold text-fg">
                {form.ram_mb >= 1024 ? `${form.ram_mb / 1024} Go` : `${form.ram_mb} Mo`}
              </span>
            </div>
            <input
              type="range" min="1024" max="32768" step="512"
              value={form.ram_mb}
              onChange={e => set('ram_mb', +e.target.value)}
              className="w-full"
              style={{ accentColor: 'var(--accent)' }}
            />
            <div className="flex justify-between text-[11px] text-fg-3 mt-1">
              <span>{t('deploy.ramMin')}</span><span>{t('deploy.ramMax')}</span>
            </div>
          </div>

          <div>
            <label className="label">{t('deploy.seed')}</label>
            <input className="input" value={form.seed} onChange={e => set('seed', e.target.value)} placeholder={t('deploy.seedPlaceholder')} />
          </div>

          {/* World import */}
          <div>
            <label className="label">
              {t('deploy.worldImportLabel')}
              <span className="ml-2 text-fg-3 font-normal normal-case tracking-normal">{t('deploy.worldImportHint')}</span>
            </label>
            <div
              className="rounded-xl p-4 text-center cursor-pointer transition-all duration-200"
              style={{
                border: `2px dashed ${worldFile ? 'rgba(var(--accent-rgb),0.4)' : 'rgba(var(--tint-rgb),0.1)'}`,
                background: worldFile ? 'rgba(var(--accent-rgb),0.04)' : 'transparent',
              }}
            >
              <input type="file" accept=".zip" className="hidden" id="world-upload"
                onChange={e => setWorldFile(e.target.files[0] || null)} />
              <label htmlFor="world-upload" className="cursor-pointer">
                {worldFile ? (
                  <div className="space-y-1">
                    <p className="text-accent text-sm font-medium">{worldFile.name}</p>
                    <p className="text-fg-3 text-xs">{(worldFile.size / 1024 / 1024).toFixed(1)} Mo</p>
                    <button type="button" className="text-xs text-danger hover:text-red-400 transition-colors"
                      onClick={e => { e.preventDefault(); setWorldFile(null); }}>
                      {t('deploy.worldRemove')}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Globe size={20} strokeWidth={1.5} className="mx-auto text-fg-3" />
                    <p className="text-sm text-fg-2">{t('deploy.worldImportClick')}</p>
                  </div>
                )}
              </label>
            </div>
          </div>

          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" className="w-4 h-4 rounded" checked={form.whitelist_enabled}
                onChange={e => set('whitelist_enabled', e.target.checked)}
                style={{ accentColor: 'var(--accent)' }} />
              <span className="text-sm text-fg-2">{t('deploy.whitelist')}</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer ml-auto">
              <input type="checkbox" className="w-4 h-4 rounded" checked={form.online_mode}
                onChange={e => set('online_mode', e.target.checked)}
                style={{ accentColor: 'var(--accent)' }} />
              <span className="text-sm text-fg-2">{t('deploy.onlineMode')}</span>
            </label>
          </div>

          <PregenOption form={form} set={set} />

          <button type="submit" className="btn-primary w-full justify-center py-2.5 gap-2" disabled={deploying || !!portConflict}>
            <Rocket size={14} strokeWidth={1.5} />
            {deploying ? t('deploy.deploying') : t('deploy.deploy')}
          </button>
        </form>
      </div>
    </Modal>
  );
}
