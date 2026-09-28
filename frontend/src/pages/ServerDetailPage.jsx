import React, { useState, useEffect } from 'react';
import { useI18n } from '../i18n';
import { useParams, useNavigate } from 'react-router-dom';
import { getSocket } from '../hooks/useSocket';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getServer, startServer, stopServer, restartServer, deleteServer,
  updateServer, importWorld, getModpackVersions, patchServer, recreateContainer, installMods, restartPregen,
  reinstallServer, uploadServerIcon, getServerIconUrl, downloadWorld,
} from '../services/api';
import { useServerStore, useIconStore } from '../store';
import StatusBadge from '../components/ui/StatusBadge';
import Console from '../components/servers/Console';
import MetricsPanel from '../components/servers/MetricsPanel';
import BackupList from '../components/servers/BackupList';
import FileExplorer from '../components/servers/FileExplorer';
import Modal from '../components/ui/Modal';
import Segmented from '../components/ui/Segmented';
import Switch from '../components/ui/Switch';
import PregenStatus from '../components/servers/PregenStatus';
import ServerAvatar from '../components/ui/ServerAvatar';
import ErrorBoundary from '../components/ui/ErrorBoundary';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import {
  Terminal, Activity, HardDrive, FolderOpen, Settings as SettingsIcon,
  Play, Square, RotateCcw, Upload, Trash2, ArrowUp, Package, Globe,
  AlertTriangle, Save, Users, Pencil, Download, Copy, Wifi, Gamepad2, Layers3, MemoryStick, ChevronRight,
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
          <p className="text-fg-2 text-xs uppercase tracking-[0.08em]">{t('update.currentVersion')}</p>
          <p className="font-medium text-fg">{server.modpack_version || t('serverSettings.unknown')}</p>
        </div>
        <div>
          <label className="label">{t('update.targetVersion')}</label>
          {isLoading ? (
            <div className="input text-fg-3 text-sm animate-pulse">{t('update.loadingVersions')}</div>
          ) : (
            <select className="input" value={selectedVersionId} onChange={e => setSelectedVersionId(e.target.value)}>
              <option value="">{t('update.latestAvailable')}</option>
              {versions.map((v) => {
                const label = v.displayName || v.name || v.versionNumber || v.id;
                const type = RELEASE_TYPE_LABEL[v.releaseType] || '';
                const mcVer = (v.mcVersions || v.game_versions || []).filter(x => /^(1|2[6-9])\.\d+/.test(x)).slice(0, 2).join(', ');
                const isCurrent = String(v.id) === String(server.modpack_version_id);
                return (
                  <option key={v.id} value={String(v.id)}>
                    {isCurrent ? '> ' : ''}{label}{type ? ` [${type}]` : ''}{mcVer ? ` — MC ${mcVer}` : ''}{isCurrent ? ` ${t('update.currentLabel')}` : ''}
                  </option>
                );
              })}
            </select>
          )}
          <p className="text-xs text-fg-2 mt-1">{t('update.backupNote')}</p>
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
        <p className="text-sm text-fg-2">{t('worldImport.description')}</p>
        <div
          className="rounded-xl p-6 text-center cursor-pointer transition-all duration-200"
          style={{
            border: `2px dashed ${file ? 'rgba(var(--accent-rgb),0.4)' : 'rgba(255,255,255,0.1)'}`,
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

function Group({ title, footer, children }) {
  return (
    <section className="space-y-2">
      {title && <h3 className="eyebrow px-4">{title}</h3>}
      <div className="card !p-0 overflow-hidden divide-y divide-white/[0.06]">{children}</div>
      {footer && <p className="text-[11.5px] text-fg-3 px-4 leading-relaxed">{footer}</p>}
    </section>
  );
}

function Row({ label, hint, children, stacked }) {
  return (
    <div className={clsx('px-4 py-3 min-h-[52px]', stacked ? 'space-y-2.5' : 'flex items-center justify-between gap-4')}>
      <div className="min-w-0">
        <p className="text-[14px] text-fg">{label}</p>
        {hint && <p className="text-[11.5px] text-fg-3 mt-0.5">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

const compactInput = 'h-9 w-28 px-3 rounded-xl bg-[rgba(118,118,128,0.18)] border border-transparent text-right text-[14px] text-fg outline-none focus:border-white/20 font-mono';

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
    pregen_enabled: !!server.pregen_enabled,
    pregen_radius: server.pregen_radius || 3000,
    pregen_pause_players: server.pregen_pause_players !== false,
  });
  const [restartingPregen, setRestartingPregen] = useState(false);
  const [base, setBase] = useState(form);
  const dirty = JSON.stringify(form) !== JSON.stringify(base);
  const [iconPreview, setIconPreview] = useState(null);
  const [iconFile, setIconFile] = useState(null);
  const [iconUploading, setIconUploading] = useState(false);
  const iconKey = useIconStore(s => s.versions[server.id] || 1);
  const [recreating, setRecreating] = useState(false);
  const [downloadingWorld, setDownloadingWorld] = useState(false);

  const isRunning = server.status === 'running' || server.status === 'starting';
  const isStopped = server.status === 'stopped' || server.status === 'error';

  function set(field, value) {
    setForm(f => ({ ...f, [field]: value }));
  }

  const saveMut = useMutation({
    mutationFn: () => patchServer(server.id, form),
    onSuccess: async (updated) => {
      if (updated.pregenError) {
        toast.error(t('pregen.enableFailed', { error: updated.pregenError }));
        const fixed = { ...form, pregen_enabled: false };
        setForm(fixed);
        setBase(fixed);
      } else {
        setBase(form);
      }
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
  const ramLabel = form.ram_mb >= 1024 ? `${+(form.ram_mb / 1024).toFixed(1)} Go` : `${form.ram_mb} Mo`;

  return (
    <div className="max-w-2xl space-y-7 pt-1 pb-24">

      {isRunning && (
        <div
          className="flex items-start gap-3 rounded-2xl px-4 py-3 text-[13px]"
          style={{ background: 'rgba(var(--warn-rgb),0.08)', border: '1px solid rgba(var(--warn-rgb),0.2)', color: 'var(--warn)' }}
        >
          <AlertTriangle size={15} strokeWidth={1.75} className="shrink-0 mt-0.5" />
          <span>{t('server.settings.runningWarning')}</span>
        </div>
      )}

      <Group title={t('server.settings.appearance')} footer={t('server.settings.motdSupports')}>
        <div className="flex items-center gap-4 px-4 py-4">
          <div className="relative shrink-0">
            <input type="file" accept="image/png,image/jpeg" id="settings-icon-input" className="hidden" onChange={handleIconChange} />
            <div className="w-16 h-16 rounded-[18px] overflow-hidden flex items-center justify-center bg-white/[0.06] border border-white/[0.08]">
              {iconPreview
                ? <img src={iconPreview} alt="" className="w-full h-full object-cover" style={{ imageRendering: 'pixelated' }} />
                : <img
                    key={iconKey}
                    src={`${getServerIconUrl(server.id)}?v=${iconKey}`}
                    alt=""
                    className="w-full h-full object-cover"
                    style={{ imageRendering: 'pixelated' }}
                    onError={e => { e.currentTarget.style.display = 'none'; e.currentTarget.nextSibling.style.display = 'flex'; }}
                  />
              }
              <span style={{ display: 'none' }} className="w-full h-full items-center justify-center text-lg text-fg-3 font-bold">
                {server.name?.[0]?.toUpperCase() || 'S'}
              </span>
            </div>
            <label
              htmlFor="settings-icon-input"
              className="cursor-pointer absolute -bottom-1 -right-1 w-6 h-6 flex items-center justify-center rounded-full bg-fg text-black hover:scale-110 transition-transform"
              style={{ boxShadow: '0 0 0 3px rgba(30,30,36,1)' }}
              title={t('server.settings.icon')}
            >
              <Pencil size={11} strokeWidth={2.5} />
            </label>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] text-fg">{t('server.settings.icon')}</p>
            <p className="text-[11.5px] text-fg-3 mt-0.5">PNG · 64×64 px</p>
          </div>
          {iconFile && (
            <button className="btn-primary !h-8 pop-in" onClick={handleIconUpload} disabled={iconUploading}>
              <Upload size={12} strokeWidth={2} />
              {iconUploading ? t('server.settings.uploading') : t('server.settings.upload')}
            </button>
          )}
        </div>
        <Row label={t('server.settings.motd')} stacked>
          <div className="relative">
            <input
              className="input font-mono text-sm pr-14"
              value={form.motd}
              onChange={e => set('motd', e.target.value)}
              placeholder={`${server.name} — Powered by Craftarr`}
              maxLength={59}
            />
            <span className={clsx('absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-mono', form.motd.length > 50 ? 'text-warn' : 'text-fg-3')}>
              {form.motd.length}/59
            </span>
          </div>
        </Row>
      </Group>

      <Group title={t('server.settings.network')}>
        <Row label={t('server.settings.port')}>
          <input className={compactInput} type="number" min="1024" max="65535" value={form.port} onChange={e => set('port', +e.target.value)} />
        </Row>
        <Row label={t('server.settings.maxPlayers')}>
          <input className={compactInput} type="number" min="1" max="500" value={form.max_players} onChange={e => set('max_players', +e.target.value)} />
        </Row>
      </Group>

      <Group title={t('server.settings.gameplay')}>
        <Row label={t('server.settings.difficulty')} stacked>
          <Segmented
            className="w-full [&>button]:flex-1"
            value={form.difficulty}
            onChange={v => set('difficulty', v)}
            items={[
              { id: 'peaceful', label: t('server.settings.difficultyPeaceful') },
              { id: 'easy', label: t('server.settings.difficultyEasy') },
              { id: 'normal', label: t('server.settings.difficultyNormal') },
              { id: 'hard', label: t('server.settings.difficultyHard') },
            ]}
          />
        </Row>
        <Row label={t('server.settings.viewDistance')} stacked>
          <div className="flex items-center gap-3">
            <input type="range" min="4" max="32" step="1" value={form.view_distance} onChange={e => set('view_distance', +e.target.value)} className="flex-1" />
            <span className="text-[14px] font-mono font-semibold text-fg w-8 text-right tabular-nums">{form.view_distance}</span>
          </div>
        </Row>
        <Row label={t('server.settings.spawnProtection')} hint={t('server.settings.spawnHint')}>
          <input className={compactInput} type="number" min="0" max="255" value={form.spawn_protection} onChange={e => set('spawn_protection', +e.target.value)} />
        </Row>
        <Row label={t('server.settings.seed')} hint={t('server.settings.seedHint')} stacked>
          <input className="input font-mono" value={form.seed} onChange={e => set('seed', e.target.value)} placeholder={t('server.settings.seedPlaceholder')} />
        </Row>
      </Group>

      <Group title={t('server.settings.resources')}>
        <Row label={t('server.settings.ram')} stacked>
          <div>
            <div className="flex items-center gap-3">
              <input type="range" min="1024" max="32768" step="512" value={form.ram_mb} onChange={e => set('ram_mb', +e.target.value)} className="flex-1" />
              <span className="text-[14px] font-mono font-semibold text-fg w-16 text-right tabular-nums">{ramLabel}</span>
            </div>
            <div className="flex justify-between text-[10.5px] text-fg-3 mt-1 pr-[76px]">
              <span>1 Go</span><span>8 Go</span><span>16 Go</span><span>32 Go</span>
            </div>
          </div>
        </Row>
      </Group>

      <Group title={t('pregen.title')} footer={t('pregen.footer')}>
        <Row label={t('pregen.enable')} hint={server.loader_type === 'vanilla' ? t('pregen.vanillaUnsupported') : t('pregen.enableHint')}>
          <Switch
            checked={form.pregen_enabled}
            onChange={v => set('pregen_enabled', v)}
            label={t('pregen.enable')}
            disabled={server.loader_type === 'vanilla'}
          />
        </Row>
        {form.pregen_enabled && (
          <div className="fade-in divide-y divide-white/[0.06]">
            <Row label={t('pregen.radius')} hint={t('pregen.radiusHint', { size: (form.pregen_radius * 2).toLocaleString() })} stacked>
              <Segmented
                className="w-full [&>button]:flex-1"
                value={form.pregen_radius}
                onChange={v => set('pregen_radius', v)}
                items={[1000, 2000, 3000, 5000, 10000].map(r => ({ id: r, label: `${r / 1000}k` }))}
              />
            </Row>
            <Row label={t('pregen.pausePlayers')} hint={t('pregen.pausePlayersHint')}>
              <Switch checked={form.pregen_pause_players} onChange={v => set('pregen_pause_players', v)} label={t('pregen.pausePlayers')} />
            </Row>
            {server.pregen_enabled && (
              <div className="px-4 py-3.5 space-y-3">
                <PregenStatus server={server} />
                {['done', 'error', 'running', 'paused'].includes(server.pregen_status) && (
                  <button
                    className="btn-ghost !h-8 !px-3 -ml-1"
                    disabled={restartingPregen}
                    onClick={async () => {
                      setRestartingPregen(true);
                      try { await restartPregen(server.id); qc.invalidateQueries({ queryKey: ['server', server.id] }); }
                      catch (err) { toast.error(err.response?.data?.error || t('common.error')); }
                      finally { setRestartingPregen(false); }
                    }}
                  >
                    <RotateCcw size={13} /> {t('pregen.restart')}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </Group>

      <Group title={t('server.settings.autoUpdates')}>
        <Row label={t('server.settings.enableAutoUpdate')}>
          <Switch checked={!!form.auto_update} onChange={v => set('auto_update', v)} label={t('server.settings.enableAutoUpdate')} />
        </Row>
        {form.auto_update && (
          <div className="fade-in">
            <Row label={t('server.settings.checkEvery')}>
              <div className="flex items-center gap-2">
                <input className={clsx(compactInput, '!w-20')} type="number" min="1" max="168" value={form.update_interval_hours} onChange={e => set('update_interval_hours', +e.target.value)} />
                <span className="text-[13px] text-fg-2">{t('server.settings.hours')}</span>
              </div>
            </Row>
          </div>
        )}
      </Group>

      <Group title={t('server.settings.maintenance')} footer={t('server.settings.downloadModsHint')}>
        {[
          { icon: Package, label: t('server.settings.downloadMods'), onClick: onInstallMods },
          { icon: Globe, label: t('server.actions.importWorld'), onClick: onWorldImport },
          {
            icon: Download,
            label: downloadingWorld ? '…' : t('server.actions.downloadWorld'),
            disabled: downloadingWorld,
            onClick: async () => {
              setDownloadingWorld(true);
              try { await downloadWorld(server.id, server.name); }
              catch { toast.error(t('common.error')); }
              finally { setDownloadingWorld(false); }
            },
          },
        ].map(({ icon: Icon, label, onClick, disabled }) => (
          <button
            key={label}
            onClick={onClick}
            disabled={disabled}
            className="w-full flex items-center gap-3 px-4 min-h-[52px] text-left hover:bg-white/[0.04] active:bg-white/[0.08] disabled:opacity-50 transition-colors"
          >
            <span className="w-8 h-8 rounded-[10px] bg-white/[0.08] flex items-center justify-center text-fg shrink-0"><Icon size={15} strokeWidth={1.75} /></span>
            <span className="text-[14px] text-fg flex-1">{label}</span>
            <ChevronRight size={15} className="text-fg-3" />
          </button>
        ))}
      </Group>

      {/* Barre d'enregistrement : n'apparaît que s'il y a des modifications */}
      {(dirty || isSaving) && (
        <div className="sticky bottom-4 z-10 flex justify-center pointer-events-none">
          <div className="glass-strong pointer-events-auto flex items-center gap-2 h-14 pl-5 pr-2 rounded-full pop-in max-w-full">
            <span className="w-2 h-2 rounded-full bg-warn shrink-0" />
            <div className="min-w-0 mr-2">
              <p className="text-[13px] font-semibold text-fg whitespace-nowrap">{t('server.settings.unsavedChanges')}</p>
              {isStopped && <p className="text-[11px] text-fg-3 truncate max-w-[18rem]">{t('server.settings.containerRecreateNote')}</p>}
            </div>
            <button className="btn-ghost !h-10" onClick={() => setForm(base)} disabled={isSaving}>{t('common.cancel')}</button>
            <button className="btn-primary !h-10" onClick={() => saveMut.mutate()} disabled={isSaving}>
              <Save size={13} strokeWidth={2} />
              {isSaving
                ? recreating ? t('server.settings.applying') : t('server.settings.saving')
                : isStopped ? t('server.settings.saveAndApply') : t('server.settings.save')}
            </button>
          </div>
        </div>
      )}
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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmMods, setConfirmMods] = useState(false);
  const { updateServer: patchStore, removeServer } = useServerStore();
  const bumpIcon = useIconStore(s => s.bumpIcon);
  const headerIconKey = useIconStore(s => s.versions[id] || 1);

  const transientStatuses = ['installing', 'starting', 'updating'];

  const { data: server, isLoading, isError } = useQuery({
    queryKey: ['server', id],
    queryFn: () => getServer(id),
    refetchInterval: (query) => transientStatuses.includes(query.state.data?.status) ? 3000 : 10000,
  });

  useEffect(() => {
    const socket = getSocket();
    const patch = (status, extra = {}) =>
      qc.setQueryData(['server', id], old => old ? { ...old, status, ...extra } : old);

    const onStatus     = ({ serverId, status }) => { if (serverId === id) patch(status); };
    const onDone       = ({ serverId })         => { if (serverId === id) patch('running'); };
    const onError      = ({ serverId })         => { if (serverId === id) patch('error'); };
    const onUpdateDone = ({ serverId, version })=> { if (serverId === id) patch('running', { modpack_version: version }); };

    socket.on('server:status',     onStatus);
    socket.on('install:done',      onDone);
    socket.on('install:error',     onError);
    socket.on('server:update-done', onUpdateDone);
    return () => {
      socket.off('server:status',     onStatus);
      socket.off('install:done',      onDone);
      socket.off('install:error',     onError);
      socket.off('server:update-done', onUpdateDone);
    };
  }, [id, qc]);

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
    onSuccess: () => { setConfirmDelete(false); removeServer(id); navigate('/'); toast.success(t('server.deleted')); },
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  const installModsMut = useMutation({
    mutationFn: () => installMods(id),
    onSuccess: () => { toast.success(t('server.installModsLaunched')); qc.invalidateQueries({ queryKey: ['server', id] }); },
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  const reinstallMut = useMutation({
    mutationFn: () => reinstallServer(id),
    onSuccess: () => { toast.success(t('server.reinstallLaunched')); qc.invalidateQueries({ queryKey: ['server', id] }); },
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  if (isLoading) return (
    <div className="p-8 space-y-6 max-w-screen-xl mx-auto">
      <div className="flex items-center gap-5">
        <div className="skeleton w-16 h-16" />
        <div className="space-y-2.5 flex-1">
          <div className="skeleton h-6 w-64" />
          <div className="skeleton h-4 w-96 max-w-full" />
        </div>
      </div>
      <div className="skeleton h-10 w-full" />
      <div className="skeleton h-72 w-full" />
    </div>
  );

  if (isError || !server) return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-center p-8">
      <p className="eyebrow">404</p>
      <p className="text-lg text-fg">{t('server.notFound')}</p>
      <button className="btn-secondary mt-2" onClick={() => navigate('/catalog')}>{t('notFound.back')}</button>
    </div>
  );

  const isBusy = startMut.isPending || stopMut.isPending || restartMut.isPending;
  const canStart = ['stopped', 'error'].includes(server.status);
  const canStop = ['running', 'starting'].includes(server.status);
  const canUpdate = ['running', 'stopped'].includes(server.status);
  const address = `${window.location.hostname}${server.port === 25565 ? '' : `:${server.port}`}`;

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(address);
      toast.success(t('server.addressCopied', { address }));
    } catch {
      toast(address);
    }
  }

  async function onHeaderIcon(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const resized = await resizeTo64(file);
      await uploadServerIcon(server.id, resized);
      bumpIcon(server.id);
      toast.success(t('server.settings.iconUpdated'));
    } catch (err) {
      toast.error(err.response?.data?.error || t('server.settings.iconError'));
    }
    e.target.value = '';
  }

  async function saveHeaderName() {
    setEditingName(false);
    const trimmed = headerName.trim();
    if (!trimmed || trimmed === server.name) return;
    try {
      const updated = await patchServer(server.id, { name: trimmed });
      patchStore(server.id, updated);
      qc.invalidateQueries({ queryKey: ['server', server.id] });
      toast.success(t('server.settings.saved'));
    } catch { toast.error(t('common.error')); }
  }

  const meta = [
    { icon: Package, value: server.modpack_name },
    server.mc_version && { icon: Gamepad2, value: `MC ${server.mc_version}` },
    server.loader_type && server.loader_type !== 'vanilla' && { icon: Layers3, value: server.loader_type, capitalize: true },
    { icon: MemoryStick, value: server.ram_mb >= 1024 ? `${server.ram_mb / 1024} Go` : `${server.ram_mb} Mo` },
  ].filter(Boolean);

  return (
    <div className="h-full flex flex-col gap-3">
      {/* ── En-tête ── */}
      <header className="glass relative shrink-0 rounded-[26px] overflow-hidden card-in">
        <div className="px-5 pt-5 pb-4">
          <div className="flex items-start justify-between gap-6 flex-wrap">
            {/* Identité */}
            <div className="flex items-center gap-4 min-w-0">
              <div className="relative shrink-0">
                <input type="file" accept="image/png,image/jpeg" id="header-icon-input" className="hidden" onChange={onHeaderIcon} />
                <ServerAvatar server={server} size={52} showDot={false} />
                <label
                  htmlFor="header-icon-input"
                  className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center cursor-pointer transition-transform hover:scale-110"
                  style={{ background: 'var(--fg)', color: '#000', boxShadow: '0 0 0 3px rgba(40,40,46,1)' }}
                  title={t('server.settings.icon')}
                >
                  <Pencil size={9} strokeWidth={2.5} />
                </label>
              </div>

              <div className="min-w-0">
                <div className="flex items-center gap-3 flex-wrap">
                  {editingName ? (
                    <input
                      autoFocus
                      className="text-[22px] font-bold text-fg bg-transparent border-b outline-none min-w-[12rem] tracking-tight"
                      style={{ borderColor: 'var(--fg-3)' }}
                      value={headerName}
                      onChange={e => setHeaderName(e.target.value)}
                      onBlur={saveHeaderName}
                      onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') setEditingName(false); }}
                    />
                  ) : (
                    <h1
                      className="group text-[22px] font-bold text-fg tracking-tight cursor-text flex items-center gap-2 truncate"
                      onClick={() => { setHeaderName(server.name); setEditingName(true); }}
                      title={t('server.settings.serverName')}
                    >
                      <span className="truncate">{server.name}</span>
                      <Pencil size={13} strokeWidth={2} className="text-fg-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </h1>
                  )}
                  <StatusBadge status={server.status} />
                  {server.needs_recreate && (
                    <span
                      className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full font-semibold"
                      style={{ background: 'rgba(var(--warn-rgb),0.1)', color: 'var(--warn)', border: '1px solid rgba(var(--warn-rgb),0.25)' }}
                    >
                      <AlertTriangle size={11} strokeWidth={2} /> {t('server.needsRecreate')}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  <button
                    onClick={copyAddress}
                    className="group inline-flex items-center gap-1.5 h-7 pl-2.5 pr-3 rounded-full font-mono text-xs text-fg bg-white/[0.08] hover:bg-white/[0.14] active:scale-95 transition-all"
                    title={t('server.copyAddress')}
                  >
                    <Wifi size={12} strokeWidth={1.75} className="text-fg-2" />
                    {address}
                    <Copy size={11} strokeWidth={2} className="text-fg-3 group-hover:text-fg-2" />
                  </button>
                  {meta.map(({ icon: Icon, value, capitalize }) => (
                    <span key={value} className={clsx('inline-flex items-center gap-1.5 h-7 px-2 rounded-full text-xs text-fg-2', capitalize && 'capitalize')}>
                      <Icon size={12} strokeWidth={1.75} className="text-fg-3" />
                      <span className="truncate max-w-[14rem]">{value}</span>
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 flex-wrap">
              {server.status === 'error' && !server.container_id ? (
                <button className="btn-primary" onClick={() => reinstallMut.mutate()} disabled={reinstallMut.isPending}>
                  <RotateCcw size={14} strokeWidth={2} /> {t('server.actions.reinstall')}
                </button>
              ) : canStart && (
                <button className="btn-primary" onClick={() => startMut.mutate()} disabled={isBusy}>
                  <Play size={14} strokeWidth={2} fill="currentColor" /> {startMut.isPending ? '…' : t('server.actions.start')}
                </button>
              )}
              {canStop && (
                <div className="inline-flex rounded-full bg-white/[0.08] border border-white/10 p-[3px] gap-0.5">
                  <button className="btn h-[30px] px-3.5 text-fg hover:bg-white/10" onClick={() => stopMut.mutate()} disabled={isBusy}>
                    <Square size={12} strokeWidth={2} fill="currentColor" /> {stopMut.isPending ? '…' : t('server.actions.stop')}
                  </button>
                  <button className="btn h-[30px] px-3.5 text-fg hover:bg-white/10" onClick={() => restartMut.mutate()} disabled={isBusy}>
                    <RotateCcw size={13} strokeWidth={2} className={clsx(restartMut.isPending && 'animate-spin')} /> {t('server.actions.restart')}
                  </button>
                </div>
              )}
              {canUpdate && (
                <button className="btn-secondary" onClick={() => setShowUpdate(true)}>
                  <ArrowUp size={14} strokeWidth={2} /> {t('server.actions.update')}
                </button>
              )}
              <button
                className="btn-danger w-9 px-0"
                onClick={() => setConfirmDelete(true)}
                disabled={deleteMut.isPending}
                title={t('server.actions.delete')}
                aria-label={t('server.actions.delete')}
              >
                <Trash2 size={15} strokeWidth={1.75} />
              </button>
            </div>
          </div>

          {/* Onglets : contrôle segmenté à pastille glissante */}
          <div className="mt-4 -mx-1 px-1 overflow-x-auto">
            <Segmented
              value={tab}
              onChange={setTab}
              items={TABS.map(({ id: tabId, Icon, labelKey }) => ({ id: tabId, icon: Icon, label: t(labelKey) }))}
            />
          </div>
        </div>
      </header>

      {/* ── Contenu : chaque onglet est isolé (un onglet qui plante n'emporte pas la page) ── */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className={clsx('h-full', tab !== 'console' && 'hidden', tab === 'console' && 'card-in')}>
          <ErrorBoundary resetKey="console"><Console server={server} /></ErrorBoundary>
        </div>
        {tab !== 'console' && (
          <ErrorBoundary resetKey={tab}>
            <div key={tab} className={clsx('tab-in', tab === 'files' ? 'h-full' : 'px-1 py-3 max-w-screen-xl')}>
              {tab === 'metrics' && <MetricsPanel server={server} />}
              {tab === 'backups' && <BackupList server={server} />}
              {tab === 'files' && <FileExplorer server={server} />}
              {tab === 'players' && <PlayersPanel server={server} />}
              {tab === 'whitelist' && <WhitelistPanel server={server} />}
              {tab === 'settings' && (
                <EditTab server={server} onInstallMods={() => setConfirmMods(true)} onWorldImport={() => setShowWorldImport(true)} />
              )}
            </div>
          </ErrorBoundary>
        )}
      </div>

      {showUpdate && <UpdateModal server={server} onClose={() => setShowUpdate(false)} />}
      {showWorldImport && <WorldImportModal server={server} onClose={() => setShowWorldImport(false)} />}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => deleteMut.mutate()}
        busy={deleteMut.isPending}
        title={t('confirm.deleteServerTitle')}
        message={t('confirm.deleteServerBody', { name: server.name })}
        confirmLabel={t('server.actions.delete')}
        requireText={server.name}
      />
      <ConfirmDialog
        open={confirmMods}
        onClose={() => setConfirmMods(false)}
        onConfirm={() => { setConfirmMods(false); installModsMut.mutate(); }}
        busy={installModsMut.isPending}
        tone="default"
        title={t('server.settings.downloadMods')}
        message={t('server.settings.downloadModsConfirm')}
      />
    </div>
  );
}
