import React, { useState } from 'react';
import Modal from '../ui/Modal';
import { createServer, getVanillaVersions, uploadServerIcon } from '../../services/api';
import { useServerStore } from '../../store';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../../i18n';
import toast from 'react-hot-toast';
import { Rocket, Globe } from 'lucide-react';
import IconPicker from '../ui/IconPicker';

const VERSION_TYPES = [
  { value: 'release', label: 'Release' },
  { value: 'snapshot', label: 'Snapshot' },
  { value: 'all', label: 'Tout' },
];

export default function VanillaModal({ open, onClose }) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { addServer } = useServerStore();

  const [versionType, setVersionType] = useState('release');
  const [form, setForm] = useState({
    name: 'Vanilla Server',
    mc_version: '',
    port: 25565,
    ram_mb: 2048,
    max_players: 20,
    seed: '',
    whitelist_enabled: false,
    online_mode: true,
    difficulty: 'normal',
    view_distance: 10,
    spawn_protection: 16,
    motd: '',
  });
  const [worldFile, setWorldFile] = useState(null);
  const [iconFile, setIconFile] = useState(null);
  const [deploying, setDeploying] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['vanilla-versions', versionType],
    queryFn: () => getVanillaVersions(versionType),
    staleTime: 600000,
    enabled: open,
  });

  const versions = data?.versions || [];
  const latestRelease = data?.latest?.release;

  const effectiveMcVersion = form.mc_version || latestRelease || '';

  function set(field, value) {
    setForm(f => ({ ...f, [field]: value }));
  }

  async function handleDeploy(e) {
    e.preventDefault();
    if (!effectiveMcVersion) return toast.error('Sélectionnez une version Minecraft');
    setDeploying(true);
    try {
      const server = await createServer({
        name: form.name,
        loader_type: 'vanilla',
        mc_version: effectiveMcVersion,
        port: form.port,
        ram_mb: form.ram_mb,
        max_players: form.max_players,
        seed: form.seed || undefined,
        whitelist_enabled: form.whitelist_enabled,
        online_mode: form.online_mode,
        difficulty: form.difficulty,
        view_distance: form.view_distance,
        spawn_protection: form.spawn_protection,
        motd: form.motd || undefined,
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

  return (
    <Modal open={open} onClose={onClose} title="Créer un serveur Vanilla" size="lg">
      <div className="p-6">
        <form onSubmit={handleDeploy} className="space-y-5">

          {/* Version type tabs */}
          <div>
            <label className="label">Type de version</label>
            <div className="flex gap-2">
              {VERSION_TYPES.map(vt => (
                <button
                  key={vt.value}
                  type="button"
                  onClick={() => { setVersionType(vt.value); set('mc_version', ''); }}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                  style={{
                    background: versionType === vt.value ? 'var(--accent)' : 'rgba(255,255,255,0.05)',
                    color: versionType === vt.value ? 'var(--bg)' : '#6B6B76',
                    border: `1px solid ${versionType === vt.value ? 'var(--accent)' : 'rgba(255,255,255,0.08)'}`,
                  }}
                >
                  {vt.label}
                </button>
              ))}
            </div>
          </div>

          {/* MC Version */}
          <div>
            <label className="label">
              Version Minecraft
              {latestRelease && !form.mc_version && (
                <span className="ml-2 text-[#4A4A55] font-normal normal-case tracking-normal">
                  — dernière : {latestRelease}
                </span>
              )}
            </label>
            {isLoading ? (
              <div className="input text-[#4A4A55] text-sm">{t('common.loading')}</div>
            ) : (
              <select className="input" value={form.mc_version} onChange={e => set('mc_version', e.target.value)}>
                <option value="">Dernière version ({latestRelease})</option>
                {versions.map(v => (
                  <option key={v.id} value={v.id}>
                    {v.id}{v.type !== 'release' ? ` [${v.type}]` : ''}
                  </option>
                ))}
              </select>
            )}
          </div>

          <IconPicker value={iconFile} onChange={setIconFile} />

          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="label">{t('deploy.serverName')}</label>
              <input className="input" value={form.name} onChange={e => set('name', e.target.value)} required />
            </div>
            <div>
              <label className="label">{t('deploy.port')}</label>
              <input className="input" type="number" min="1024" max="65535" value={form.port} onChange={e => set('port', +e.target.value)} />
            </div>
            <div>
              <label className="label">{t('deploy.maxPlayers')}</label>
              <input className="input" type="number" min="1" max="1000" value={form.max_players} onChange={e => set('max_players', +e.target.value)} />
            </div>
          </div>

          {/* RAM */}
          <div>
            <div className="flex justify-between mb-1.5">
              <label className="label mb-0">{t('deploy.ram')}</label>
              <span className="text-sm font-semibold text-[#F0F0F0]">
                {form.ram_mb >= 1024 ? `${form.ram_mb / 1024} Go` : `${form.ram_mb} Mo`}
              </span>
            </div>
            <input
              type="range" min="512" max="32768" step="512"
              value={form.ram_mb}
              onChange={e => set('ram_mb', +e.target.value)}
              className="w-full"
              style={{ accentColor: 'var(--accent)' }}
            />
            <div className="flex justify-between text-[11px] text-[#4A4A55] mt-1">
              <span>512 Mo</span><span>32 Go</span>
            </div>
          </div>

          {/* MOTD */}
          <div>
            <label className="label">{t('server.settings.motd')}</label>
            <input className="input" value={form.motd} onChange={e => set('motd', e.target.value)} placeholder={`${form.name} — Powered by Craftarr`} />
          </div>

          <div className="grid grid-cols-3 gap-4">
            {/* Difficulty */}
            <div>
              <label className="label">{t('server.settings.difficulty')}</label>
              <select className="input" value={form.difficulty} onChange={e => set('difficulty', e.target.value)}>
                <option value="peaceful">{t('server.settings.difficultyPeaceful')}</option>
                <option value="easy">{t('server.settings.difficultyEasy')}</option>
                <option value="normal">{t('server.settings.difficultyNormal')}</option>
                <option value="hard">{t('server.settings.difficultyHard')}</option>
              </select>
            </div>
            {/* View distance */}
            <div>
              <label className="label">{t('server.settings.viewDistance')}</label>
              <input className="input" type="number" min="2" max="32" value={form.view_distance} onChange={e => set('view_distance', +e.target.value)} />
            </div>
            {/* Spawn protection */}
            <div>
              <label className="label">{t('server.settings.spawnProtection')}</label>
              <input className="input" type="number" min="0" max="100" value={form.spawn_protection} onChange={e => set('spawn_protection', +e.target.value)} />
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
              <span className="ml-2 text-[#4A4A55] font-normal normal-case tracking-normal">{t('deploy.worldImportHint')}</span>
            </label>
            <div
              className="rounded-xl p-4 text-center cursor-pointer transition-all duration-200"
              style={{
                border: `2px dashed ${worldFile ? 'rgba(74,222,128,0.4)' : 'rgba(255,255,255,0.1)'}`,
                background: worldFile ? 'rgba(74,222,128,0.04)' : 'transparent',
              }}
            >
              <input type="file" accept=".zip" className="hidden" id="vanilla-world-upload"
                onChange={e => setWorldFile(e.target.files[0] || null)} />
              <label htmlFor="vanilla-world-upload" className="cursor-pointer">
                {worldFile ? (
                  <div className="space-y-1">
                    <p className="text-[#4ADE80] text-sm font-medium">{worldFile.name}</p>
                    <p className="text-[#4A4A55] text-xs">{(worldFile.size / 1024 / 1024).toFixed(1)} Mo</p>
                    <button type="button" className="text-xs text-[#F87171] hover:text-red-400 transition-colors"
                      onClick={e => { e.preventDefault(); setWorldFile(null); }}>
                      {t('deploy.worldRemove')}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Globe size={20} strokeWidth={1.5} className="mx-auto text-[#4A4A55]" />
                    <p className="text-sm text-[#6B6B76]">{t('deploy.worldImportClick')}</p>
                  </div>
                )}
              </label>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" className="w-4 h-4 rounded" checked={form.whitelist_enabled}
                onChange={e => set('whitelist_enabled', e.target.checked)}
                style={{ accentColor: 'var(--accent)' }} />
              <span className="text-sm text-[#6B6B76]">{t('deploy.whitelist')}</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" className="w-4 h-4 rounded" checked={form.online_mode}
                onChange={e => set('online_mode', e.target.checked)}
                style={{ accentColor: 'var(--accent)' }} />
              <div className="flex flex-col">
                <span className="text-sm text-[#6B6B76]">{t('deploy.onlineMode')}</span>
                <span className="text-[11px] text-[#4A4A55]">
                  {form.online_mode ? t('deploy.onlineModeOn') : t('deploy.onlineModeOff')}
                </span>
              </div>
            </label>
          </div>

          <button type="submit" className="btn-primary w-full justify-center py-2.5 gap-2" disabled={deploying}>
            <Rocket size={14} strokeWidth={1.5} />
            {deploying ? t('deploy.deploying') : 'Créer le serveur Vanilla'}
          </button>
        </form>
      </div>
    </Modal>
  );
}
