import React, { useState } from 'react';
import { useI18n } from '../../../i18n';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  patchServer, recreateContainer, restartPregen,
  uploadServerIcon, getServerIconUrl, downloadWorld,
} from '../../../services/api';
import { useServerStore, useIconStore } from '../../../store';
import Segmented from '../../ui/Segmented';
import Switch from '../../ui/Switch';
import PregenStatus from '../PregenStatus';
import { PregenWorlds } from '../../catalog/PregenOption';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import {
  RotateCcw, Upload, Package, Globe,
  AlertTriangle, Save, Pencil, Download, ChevronRight,
} from 'lucide-react';

const CONTAINER_ENV_FIELDS = new Set(['port', 'ram_mb', 'max_players', 'whitelist_enabled', 'motd', 'seed', 'difficulty', 'view_distance', 'spawn_protection']);

export function resizeTo64(file) {
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
      {title && <h3 className="text-[13px] font-semibold text-fg px-1">{title}</h3>}
      <div className="card !p-0 overflow-hidden divide-y divide-line">{children}</div>
      {footer && <p className="text-[12px] text-fg-3 px-1 leading-relaxed">{footer}</p>}
    </section>
  );
}

function Row({ label, hint, children, stacked }) {
  return (
    <div className={clsx('px-4 py-3 min-h-[52px]', stacked ? 'space-y-2.5' : 'flex items-center justify-between gap-4')}>
      <div className="min-w-0">
        <p className="text-[13.5px] text-fg">{label}</p>
        {hint && <p className="text-[12px] text-fg-3 mt-0.5">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

const compactInput = 'h-8 w-28 px-2.5 rounded-md bg-bg border border-line-strong text-right text-[13px] text-fg outline-none focus:border-fg-2 font-mono transition-colors';

export default function EditTab({ server, onInstallMods, onWorldImport }) {
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
    pregen_worlds: server.pregen_worlds || ['minecraft:overworld'],
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
            <div className="w-16 h-16 rounded-xl overflow-hidden flex items-center justify-center bg-surface-2 border border-line">
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
              className="cursor-pointer absolute -bottom-1 -right-1 w-6 h-6 flex items-center justify-center rounded-full bg-fg text-inverse"
              style={{ boxShadow: '0 0 0 3px var(--surface)' }}
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
          <div className="fade-in divide-y divide-tint/[0.06]">
            <Row label={t('pregen.radius')} hint={t('pregen.radiusHint', { size: (form.pregen_radius * 2).toLocaleString() })} stacked>
              <Segmented
                className="w-full [&>button]:flex-1"
                value={form.pregen_radius}
                onChange={v => set('pregen_radius', v)}
                items={[1000, 2000, 3000, 5000, 10000].map(r => ({ id: r, label: `${r / 1000}k` }))}
              />
            </Row>
            <Row label={t('pregen.worldsLabel')} hint={t('pregen.worldsHint')} stacked>
              <PregenWorlds value={form.pregen_worlds} onChange={v => set('pregen_worlds', v)} />
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
            className="w-full flex items-center gap-3 px-4 min-h-[48px] text-left hover:bg-tint/[0.03] disabled:opacity-50 transition-colors"
          >
            <Icon size={15} strokeWidth={1.75} className="text-fg-2 shrink-0" />
            <span className="text-[13.5px] text-fg flex-1">{label}</span>
            <ChevronRight size={15} className="text-fg-3" />
          </button>
        ))}
      </Group>

      {/* Barre d'enregistrement : n'apparaît que s'il y a des modifications */}
      {(dirty || isSaving) && (
        <div className="sticky bottom-4 z-10 flex justify-center pointer-events-none">
          <div className="glass-strong pointer-events-auto flex items-center gap-2 h-12 pl-4 pr-1.5 rounded-xl pop-in max-w-full">
            <span className="w-2 h-2 rounded-full bg-warn shrink-0" />
            <div className="min-w-0 mr-2">
              <p className="text-[13px] font-semibold text-fg whitespace-nowrap">{t('server.settings.unsavedChanges')}</p>
              {isStopped && <p className="text-[11px] text-fg-3 truncate max-w-[18rem]">{t('server.settings.containerRecreateNote')}</p>}
            </div>
            <button className="btn-ghost" onClick={() => setForm(base)} disabled={isSaving}>{t('common.cancel')}</button>
            <button className="btn-primary" onClick={() => saveMut.mutate()} disabled={isSaving}>
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
