import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getServer, startServer, stopServer, restartServer, deleteServer,
  updateServer, importWorld, getModpackVersions, patchServer, recreateContainer, installMods,
  uploadServerIcon, getServerIconUrl,
} from '../services/api';
import { useServerStore } from '../store';
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
  AlertTriangle, Save,
} from 'lucide-react';

const TABS = [
  { id: 'Console',      Icon: Terminal     },
  { id: 'Métriques',   Icon: Activity     },
  { id: 'Sauvegardes', Icon: HardDrive    },
  { id: 'Fichiers',    Icon: FolderOpen   },
  { id: 'Paramètres',  Icon: SettingsIcon },
];

const RELEASE_TYPE_LABEL = { 1: 'Release', 2: 'Beta', 3: 'Alpha' };
const CONTAINER_ENV_FIELDS = new Set(['port', 'ram_mb', 'max_players', 'whitelist_enabled', 'motd']);

// ─── UpdateModal ──────────────────────────────────────────────────────────────
function UpdateModal({ server, onClose }) {
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
      if (data.upToDate) toast.success('Le serveur est déjà à jour !');
      else { toast.success(`Mise à jour vers ${data.version} lancée`); patchStore(server.id, { status: 'updating' }); }
      qc.invalidateQueries({ queryKey: ['server', server.id] });
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Erreur lors de la mise à jour'),
  });

  return (
    <Modal open onClose={onClose} title="Mettre à jour le modpack" size="md">
      <div className="p-6 space-y-5">
        <div className="card space-y-1 text-sm">
          <p className="text-[#6B6B76] text-xs uppercase tracking-[0.08em]">Version actuelle</p>
          <p className="font-medium text-[#F0F0F0]">{server.modpack_version || 'Inconnue'}</p>
        </div>
        <div>
          <label className="label">Version cible</label>
          {isLoading ? (
            <div className="input text-[#4A4A55] text-sm animate-pulse">Chargement des versions...</div>
          ) : (
            <select className="input" value={selectedVersionId} onChange={e => setSelectedVersionId(e.target.value)}>
              <option value="">Dernière version disponible</option>
              {versions.map((v) => {
                const label = v.displayName || v.name || v.versionNumber || v.id;
                const type = RELEASE_TYPE_LABEL[v.releaseType] || '';
                const mcVer = (v.mcVersions || v.game_versions || []).filter(x => /^1\.\d+/.test(x)).slice(0, 2).join(', ');
                const isCurrent = String(v.id) === String(server.modpack_version_id);
                return (
                  <option key={v.id} value={String(v.id)}>
                    {isCurrent ? '> ' : ''}{label}{type ? ` [${type}]` : ''}{mcVer ? ` — MC ${mcVer}` : ''}{isCurrent ? ' (actuelle)' : ''}
                  </option>
                );
              })}
            </select>
          )}
          <p className="text-xs text-[#6B6B76] mt-1">Un backup automatique sera créé avant la mise à jour.</p>
        </div>
        <div className="flex gap-3 pt-2" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <button className="btn-ghost" onClick={onClose}>Annuler</button>
          <button className="btn-primary ml-auto gap-2" onClick={() => doUpdate.mutate()} disabled={doUpdate.isPending}>
            <RotateCcw size={13} strokeWidth={1.5} />
            {doUpdate.isPending ? 'Lancement...' : 'Mettre à jour'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── WorldImportModal ─────────────────────────────────────────────────────────
function WorldImportModal({ server, onClose }) {
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const qc = useQueryClient();

  async function handleImport() {
    if (!file) return;
    setUploading(true);
    try {
      await importWorld(server.id, file);
      toast.success('World importé avec succès !');
      qc.invalidateQueries({ queryKey: ['server', server.id] });
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur lors de l\'import');
    } finally {
      setUploading(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Importer un dossier world" size="sm">
      <div className="p-6 space-y-4">
        <p className="text-sm text-[#6B6B76]">
          Le zip doit contenir les dossiers{' '}
          <code className="text-[#F0F0F0] font-mono text-xs">world/</code>,{' '}
          <code className="text-[#F0F0F0] font-mono text-xs">world_nether/</code> et/ou{' '}
          <code className="text-[#F0F0F0] font-mono text-xs">world_the_end/</code>.
          Le serveur sera arrêté puis redémarré automatiquement.
        </p>
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
                <p className="text-sm text-[#6B6B76]">Sélectionner un fichier .zip</p>
              </div>
            )}
          </label>
        </div>
        <div className="flex gap-3">
          <button className="btn-ghost" onClick={onClose}>Annuler</button>
          <button className="btn-primary ml-auto gap-2" onClick={handleImport} disabled={!file || uploading}>
            <Upload size={13} strokeWidth={1.5} />
            {uploading ? 'Import en cours...' : 'Importer'}
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
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image invalide')); };
    img.src = url;
  });
}

function SectionTitle({ children }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#6B6B76]">{children}</h3>
  );
}

function EditTab({ server, onInstallMods }) {
  const qc = useQueryClient();
  const { updateServer: patchStore } = useServerStore();

  const [form, setForm] = useState({
    name: server.name,
    port: server.port,
    ram_mb: server.ram_mb,
    max_players: server.max_players,
    whitelist_enabled: server.whitelist_enabled,
    auto_update: server.auto_update,
    update_interval_hours: server.update_interval_hours || 6,
    motd: server.motd || '',
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
          toast.success('Paramètres appliqués — container recréé et démarré');
          patchStore(server.id, { status: 'starting' });
          qc.invalidateQueries({ queryKey: ['server', server.id] });
        } catch (err) {
          toast.error('Sauvegardé mais erreur à la recréation : ' + (err.response?.data?.error || err.message));
        } finally {
          setRecreating(false);
        }
      } else if (envChanged && isRunning) {
        toast.success('Paramètres sauvegardés — arrêtez puis recréez le container pour les appliquer');
      } else {
        toast.success('Paramètres sauvegardés');
      }
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Erreur lors de la sauvegarde'),
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
      toast.success('Icône mise à jour (64x64) — redémarrez le serveur pour l\'appliquer');
      setIconPreview(null);
      setIconFile(null);
      setIconKey(Date.now());
    } catch (err) {
      toast.error(err.response?.data?.error || err.message || 'Erreur lors de l\'upload');
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
          <span>Le serveur est en cours d'exécution. Les changements de MOTD, RAM, port et whitelist nécessitent d'arrêter puis de recréer le container.</span>
        </div>
      )}

      <div className="space-y-3">
        <SectionTitle>Identité</SectionTitle>
        <div>
          <label className="label">Nom du serveur</label>
          <input className="input" value={form.name} onChange={e => set('name', e.target.value)} />
        </div>
      </div>

      <div className="space-y-3">
        <SectionTitle>Apparence dans Minecraft</SectionTitle>
        <div className="card space-y-4">
          <div className="flex items-start gap-4">
            <div className="flex-shrink-0 flex flex-col items-center gap-1">
              <div
                className="w-16 h-16 rounded-xl overflow-hidden flex items-center justify-center"
                style={{ background: '#1C1C21', border: '1px solid rgba(255,255,255,0.08)' }}
              >
                {iconPreview
                  ? <img src={iconPreview} alt="Aperçu" className="w-full h-full object-cover" />
                  : <img
                      key={iconKey}
                      src={`${getServerIconUrl(server.id)}?v=${iconKey}`}
                      alt="Icône"
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
              <label className="label">Icône serveur</label>
              <input
                type="file" accept="image/png,image/jpeg"
                onChange={handleIconChange}
                className="block w-full text-sm text-[#6B6B76] file:mr-3 file:py-1 file:px-3 file:rounded-lg file:border-0 file:text-xs file:bg-[#1C1C21] file:text-[#6B6B76] hover:file:text-[#F0F0F0] cursor-pointer"
              />
              {iconFile && (
                <button className="btn-primary text-xs py-1.5 px-3 gap-1.5" onClick={handleIconUpload} disabled={iconUploading}>
                  <Upload size={11} strokeWidth={1.5} />
                  {iconUploading ? 'Upload...' : 'Envoyer'}
                </button>
              )}
              <p className="text-[11px] text-[#4A4A55]">Appliquée au prochain démarrage du serveur.</p>
            </div>
          </div>

          <div>
            <label className="label">MOTD</label>
            <input
              className="input font-mono text-sm"
              value={form.motd}
              onChange={e => set('motd', e.target.value)}
              placeholder={`${server.name} — Powered by MCManager`}
              maxLength={59}
            />
            <div className="flex justify-between mt-1">
              <p className="text-[11px] text-[#4A4A55]">Supporte les §codes couleur Minecraft</p>
              <span className={clsx('text-[11px]', form.motd.length > 50 ? 'text-[#FBBF24]' : 'text-[#4A4A55]')}>
                {form.motd.length}/59
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <SectionTitle>Réseau</SectionTitle>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Port Minecraft</label>
            <input className="input" type="number" min="1024" max="65535" value={form.port}
              onChange={e => set('port', +e.target.value)} />
          </div>
          <div>
            <label className="label">Joueurs max</label>
            <input className="input" type="number" min="1" max="500" value={form.max_players}
              onChange={e => set('max_players', +e.target.value)} />
          </div>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" className="w-4 h-4 rounded" checked={form.whitelist_enabled}
            onChange={e => set('whitelist_enabled', e.target.checked)}
            style={{ accentColor: '#4ADE80' }} />
          <span className="text-sm text-[#6B6B76]">Whitelist activée</span>
        </label>
      </div>

      <div className="space-y-3">
        <SectionTitle>Ressources</SectionTitle>
        <div>
          <div className="flex justify-between mb-2">
            <label className="label mb-0">RAM allouée</label>
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
        <SectionTitle>Mises à jour automatiques</SectionTitle>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" className="w-4 h-4" checked={form.auto_update}
            onChange={e => set('auto_update', e.target.checked)}
            style={{ accentColor: '#4ADE80' }} />
          <span className="text-sm text-[#6B6B76]">Activer les mises à jour automatiques</span>
        </label>
        {form.auto_update && (
          <div className="flex items-center gap-3 pl-6">
            <label className="text-sm text-[#6B6B76]">Vérifier toutes les</label>
            <input className="input w-20 text-center" type="number" min="1" max="168" value={form.update_interval_hours}
              onChange={e => set('update_interval_hours', +e.target.value)} />
            <span className="text-sm text-[#6B6B76]">heures</span>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <SectionTitle>Maintenance</SectionTitle>
        <div className="flex gap-3 flex-wrap">
          <button
            className="btn-secondary text-sm gap-2"
            onClick={() => {
              if (confirm('Télécharger les mods ? Le serveur sera arrêté, les mods téléchargés, puis redémarré.')) {
                onInstallMods();
              }
            }}
          >
            <Package size={14} strokeWidth={1.5} />
            Re-télécharger les mods
          </button>
        </div>
        <p className="text-[11px] text-[#4A4A55]">Arrête le serveur, retélécharge tous les mods via l'API, puis redémarre.</p>
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
            ? recreating ? 'Application en cours...' : 'Sauvegarde...'
            : isStopped ? 'Sauvegarder et appliquer' : 'Sauvegarder'
          }
        </button>
        {isStopped && (
          <p className="text-[11px] text-[#4A4A55] flex-1">
            Le container sera recréé automatiquement pour appliquer les changements.
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
  const [tab, setTab] = useState('Console');
  const [showUpdate, setShowUpdate] = useState(false);
  const [showWorldImport, setShowWorldImport] = useState(false);
  const { updateServer: patchStore, removeServer } = useServerStore();

  const { data: server, isLoading, isError } = useQuery({
    queryKey: ['server', id],
    queryFn: () => getServer(id),
    refetchInterval: 10000,
  });

  const startMut = useMutation({
    mutationFn: () => startServer(id),
    onSuccess: () => { toast.success('Serveur démarré'); patchStore(id, { status: 'starting' }); qc.invalidateQueries({ queryKey: ['server', id] }); },
    onError: (err) => toast.error(err.response?.data?.error || 'Erreur'),
  });

  const stopMut = useMutation({
    mutationFn: () => stopServer(id),
    onSuccess: () => { toast.success('Serveur arrêté'); patchStore(id, { status: 'stopped' }); qc.invalidateQueries({ queryKey: ['server', id] }); },
    onError: (err) => toast.error(err.response?.data?.error || 'Erreur'),
  });

  const restartMut = useMutation({
    mutationFn: () => restartServer(id),
    onSuccess: () => { toast.success('Serveur redémarré'); patchStore(id, { status: 'starting' }); },
    onError: (err) => toast.error(err.response?.data?.error || 'Erreur'),
  });

  const deleteMut = useMutation({
    mutationFn: () => deleteServer(id),
    onSuccess: () => { removeServer(id); navigate('/'); toast.success('Serveur supprimé'); },
    onError: (err) => toast.error(err.response?.data?.error || 'Erreur'),
  });

  const installModsMut = useMutation({
    mutationFn: () => installMods(id),
    onSuccess: () => { toast.success('Téléchargement lancé — surveille la console...'); qc.invalidateQueries({ queryKey: ['server', id] }); },
    onError: (err) => toast.error(err.response?.data?.error || 'Erreur'),
  });

  if (isLoading) return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center space-y-3">
        <div className="w-6 h-6 border border-[#F0F0F0] border-t-transparent rounded-full animate-spin mx-auto" style={{ borderTopColor: 'transparent' }} />
        <p className="text-[#6B6B76] text-sm">Chargement...</p>
      </div>
    </div>
  );

  if (isError || !server) return (
    <div className="flex items-center justify-center h-full text-[#6B6B76]">Serveur introuvable</div>
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
            <div
              className="w-11 h-11 rounded-xl overflow-hidden flex-shrink-0 flex items-center justify-center text-base font-bold text-[#6B6B76]"
              style={{ background: '#1C1C21', border: '1px solid rgba(255,255,255,0.06)' }}
            >
              <img
                src={`${getServerIconUrl(server.id)}?v=1`}
                alt=""
                className="w-full h-full object-cover"
                onError={e => { e.currentTarget.style.display = 'none'; e.currentTarget.nextSibling.style.display = 'block'; }}
              />
              <span style={{ display: 'none' }}>{server.name?.[0]?.toUpperCase() || 'S'}</span>
            </div>
            <div>
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-base font-semibold text-[#F0F0F0] leading-tight">{server.name}</h1>
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
                Démarrer
              </button>
            )}
            {canStop && (
              <>
                <button className="btn-secondary text-sm py-1.5 px-4 gap-2" onClick={() => stopMut.mutate()} disabled={isBusy}>
                  <Square size={13} strokeWidth={1.5} />
                  Arrêter
                </button>
                <button className="btn-secondary text-sm py-1.5 px-4 gap-2" onClick={() => restartMut.mutate()} disabled={isBusy}>
                  <RotateCcw size={13} strokeWidth={1.5} />
                  Redémarrer
                </button>
              </>
            )}
            {canUpdate && (
              <button className="btn-secondary text-sm py-1.5 px-4 gap-2" onClick={() => setShowUpdate(true)}>
                <ArrowUp size={13} strokeWidth={1.5} />
                Mettre à jour
              </button>
            )}
            <button className="btn-secondary text-sm py-1.5 px-4 gap-2" onClick={() => setShowWorldImport(true)}>
              <Globe size={13} strokeWidth={1.5} />
              World
            </button>
            <button
              className="btn-danger text-sm py-1.5 px-3"
              onClick={() => { if (confirm(`Supprimer définitivement "${server.name}" et toutes ses données ?`)) deleteMut.mutate(); }}
              disabled={deleteMut.isPending}
              title="Supprimer le serveur"
            >
              <Trash2 size={14} strokeWidth={1.5} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-0.5">
          {TABS.map(({ id: tabId, Icon }) => (
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
              <span className="uppercase tracking-[0.06em]">{tabId}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Content ── */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className={clsx('h-full', tab !== 'Console' && 'hidden')}>
          <Console server={server} />
        </div>
        {tab === 'Métriques' && (
          <div className="p-6">
            <MetricsPanel server={server} />
          </div>
        )}
        {tab === 'Sauvegardes' && (
          <div className="p-6">
            <BackupList server={server} />
          </div>
        )}
        {tab === 'Fichiers' && (
          <div className="h-full">
            <FileExplorer server={server} />
          </div>
        )}
        {tab === 'Paramètres' && (
          <div className="p-6">
            <EditTab server={server} onInstallMods={() => installModsMut.mutate()} />
          </div>
        )}
      </div>

      {showUpdate && <UpdateModal server={server} onClose={() => setShowUpdate(false)} />}
      {showWorldImport && <WorldImportModal server={server} onClose={() => setShowWorldImport(false)} />}
    </div>
  );
}
