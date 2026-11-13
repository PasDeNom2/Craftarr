import React, { useState, useEffect, useRef } from 'react';
import { useI18n } from '../i18n';
import { useParams, useNavigate } from 'react-router-dom';
import { getSocket } from '../hooks/useSocket';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getServer, startServer, stopServer, restartServer, deleteServer,
  patchServer, installMods, reinstallServer, uploadServerIcon,
} from '../services/api';
import { useServerStore, useIconStore, useMetricsStore, useAuthStore } from '../store';
import Console from '../components/servers/Console';
import MetricsPanel from '../components/servers/MetricsPanel';
import BackupList from '../components/servers/BackupList';
import FileExplorer from '../components/servers/FileExplorer';
import ErrorBoundary from '../components/ui/ErrorBoundary';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import PlayersPanel from '../components/servers/PlayersPanel';
import ModsPanel from '../components/servers/ModsPanel';
import WhitelistPanel from '../components/servers/WhitelistPanel';
import UpdateModal from '../components/servers/detail/UpdateModal';
import WorldImportModal from '../components/servers/detail/WorldImportModal';
import EditTab, { resizeTo64 } from '../components/servers/detail/EditTab';
import ServerHeader from '../components/servers/detail/ServerHeader';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { extraTabs } from '../extensions/registry';
import {
  Terminal, Activity, HardDrive, FolderOpen, Settings as SettingsIcon,
  Package, Users, Shield,
} from 'lucide-react';

// Stable English IDs — never change, only labelKey is translated
const CORE_TABS = [
  { id: 'console',   Icon: Terminal,     labelKey: 'server.tabs.console',   order: 10 },
  { id: 'mods',      Icon: Package,      labelKey: 'server.tabs.mods', modded: true, order: 20 },
  { id: 'metrics',   Icon: Activity,     labelKey: 'server.tabs.metrics',   order: 30 },
  { id: 'backups',   Icon: HardDrive,    labelKey: 'server.tabs.backups',   order: 40 },
  { id: 'files',     Icon: FolderOpen,   labelKey: 'server.tabs.files',     order: 50 },
  { id: 'players',   Icon: Users,        labelKey: 'server.tabs.players',   order: 60 },
  { id: 'whitelist', Icon: Shield,       labelKey: 'server.tabs.whitelist', order: 70 },
  { id: 'settings',  Icon: SettingsIcon, labelKey: 'server.tabs.settings',  order: 90 },
];
// Onglets des fonctionnalités (components/extensions/tabs/*.jsx), intercalés selon leur ordre
const TABS = [...CORE_TABS, ...extraTabs].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));

const TAB_PERM = {
  console: 'view',
  mods: 'manage',
  metrics: 'view',
  backups: 'backups',
  files: 'files',
  players: 'players',
  whitelist: 'players',
  schedules: 'manage',
  diagnostics: 'view',
  profiles: 'manage',
  settings: 'manage',
};

const TRANSIENT_STATUSES = ['installing', 'starting', 'updating'];

export default function ServerDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { t } = useI18n();
  const user = useAuthStore(s => s.user);
  const isAdmin = user?.role === 'admin';
  const [tab, setTab] = useState('console');
  const [showUpdate, setShowUpdate] = useState(false);
  const [showWorldImport, setShowWorldImport] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteBackups, setDeleteBackups] = useState(false);
  const [confirmPower, setConfirmPower] = useState(null);
  const [confirmMods, setConfirmMods] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const scrollRef = useRef(null);
  const sentinelRef = useRef(null);
  const { updateServer: patchStore, removeServer } = useServerStore();
  const bumpIcon = useIconStore(s => s.bumpIcon);
  const metrics = useMetricsStore(s => s.metrics[id]);

  const { data: server, isLoading, isError } = useQuery({
    queryKey: ['server', id],
    queryFn: () => getServer(id),
    refetchInterval: (query) => TRANSIENT_STATUSES.includes(query.state.data?.status) ? 3000 : 10000,
  });

  const hasServer = !isLoading && !isError && !!server;

  useEffect(() => {
    if (!hasServer) {
      setScrolled(false);
      return;
    }
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => setScrolled(!entry.isIntersecting),
      { root, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasServer, id]);

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
    mutationFn: () => deleteServer(id, { deleteBackups }),
    onSuccess: (data) => {
      setConfirmDelete(false);
      setDeleteBackups(false);
      removeServer(id);
      navigate('/');
      toast.success(t('server.deleted'));
      if (data?.backupsKeptIn) {
        toast(t('server.backupsKeptToast'), { duration: 6000 });
      }
    },
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
      <button className="btn-secondary mt-2" onClick={() => navigate(isAdmin ? '/catalog' : '/')}>{t('notFound.back')}</button>
    </div>
  );

  const hasPerm = (perm) => isAdmin || (Array.isArray(server.my_perms) && server.my_perms.includes(perm));
  const visibleTabs = TABS.filter(tb => (!tb.show || tb.show(server)) && hasPerm(tb.perm || TAB_PERM[tb.id] || 'manage'));
  const effectiveTab = visibleTabs.some(tb => tb.id === tab) ? tab : (visibleTabs[0]?.id || 'console');
  const activeExtra = extraTabs.find(x => x.id === effectiveTab);
  const canConsole = hasPerm('console');

  const isBusy = startMut.isPending || stopMut.isPending || restartMut.isPending;
  const address = server.join_address || `${window.location.hostname}${server.port === 25565 ? '' : `:${server.port}`}`;

  function getOnlinePlayersCount() {
    if (metrics?.players?.online != null) return metrics.players.online;
    const cachedPlayers = qc.getQueryData(['players', id]);
    if (Array.isArray(cachedPlayers)) return cachedPlayers.filter(p => p.is_online).length;
    return 0;
  }

  function requestPowerAction(action) {
    const count = getOnlinePlayersCount();
    if (count > 0) {
      setConfirmPower({ action, count });
    } else {
      (action === 'restart' ? restartMut : stopMut).mutate();
    }
  }

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

  async function saveHeaderName(trimmed) {
    try {
      const updated = await patchServer(server.id, { name: trimmed });
      patchStore(server.id, updated);
      qc.invalidateQueries({ queryKey: ['server', server.id] });
      toast.success(t('server.settings.saved'));
    } catch { toast.error(t('common.error')); }
  }

  return (
    <div ref={scrollRef} className="h-full flex flex-col overflow-y-auto overflow-x-hidden">
      <div className="relative shrink-0">
        <div ref={sentinelRef} className="absolute top-0 left-0 right-0 h-px pointer-events-none" aria-hidden="true" />
      </div>

      <ServerHeader
        server={server}
        tabs={visibleTabs}
        activeTab={effectiveTab}
        onTabChange={setTab}
        scrolled={scrolled}
        address={address}
        startMut={startMut}
        stopMut={stopMut}
        restartMut={restartMut}
        reinstallMut={reinstallMut}
        deleteMut={deleteMut}
        onRequestPowerAction={requestPowerAction}
        onOpenUpdate={() => setShowUpdate(true)}
        onOpenDelete={() => setConfirmDelete(true)}
        onCopyAddress={copyAddress}
        onIconChange={onHeaderIcon}
        onSaveName={saveHeaderName}
        canPower={hasPerm('power')}
        canManage={hasPerm('manage')}
        canDelete={isAdmin}
      />

      {/* ── Contenu : chaque onglet est isolé (un onglet qui plante n'emporte pas la page) ── */}
      <div className={clsx(effectiveTab === 'console' || effectiveTab === 'files' || activeExtra?.fullHeight ? 'flex-1 min-h-0 p-4 lg:p-5' : 'px-4 sm:px-6 lg:px-8 py-6')}>
        {hasPerm('view') && (
          <div className={clsx('h-full', effectiveTab !== 'console' && 'hidden', !canConsole && '[&_form]:hidden')}>
            <ErrorBoundary resetKey="console"><Console server={server} /></ErrorBoundary>
          </div>
        )}
        {effectiveTab !== 'console' && (
          <ErrorBoundary resetKey={effectiveTab}>
            <div key={effectiveTab} className={clsx('tab-in', effectiveTab === 'files' ? 'h-full' : 'max-w-6xl')}>
              {effectiveTab === 'metrics' && <MetricsPanel server={server} />}
              {effectiveTab === 'mods' && <ModsPanel server={server} />}
              {effectiveTab === 'backups' && <BackupList server={server} />}
              {effectiveTab === 'files' && <FileExplorer server={server} />}
              {effectiveTab === 'players' && <PlayersPanel server={server} />}
              {effectiveTab === 'whitelist' && <WhitelistPanel server={server} />}
              {activeExtra && <activeExtra.Component server={server} />}
              {effectiveTab === 'settings' && (
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
        onClose={() => { setConfirmDelete(false); setDeleteBackups(false); }}
        onConfirm={() => deleteMut.mutate()}
        busy={deleteMut.isPending}
        title={t('confirm.deleteServerTitle')}
        message={t('confirm.deleteServerBody', { name: server.name })}
        confirmLabel={t('server.actions.delete')}
        requireText={server.name}
      >
        <label className="flex items-center gap-2.5 cursor-pointer select-none text-sm text-fg">
          <input
            type="checkbox"
            className="w-4 h-4 rounded"
            checked={deleteBackups}
            onChange={e => setDeleteBackups(e.target.checked)}
            style={{ accentColor: 'var(--danger)' }}
          />
          <span>{t('confirm.deleteBackups')}</span>
        </label>
      </ConfirmDialog>
      <ConfirmDialog
        open={!!confirmPower}
        onClose={() => setConfirmPower(null)}
        onConfirm={() => {
          const action = confirmPower?.action;
          setConfirmPower(null);
          if (action === 'restart') restartMut.mutate();
          else if (action === 'stop') stopMut.mutate();
        }}
        busy={isBusy}
        tone="default"
        title={confirmPower?.action === 'restart' ? t('confirm.restartServerTitle') : t('confirm.stopServerTitle')}
        message={t('confirm.playersOnlineDisconnect', { count: confirmPower?.count || 0 })}
        confirmLabel={confirmPower?.action === 'restart' ? t('server.actions.restart') : t('server.actions.stop')}
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
