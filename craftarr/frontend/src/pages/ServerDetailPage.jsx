import React, { useState } from 'react';
import { useI18n } from '../i18n';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getServer, startServer, stopServer, restartServer, deleteServer,
  updateServer, importWorld, getModpackVersions, patchServer, recreateContainer, installMods,
  uploadServerIcon, getServerIconUrl,
} from '../services/api';
import { useServerStore, useIconStore } from '../store';
import StatusBadge from '../components/ui/StatusBadge';
import Console from '../components/servers/Console';
import MetricsPanel from '../components/servers/MetricsPanel';
import BackupList from '../components/servers/BackupList';
import FileExplorer from '../components/servers/FileExplorer';
import Modal from '../components/ui/Modal';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import {
  Terminal, Activity, HardDrive, FolderOpen, Settings as SettingsIcon,
  Play, Square, RotateCcw, Upload, Trash2, ArrowUp, Package, Globe,
  AlertTriangle, Save, Users, Pencil,
} from 'lucide-react';
import PlayersPanel from '../components/servers/PlayersPanel';
import WhitelistPanel from '../components/servers/WhitelistPanel';
import { Shield } from 'lucide-react';

// Stable English IDs — never change, only labelKey is translated
const TABS = [
  { id: 'console',   Icon: Terminal,     labelKey: 'server.tabs.console'   },
  { id: 'metrics',   Icon: Activity,     labelKey: 'server.tabs.metrics'   },
  { id: 'backups',   Icon: HardDrive,    labelKey: 'server.tabs.backups'   },
  { id: 'files',     Icon: FolderOpen,   labelKey: 'server.tabs.files'     },
  { id: 'players',   Icon: Users,        labelKey: 'server.tabs.players'   },
  { id: 'whitelist', Icon: Shield,       labelKey: 'server.tabs.whitelist' },
  { id: 'settings',  Icon: SettingsIcon, labelKey: 'server.tabs.settings'  },
];

const RELEASE_TYPE_LABEL = { 1: 'Release', 2: 'Beta', 3: 'Alpha' };
const CONTAINER_ENV_FIELDS = new Set(['port', 'ram_mb', 'max_players', 'whitelist_enabled', 'motd', 'seed', 'difficulty', 'view_distance', 'spawn_protection']);

// ─── UpdateModal ──────────────────────────────────────────────────────────────
function UpdateModal({ server, onClose }) {
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
          <p className="text-[#6B6B76] text-xs uppercase tracking-[0.08em]">{t('update.currentVersion')}</p>
          <p className="font-medium text-[#F0F0F0]">{server.modpack_version || t('serverSettings.unknown')}</p>
        </div>
        <div>
          <label className="label">{t('update.targetVersion')}</label>
          {isLoading ? (
            <div className="input text-[#4A4A55] text-sm animate-pulse">{t('update.loadingVersions')}</div>
          ) : (
            <select className="input" value={selectedVersionId} onChange={e => setSelectedVersionId(e.target.value)}>
              <option value="">{t('update.latestAvailable')}</option>
              {versions.map((v) => {
                const label = v.displayName || v.name || v.versionNumber || v.id;
                const type = RELEASE_TYPE_LABEL[v.releaseType] || '';
                const mcVer = (v.mcVersions || v.game_versions || []).filter(x => /^1\.\d+/.test(x)).slice(0, 2).join(', ');
                const isCurrent = String(v.id) === String(server.modpack_version_id);
                return (
                  <option key={v.id} value={String(v.id)}>
                    {isCurrent ? '> ' : ''}{label}{type ? ` [${type}]` : ''}{mcVer ? ` — MC ${mcVer}` : ''}{isCurrent ? ` ${t('update.currentLabel')}` : ''}
                  </option>
                );
              })}
            </select>
          )}
          <p className="text-xs text-[#6B6B76] mt-1">{t('update.backupNote')}</p>
        </div>
        <div className="flex gap-3 pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
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

// ─── WorldImportModal ─────────────────────────────────────────────────────────
function WorldImportModal({ server, onClose }) {
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
        <p className="text-sm text-[#6B6B76]">{t('worldImport.description')}</p>
        <div
          className="rounded-xl p-6 text-center cursor-pointer transition-all duration-200"
          style={{
            border: `2px dashed ${file ? 'rgba(74,222,128,0.4)' : 'rgba(255,255,255,0.1)'}`,
            background: file ? 'rgba(74,222,128,0.04)' : 'transparent',
          }}
        >
          <input type="file" accept=".zip" id="world-import-file" className="hidden"
            onChange={e => setFile(e.target.files[0] || null)} />
          <label htmlFor="world-import-file" className="cursor-pointer">
            {file ? (
              <div className="space-y-1">
                <p className="text-[#4ADE80] font-medium text-sm">{file.name}</p>
                <p className="text-[#6B6B76] text-xs">{(file.size / 1024 / 1024).toFixed(1)} Mo</p>
              </div>
            ) : (
              <div className="space-y-2">
                <Globe size={22} strokeWidth={1.5} className="mx-auto text-[#4A4A55]" />
                <p className="text-sm text-[#6B6B76]">{t('worldImport.selectFile')}</p>
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

function resizeTo64(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        canvas.getContext('2d').drawImage(img, 0, 0, 64, 64);
        URL.revokeObjectURL(url);
        canvas.toBlob(blob => blob ? resolve(new File([blob], 'server-icon.png', { type: 'image/png' })) : reject(new Error('Canvas toBlob failed')), 'image/png');
      } catch (e) { reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Invalid image')); };
    img.src = url;
  });
}

function SectionTitle({ children }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#6B6B76]">{children}</h3>
  );
}

function EditTab({ server, onInstallMods, onWorldImport }) {
  const qc = useQueryClient();
  const { t } = useI18n();
  const { updateServer: patchStore } = useServerStore();
  const bumpIcon = useIconStore(s => s.bumpIcon);

  const [form, setForm] = useState({
    name: server.name,
    port: server.port,
    ram_mb: server.ram_mb,
    max_players: server.max_players,
    whitelist_enabled: server.whitelist_enabled,
    auto_update: server.auto_update,
    update_interval_hours: server.update_interval_hours || 6,
    motd: server.motd || '',
    seed: server.seed || '',
    difficulty: server.difficulty || 'normal',
    view_distance: server.view_distance || 10,
    spawn_protection: server.spawn_protection ?? 16,
  });
  const [iconPreview, setIconPreview] = useState(null);
  const [iconFile, setIconFile] = useState(null);
  const [iconUploading, setIconUploading] = useState(false);
  const [iconKey, setIconKey] = useState(Date.now());
  const [recreating, setRecreating] = useState(false);

  const isRunning = server.status === 'running' || server.status === 'starting';
  const isStopped = server.status === 'stopped' || server.status === 'error';

  function set(field, value) {
    setForm(f => ({ ...f, [field]: value }));
  }

  const saveMut = useMutation({
    mutationFn: () => patchServer(server.id, form),
    onSuccess: async (updated) => {
      patchStore(server.id, updated);
      qc.invalidateQueries({ queryKey: ['server', server.id] });
      const envChanged = Object.keys(form).some(
        k => CONTAINER_ENV_FIELDS.has(k) && form[k] !== (server[k] ?? '')
      );
      if (envChanged && isStopped && updated.container_id) {
        setRecreating(true);
        try {
          await recreateContainer(server.id);
          toast.success(t('server.settings.savedRecreated'));
          patchStore(server.id, { status: 'starting' });
          qc.invalidateQueries({ queryKey: ['server', server.id] });
        } catch (err) {
          toast.error(t('server.settings.recreateError') + ': ' + (err.response?.data?.error || err.message));
        } finally {
          setRecreating(false);
        }
      } else if (envChanged && isRunning) {
        toast.success(t('server.settings.savedNeedRecreate'));
      } else {
        toast.success(t('server.settings.saved'));
      }
    },
    onError: (err) => toast.error(err.response?.data?.error || t('server.settings.saveError')),
  });

  function handleIconChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setIconFile(file);
    const reader = new FileReader();
    reader.onload = ev => setIconPreview(ev.target.result);
    reader.readAsDataURL(file);
  }

  async function handleIconUpload() {
    if (!iconFile) return;
    setIconUploading(true);
    try {
      const resized = await resizeTo64(iconFile);
      await uploadServerIcon(server.id, resized);
      const v = Date.now();
      setIconKey(v);
      bumpIcon(server.id);
      toast.success(t('server.settings.iconUpdated'));
      setIconPreview(null);
      setIconFile(null);
    } catch (err) {
      toast.error(err.response?.data?.error || err.message || t('server.settings.iconError'));
    } finally {
      setIconUploading(false);
    }
  }

  const isSaving = saveMut.isPending || recreating;

  return (
    <div className="max-w-xl space-y-7 pt-1 pb-8">

      {isRunning && (
        <div
          className="flex items-start gap-3 rounded-xl px-4 py-3 text-sm"
          style={{ background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.2)', color: '#FBBF24' }}
        >
          <AlertTriangle size={15} strokeWidth={1.5} className="shrink-0 mt-0.5" />
          <span>{t('server.settings.runningWarning')}</span>
        </div>
      )}

      <div className="space-y-3">
        <SectionTitle>{t('server.settings.identity')}</SectionTitle>
        <div>
          <label className="label">{t('server.settings.serverName')}</label>
          <input className="input" value={form.name} onChange={e => set('name', e.target.value)} />
        </div>
      </div>

      <div className="space-y-3">
        <SectionTitle>{t('server.settings.appearance')}</SectionTitle>
        <div className="card space-y-4">
          <div className="flex items-start gap-4">
            <div className="flex-shrink-0 flex flex-col items-center gap-1">
              <div
                className="w-16 h-16 rounded-xl overflow-hidden flex items-center justify-center"
                style={{ background: '#1C1C21', border: '1px solid rgba(255,255,255,0.08)' }}
              >
                {iconPreview
                  ? <img src={iconPreview} alt="" className="w-full h-full object-cover" />
                  : <img
                      key={iconKey}
                      src={`${getServerIconUrl(server.id)}?v=${iconKey}`}
                      alt=""
                      className="w-full h-full object-cover"
                      onError={e => { e.currentTarget.style.display = 'none'; e.currentTarget.nextSibling.style.display = 'flex'; }}
                    />
                }
                <span
                  style={{ display: 'none' }}
                  className="w-full h-full items-center justify-center text-lg text-[#4A4A55] font-bold"
                >
                  {server.name?.[0]?.toUpperCase() || 'S'}
                </span>
              </div>
              <span className="text-[10px] text-[#4A4A55]">64×64 PNG</span>
            </div>
            <div className="flex-1 space-y-2">
              <label className="label">{t('server.settings.icon')}</label>
              <input
                type="file" accept="image/png,image/jpeg"
                onChange={handleIconChange}
                className="block w-full text-sm text-[#6B6B76] file:mr-3 file:py-1 file:px-3 file:rounded-lg file:border-0 file:text-xs file:bg-[#1C1C21] file:text-[#6B6B76] hover:file:text-[#F0F0F0] cursor-pointer"
              />
              {iconFile && (
                <button className="btn-primary text-xs py-1.5 px-3 gap-1.5" onClick={handleIconUpload} disabled={iconUploading}>
                  <Upload size={11} strokeWidth={1.5} />
                  {iconUploading ? t('server.settings.uploading') : t('server.settings.upload')}
                </button>
              )}
              <p className="text-[11px] text-[#4A4A55]">{t('server.settings.iconHint')}</p>
            </div>
          </div>

          <div>
            <label className="label">{t('server.settings.motd')}</label>
            <input
              className="input font-mono text-sm"
              value={form.motd}
              onChange={e => set('motd', e.target.value)}
              placeholder={`${server.name} — Powered by Craftarr`}
              maxLength={59}
            />
            <div className="flex justify-between mt-1">
              <p className="text-[11px] text-[#4A4A55]">{t('server.settings.motdSupports')}</p>
              <span className={clsx('text-[11px]', form.motd.length > 50 ? 'text-[#FBBF24]' : 'text-[#4A4A55]')}>
                {form.motd.length}/59
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <SectionTitle>{t('server.settings.network')}</SectionTitle>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">{t('server.settings.port')}</label>
            <input className="input" type="number" min="1024" max="65535" value={form.port}
              onChange={e => set('port', +e.target.value)} />
          </div>
          <div>
            <label className="label">{t('server.settings.maxPlayers')}</label>
            <input className="input" type="number" min="1" max="500" value={form.max_players}
              onChange={e => set('max_players', +e.target.value)} />
          </div>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" className="w-4 h-4 rounded" checked={form.whitelist_enabled}
            onChange={e => set('whitelist_enabled', e.target.checked)}
            style={{ accentColor: '#4ADE80' }} />
          <span className="text-sm text-[#6B6B76]">{t('server.settings.whitelist')}</span>
        </label>
      </div>

      <div className="space-y-3">
        <SectionTitle>{t('server.settings.gameplay')}</SectionTitle>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">{t('server.settings.difficulty')}</label>
            <select className="input" value={form.difficulty} onChange={e => set('difficulty', e.target.value)}>
              <option value="peaceful">{t('server.settings.difficultyPeaceful')}</option>
              <option value="easy">{t('server.settings.difficultyEasy')}</option>
              <option value="normal">{t('server.settings.difficultyNormal')}</option>
              <option value="hard">{t('server.settings.difficultyHard')}</option>
            </select>
          </div>
          <div>
            <label className="label">{t('server.settings.viewDistance')}</label>
            <div className="flex items-center gap-2">
              <input type="range" min="4" max="32" step="1" value={form.view_distance}
                onChange={e => set('view_distance', +e.target.value)} className="flex-1"
                style={{ accentColor: 'var(--accent)' }} />
              <span className="text-sm font-mono text-[#F0F0F0] w-8 text-right">{form.view_distance}</span>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">{t('server.settings.seed')}</label>
            <input className="input font-mono" value={form.seed}
              onChange={e => set('seed', e.target.value)}
              placeholder={t('server.settings.seedPlaceholder')} />
            <p className="text-[11px] text-[#4A4A55] mt-1">{t('server.settings.seedHint')}</p>
          </div>
          <div>
            <label className="label">{t('server.settings.spawnProtection')}</label>
            <input className="input" type="number" min="0" max="255" value={form.spawn_protection}
              onChange={e => set('spawn_protection', +e.target.value)} />
            <p className="text-[11px] text-[#4A4A55] mt-1">{t('server.settings.spawnHint')}</p>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <SectionTitle>{t('server.settings.resources')}</SectionTitle>
        <div>
          <div className="flex justify-between mb-2">
            <label className="label mb-0">{t('server.settings.ram')}</label>
            <span className="text-sm font-semibold text-[#F0F0F0]">
              {form.ram_mb >= 1024 ? `${form.ram_mb / 1024} Go` : `${form.ram_mb} Mo`}
            </span>
          </div>
          <input type="range" min="1024" max="32768" step="512" value={form.ram_mb}
            onChange={e => set('ram_mb', +e.target.value)} className="w-full"
            style={{ accentColor: '#4ADE80' }} />
          <div className="flex justify-between text-[11px] text-[#4A4A55] mt-1">
            <span>1 Go</span><span>8 Go</span><span>16 Go</span><span>32 Go</span>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <SectionTitle>{t('server.settings.autoUpdates')}</SectionTitle>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" className="w-4 h-4" checked={form.auto_update}
            onChange={e => set('auto_update', e.target.checked)}
            style={{ accentColor: '#4ADE80' }} />
          <span className="text-sm text-[#6B6B76]">{t('server.settings.enableAutoUpdate')}</span>
        </label>
        {form.auto_update && (
          <div className="flex items-center gap-3 pl-6">
            <label className="text-sm text-[#6B6B76]">{t('server.settings.checkEvery')}</label>
            <input className="input w-20 text-center" type="number" min="1" max="168" value={form.update_interval_hours}
              onChange={e => set('update_interval_hours', +e.target.value)} />
            <span className="text-sm text-[#6B6B76]">{t('server.settings.hours')}</span>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <SectionTitle>{t('server.settings.maintenance')}</SectionTitle>
        <div className="flex gap-3 flex-wrap">
          <button
            className="btn-secondary text-sm gap-2"
            onClick={() => {
              if (confirm(t('server.settings.downloadModsConfirm'))) {
                onInstallMods();
              }
            }}
          >
            <Package size={14} strokeWidth={1.5} />
            {t('server.settings.downloadMods')}
          </button>
          <button
            className="btn-secondary text-sm gap-2"
            onClick={onWorldImport}
          >
            <Globe size={14} strokeWidth={1.5} />
            {t('server.actions.importWorld')}
          </button>
        </div>
        <p className="text-[11px] text-[#4A4A55]">{t('server.settings.downloadModsHint')}</p>
      </div>

      <div
        className="sticky bottom-0 -mx-1 px-1 pt-4 pb-2 flex items-center gap-3"
        style={{ background: 'rgba(9,9,11,0.9)', backdropFilter: 'blur(8px)', borderTop: '1px solid rgba(255,255,255,0.06)' }}
      >
        <button
          className="btn-primary flex-1 gap-2 justify-center"
          onClick={() => saveMut.mutate()}
          disabled={isSaving}
        >
          <Save size={13} strokeWidth={1.5} />
          {isSaving
            ? recreating ? t('server.settings.applying') : t('server.settings.saving')
            : isStopped ? t('server.settings.saveAndApply') : t('server.settings.save')
          }
        </button>
        {isStopped && (
          <p className="text-[11px] text-[#4A4A55] flex-1">
            {t('server.settings.containerRecreateNote')}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── ServerDetailPage ─────────────────────────────────────────────────────────
export default function ServerDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { t } = useI18n();
  const [tab, setTab] = useState('console');
  const [showUpdate, setShowUpdate] = useState(false);
  const [showWorldImport, setShowWorldImport] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [headerName, setHeaderName] = useState('');
  const [headerIconKey, setHeaderIconKey] = useState(Date.now());
  const { updateServer: patchStore, removeServer } = useServerStore();
  const bumpIcon = useIconStore(s => s.bumpIcon);

  const { data: server, isLoading, isError } = useQuery({
    queryKey: ['server', id],
    queryFn: () => getServer(id),
    refetchInterval: 10000,
  });

  const startMut = useMutation({
    mutationFn: () => startServer(id),
    onSuccess: () => { toast.success(t('server.started')); patchStore(id, { status: 'starting' }); qc.invalidateQueries({ queryKey: ['server', id] }); },
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  const stopMut = useMutation({
    mutationFn: () => stopServer(id),
    onSuccess: () => { toast.success(t('server.stoppedMsg')); patchStore(id, { status: 'stopped' }); qc.invalidateQueries({ queryKey: ['server', id] }); },
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  const restartMut = useMutation({
    mutationFn: () => restartServer(id),
    onSuccess: () => { toast.success(t('server.restarted')); patchStore(id, { status: 'starting' }); },
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  const deleteMut = useMutation({
    mutationFn: () => deleteServer(id),
    onSuccess: () => { removeServer(id); navigate('/'); toast.success(t('server.deleted')); },
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  const installModsMut = useMutation({
    mutationFn: () => installMods(id),
    onSuccess: () => { toast.success(t('server.installModsLaunched')); qc.invalidateQueries({ queryKey: ['server', id] }); },
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  if (isLoading) return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center space-y-3">
        <div className="w-6 h-6 border border-[#F0F0F0] border-t-transparent rounded-full animate-spin mx-auto" style={{ borderTopColor: 'transparent' }} />
        <p className="text-[#6B6B76] text-sm">{t('common.loading')}</p>
      </div>
    </div>
  );

  if (isError || !server) return (
    <div className="flex items-center justify-center h-full text-[#6B6B76]">{t('server.notFound')}</div>
  );

  const isBusy = startMut.isPending || stopMut.isPending || restartMut.isPending;
  const canStart = ['stopped', 'error'].includes(server.status);
  const canStop = ['running', 'starting'].includes(server.status);
  const canUpdate = ['running', 'stopped'].includes(server.status);

  return (
    <div className="h-full flex flex-col">
      {/* ── Header ── */}
      <div
        className="px-6 pt-5 pb-0 flex-shrink-0"
        style={{ background: '#0D0D10', borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
          {/* Left: icon + title */}
          <div className="flex items-center gap-4">
            {/* Clickable icon */}
            <div className="relative flex-shrink-0" style={{ width: 44, height: 44 }}>
              <input
                type="file" accept="image/png,image/jpeg" id="header-icon-input" className="hidden"
                onChange={async e => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  try {
                    const resized = await resizeTo64(file);
                    await uploadServerIcon(server.id, resized);
                    const v = Date.now();
                    setHeaderIconKey(v);
                    bumpIcon(server.id);
                    toast.success(t('server.settings.iconUpdated'));
                  } catch (err) {
                    toast.error(err.response?.data?.error || t('server.settings.iconError'));
                  }
                  e.target.value = '';
                }}
              />
              <div
                className="w-full h-full rounded-xl overflow-hidden flex items-center justify-center text-base font-bold text-[#6B6B76]"
                style={{ background: '#1C1C21', border: '1px solid rgba(255,255,255,0.06)' }}
              >
                <img
                  key={headerIconKey}
                  src={`${getServerIconUrl(server.id)}?v=${headerIconKey}`}
                  alt=""
                  className="w-full h-full object-cover"
                  onError={e => { e.currentTarget.style.display = 'none'; e.currentTarget.nextSibling.style.display = 'block'; }}
                />
                <span style={{ display: 'none' }}>{server.name?.[0]?.toUpperCase() || 'S'}</span>
              </div>
              {/* Edit button always visible bottom-right */}
              <label
                htmlFor="header-icon-input"
                className="cursor-pointer absolute flex items-center justify-center rounded-full"
                style={{
                  width: 18, height: 18,
                  bottom: -4, right: -4,
                  background: 'var(--accent)',
                  border: '2px solid #0D0D10',
                }}
                title={t('server.settings.icon')}
              >
                <Pencil size={9} strokeWidth={2.5} style={{ color: '#000' }} />
              </label>
            </div>
            <div>
              <div className="flex items-center gap-3 flex-wrap">
                {editingName ? (
                  <input
                    autoFocus
                    className="text-base font-semibold text-[#F0F0F0] leading-tight bg-transparent border-b border-[#4A4A55] focus:border-[var(--accent)] outline-none w-48"
                    value={headerName}
                    onChange={e => setHeaderName(e.target.value)}
                    onBlur={async () => {
                      setEditingName(false);
                      const trimmed = headerName.trim();
                      if (trimmed && trimmed !== server.name) {
                        try {
                          const updated = await patchServer(server.id, { name: trimmed });
                          patchStore(server.id, updated);
                          qc.invalidateQueries({ queryKey: ['server', server.id] });
                          toast.success(t('server.settings.saved'));
                        } catch { toast.error(t('common.error')); }
                      }
                    }}
                    onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { setEditingName(false); } }}
                  />
                ) : (
                  <h1
                    className="text-base font-semibold text-[#F0F0F0] leading-tight cursor-pointer hover:text-white group/name flex items-center gap-1.5"
                    onClick={() => { setHeaderName(server.name); setEditingName(true); }}
                    title={t('server.settings.serverName')}
                  >
                    {server.name}
                    <Pencil size={11} strokeWidth={1.5} className="text-[#4A4A55] opacity-0 group-hover/name:opacity-100 transition-opacity" />
                  </h1>
                )}
                <StatusBadge status={server.status} />
              </div>
              <div className="flex gap-3 text-xs text-[#4A4A55] mt-0.5 flex-wrap font-mono">
                <span>{server.modpack_name}</span>
                {server.mc_version && <span>{server.mc_version}</span>}
                {server.loader_type && server.loader_type !== 'vanilla' && (
                  <span className="capitalize">{server.loader_type}</span>
                )}
                <span>:{server.port}</span>
                <span>{server.ram_mb >= 1024 ? `${server.ram_mb / 1024} Go` : `${server.ram_mb} Mo`}</span>
              </div>
            </div>
          </div>

          {/* Right: action buttons */}
          <div className="flex items-center gap-2 flex-wrap">
            {canStart && (
              <button className="btn-primary text-sm py-1.5 px-4 gap-2" onClick={() => startMut.mutate()} disabled={isBusy}>
                <Play size={13} strokeWidth={1.5} />
                {t('server.actions.start')}
              </button>
            )}
            {canStop && (
              <>
                <button className="btn-secondary text-sm py-1.5 px-4 gap-2" onClick={() => stopMut.mutate()} disabled={isBusy}>
                  <Square size={13} strokeWidth={1.5} />
                  {t('server.actions.stop')}
                </button>
                <button className="btn-secondary text-sm py-1.5 px-4 gap-2" onClick={() => restartMut.mutate()} disabled={isBusy}>
                  <RotateCcw size={13} strokeWidth={1.5} />
                  {t('server.actions.restart')}
                </button>
              </>
            )}
            {canUpdate && (
              <button className="btn-secondary text-sm py-1.5 px-4 gap-2" onClick={() => setShowUpdate(true)}>
                <ArrowUp size={13} strokeWidth={1.5} />
                {t('server.actions.update')}
              </button>
            )}
            <button
              className="btn-danger text-sm py-1.5 px-3"
              onClick={() => { if (confirm(t('server.deleteConfirm', { name: server.name }))) deleteMut.mutate(); }}
              disabled={deleteMut.isPending}
              title={t('server.actions.delete')}
            >
              <Trash2 size={14} strokeWidth={1.5} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-0.5">
          {TABS.map(({ id: tabId, Icon, labelKey }) => (
            <button
              key={tabId}
              onClick={() => setTab(tabId)}
              className={clsx(
                'flex items-center gap-2 px-4 py-2.5 text-xs font-medium transition-all duration-200 border-b-2',
                tab === tabId
                  ? 'border-[#F0F0F0] text-[#F0F0F0]'
                  : 'border-transparent text-[#6B6B76] hover:text-[#F0F0F0]'
              )}
            >
              <Icon size={14} strokeWidth={1.5} />
              <span className="uppercase tracking-[0.06em]">{t(labelKey)}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Content ── */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className={clsx('h-full', tab !== 'console' && 'hidden')}>
          <Console server={server} />
        </div>
        {tab === 'metrics' && (
          <div className="p-6">
            <MetricsPanel server={server} />
          </div>
        )}
        {tab === 'backups' && (
          <div className="p-6">
            <BackupList server={server} />
          </div>
        )}
        {tab === 'files' && (
          <div className="h-full">
            <FileExplorer server={server} />
          </div>
        )}
        {tab === 'players' && (
          <div className="p-6">
            <PlayersPanel server={server} />
          </div>
        )}
        {tab === 'whitelist' && (
          <div className="p-6">
            <WhitelistPanel server={server} />
          </div>
        )}
        {tab === 'settings' && (
          <div className="p-6">
            <EditTab server={server} onInstallMods={() => installModsMut.mutate()} onWorldImport={() => setShowWorldImport(true)} />
          </div>
        )}
      </div>

      {showUpdate && <UpdateModal server={server} onClose={() => setShowUpdate(false)} />}
      {showWorldImport && <WorldImportModal server={server} onClose={() => setShowWorldImport(false)} />}
    </div>
  );
}
