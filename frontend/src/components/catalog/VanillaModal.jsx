import React, { useState, useEffect, useMemo } from 'react';
import Modal from '../ui/Modal';
import Segmented from '../ui/Segmented';
import { createServer, getVanillaVersions } from '../../services/api';
import { getServerTypeVersions } from '../../services/features/server-types';
import { queueUploads } from '../../services/pendingUploads';
import { useServerStore } from '../../store';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../../i18n';
import toast from 'react-hot-toast';
import { Rocket, Globe } from 'lucide-react';
import IconPicker from '../ui/IconPicker';
import PregenOption from './PregenOption';
import { nextFreePort, portTakenBy } from '../../utils/ports';

const VERSION_TYPES = [
  { value: 'release', label: 'Release' },
  { value: 'snapshot', label: 'Snapshot' },
  { value: 'all', label: 'Tout' },
];

const SERVER_TYPES = ['vanilla', 'paper', 'purpur'];

export default function VanillaModal({ open, onClose }) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { addServer } = useServerStore();
  const allServers = useServerStore(s => s.servers);

  const [serverType, setServerType] = useState('vanilla');
  const [versionType, setVersionType] = useState('release');
  const [form, setForm] = useState({
    pregen_enabled: false,
    pregen_radius: 3000,
    pregen_worlds: ['minecraft:overworld'],
    name: 'Vanilla Server',
    mc_version: '',
    port: nextFreePort(allServers),
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

  const activeVersionType = serverType === 'vanilla' ? versionType : 'release';

  const { data: vanillaData, isLoading: vanillaLoading } = useQuery({
    queryKey: ['vanilla-versions', activeVersionType],
    queryFn: () => getVanillaVersions(activeVersionType),
    staleTime: 600000,
    enabled: open,
  });

  const {
    data: typeData,
    isLoading: typeLoading,
    isError: typeError,
  } = useQuery({
    queryKey: ['server-type-versions', serverType],
    queryFn: () => getServerTypeVersions(serverType),
    staleTime: 3600000,
    enabled: open && serverType !== 'vanilla',
    retry: 1,
  });

  const versions = useMemo(() => {
    const vanillaVersions = vanillaData?.versions || [];
    if (serverType === 'vanilla') return vanillaVersions;
    const supported = typeData?.versions || [];
    if (!supported.length) return [];
    if (!vanillaVersions.length) return supported.map(id => ({ id, type: 'release' }));
    const supportedSet = new Set(supported);
    const filtered = vanillaVersions.filter(v => supportedSet.has(v.id));
    return filtered.length > 0 ? filtered : supported.map(id => ({ id, type: 'release' }));
  }, [serverType, vanillaData, typeData]);

  const versionsLoading = serverType === 'vanilla'
    ? vanillaLoading
    : (typeLoading || (vanillaLoading && !typeData?.versions?.length));

  const latestRelease = serverType === 'vanilla'
    ? (vanillaData?.latest?.release || '')
    : (versions[0]?.id || '');

  const effectiveMcVersion = form.mc_version || latestRelease || '';
  const typeLabel = t(`serverTypes.${serverType}`);

  function set(field, value) {
    setForm(f => ({ ...f, [field]: value }));
  }

  function handleServerTypeChange(nextType) {
    setServerType(nextType);
    if (nextType !== 'vanilla') setVersionType('release');
    setForm(f => {
      const defaultNames = new Set(SERVER_TYPES.map(id => t('serverTypes.defaultName', { type: t(`serverTypes.${id}`) })));
      const nextDefault = t('serverTypes.defaultName', { type: t(`serverTypes.${nextType}`) });
      return {
        ...f,
        mc_version: '',
        name: defaultNames.has(f.name) || !f.name ? nextDefault : f.name,
      };
    });
  }

  async function handleDeploy(e) {
    e.preventDefault();
    if (!effectiveMcVersion) return toast.error('Sélectionnez une version Minecraft');
    setDeploying(true);
    try {
      const server = await createServer({
        name: form.name,
        loader_type: serverType,
        modpack_source: 'vanilla',
        pregen_enabled: form.pregen_enabled,
        pregen_radius: form.pregen_radius,
        pregen_worlds: form.pregen_worlds,
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
      queueUploads(server.id, { icon: iconFile, world: worldFile });
      onClose();
      navigate(`/servers/${server.id}`);
    } catch (err) {
      setDeploying(false);
      toast.error(err.response?.data?.error || t('deploy.error'));
    }
  }

  useEffect(() => {
    if (open && portTakenBy(allServers, form.port)) set('port', nextFreePort(allServers));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const portConflict = portTakenBy(allServers, form.port);

  return (
    <Modal open={open} onClose={onClose} title={t('serverTypes.modalTitle', { type: typeLabel })} size="lg">
      <div className="p-6">
        <form onSubmit={handleDeploy} className="space-y-5">

          {/* Type de serveur */}
          <div>
            {/* Groupe de boutons : intitulé relié par aria-labelledby (un <label> ne peut pas viser un groupe) */}
            <p className="label" id="vanilla-server-type-label">{t('serverTypes.label')}</p>
            <div role="group" aria-labelledby="vanilla-server-type-label">
            <Segmented
              value={serverType}
              onChange={handleServerTypeChange}
              items={SERVER_TYPES.map(id => ({ id, label: t(`serverTypes.${id}`) }))}
              className="w-full [&>button]:flex-1"
            />
            </div>
            <p className="text-[11px] text-fg-3 mt-1.5">{t(`serverTypes.hint.${serverType}`)}</p>
          </div>

          {/* Version type tabs (Vanilla uniquement : Paper/Purpur ne publient que les releases) */}
          {serverType === 'vanilla' && (
            <div>
              <p className="label" id="vanilla-version-type-label">{t('serverTypes.versionType')}</p>
              <div className="flex gap-2" role="group" aria-labelledby="vanilla-version-type-label">
                {VERSION_TYPES.map(vt => (
                  <button
                    key={vt.value}
                    type="button"
                    onClick={() => { setVersionType(vt.value); set('mc_version', ''); }}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                    style={{
                      background: versionType === vt.value ? 'var(--accent)' : 'rgba(var(--tint-rgb),0.05)',
                      color: versionType === vt.value ? 'var(--bg)' : 'var(--fg-2)',
                      border: `1px solid ${versionType === vt.value ? 'var(--accent)' : 'rgba(var(--tint-rgb),0.08)'}`,
                    }}
                  >
                    {vt.label}
                  </button>
                ))}
              </div>
            </div>
          )}

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
              <input className="input" type="number" min="1" max="1000" value={form.max_players} onChange={e => set('max_players', +e.target.value)} />
            </div>
          </div>

          {/* MC Version */}
          <div>
            <label className="label" htmlFor="vanilla-mc-version">
              Version Minecraft
              {latestRelease && !form.mc_version && (
                <span className="ml-2 text-fg-3 font-normal normal-case tracking-normal">
                  — dernière : {latestRelease}
                </span>
              )}
            </label>
            {versionsLoading ? (
              <div className="input text-fg-3 text-sm">{t('common.loading')}</div>
            ) : serverType !== 'vanilla' && typeError ? (
              <p className="text-xs text-danger py-2">{t('serverTypes.versionsError', { type: typeLabel })}</p>
            ) : versions.length === 0 ? (
              <p className="text-xs text-fg-3 py-2">{t('serverTypes.noVersions')}</p>
            ) : (
              <select id="vanilla-mc-version" className="input" value={form.mc_version} onChange={e => set('mc_version', e.target.value)}>
                <option value="">Dernière version ({latestRelease})</option>
                {versions.map(v => (
                  <option key={v.id} value={v.id}>
                    {v.id}{v.type !== 'release' ? ` [${v.type}]` : ''}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* RAM */}
          <div>
            <div className="flex justify-between mb-1.5">
              <label className="label mb-0">{t('deploy.ram')}</label>
              <span className="text-sm font-semibold text-fg">
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
            <div className="flex justify-between text-[11px] text-fg-3 mt-1">
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
              <span className="ml-2 text-fg-3 font-normal normal-case tracking-normal">{t('deploy.worldImportHint')}</span>
            </label>
            <div
              className="rounded-xl p-4 text-center cursor-pointer transition-all duration-200"
              style={{
                border: `2px dashed ${worldFile ? 'rgba(var(--accent-rgb),0.4)' : 'rgba(var(--tint-rgb),0.1)'}`,
                background: worldFile ? 'rgba(var(--accent-rgb),0.04)' : 'transparent',
              }}
            >
              <input type="file" accept=".zip" className="hidden" id="vanilla-world-upload"
                onChange={e => setWorldFile(e.target.files[0] || null)} />
              <label htmlFor="vanilla-world-upload" className="cursor-pointer">
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
          <PregenOption form={form} set={set} vanilla={serverType === 'vanilla'} />

          <button type="submit" className="btn-primary w-full justify-center py-2.5 gap-2" disabled={deploying || !!portConflict || !effectiveMcVersion}>
            <Rocket size={14} strokeWidth={1.5} />
            {deploying ? t('deploy.deploying') : t('serverTypes.createBtn', { type: typeLabel })}
          </button>
        </form>
      </div>
    </Modal>
  );
}
