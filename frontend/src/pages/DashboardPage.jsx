import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { Plus, Play, Square, Copy, ChevronRight, Compass, Box, Loader2 } from 'lucide-react';
import { useServerStore } from '../store';
import { useI18n } from '../i18n';
import { startServer, stopServer } from '../services/api';
import PageHeader, { Page } from '../components/layout/PageHeader';
import ServerAvatar from '../components/ui/ServerAvatar';
import StatusBadge from '../components/ui/StatusBadge';
import VanillaModal from '../components/catalog/VanillaModal';
import { statusColor } from '../components/ui/status';
import { loaderLabel } from '../utils/loaders';

const BUSY = new Set(['installing', 'updating']);

function formatRam(mb) {
  return mb >= 1024 ? `${Math.round(mb / 102.4) / 10} Go` : `${mb} Mo`;
}

function serverAddress(server) {
  return `${window.location.hostname}${server.port === 25565 ? '' : `:${server.port}`}`;
}

/** Chiffre clé (ligne de résumé en haut de page). */
function Stat({ label, value, color }) {
  return (
    <div className="px-5 py-4 min-w-0">
      <p className="text-[12.5px] text-fg-2 flex items-center gap-2">
        {color && <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />}
        {label}
      </p>
      <p className="text-[26px] font-semibold text-fg mt-1 tabular-nums leading-none">{value}</p>
    </div>
  );
}

function ServerRow({ server }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const updateServer = useServerStore(s => s.updateServer);
  const [pending, setPending] = useState(false);

  const canStart = ['stopped', 'error'].includes(server.status) && server.container_id;
  const canStop = ['running', 'starting'].includes(server.status);
  const address = serverAddress(server);

  async function act(e, kind) {
    e.stopPropagation();
    setPending(true);
    try {
      if (kind === 'start') { await startServer(server.id); updateServer(server.id, { status: 'starting' }); toast.success(t('server.started')); }
      else { await stopServer(server.id); updateServer(server.id, { status: 'stopped' }); toast.success(t('server.stoppedMsg')); }
      qc.invalidateQueries({ queryKey: ['server', server.id] });
    } catch (err) {
      toast.error(err.response?.data?.error || t('common.error'));
    } finally {
      setPending(false);
    }
  }

  async function copy(e) {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(address); toast.success(t('server.addressCopied', { address })); }
    catch { toast(address); }
  }

  const version = [server.mc_version && `MC ${server.mc_version}`, server.loader_type && server.loader_type !== 'vanilla' && loaderLabel(server.loader_type)]
    .filter(Boolean).join(' · ');

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={() => navigate(`/servers/${server.id}`)}
      onKeyDown={e => { if (e.key === 'Enter') navigate(`/servers/${server.id}`); }}
      className="group grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,1.3fr)_88px_120px] items-center gap-4 px-5 h-[68px] cursor-pointer row-hover border-b border-line last:border-b-0"
    >
      <div className="flex items-center gap-3 min-w-0">
        <ServerAvatar server={server} size={36} showDot={false} />
        <div className="min-w-0">
          <p className="text-[14px] font-medium text-fg truncate">{server.name}</p>
          <p className="text-[12.5px] text-fg-3 truncate">{server.modpack_name}</p>
        </div>
      </div>

      <div className="hidden md:block"><StatusBadge status={server.status} /></div>

      <div className="hidden md:block min-w-0">
        <button
          onClick={copy}
          className="inline-flex items-center gap-1.5 max-w-full font-mono text-[12.5px] text-fg-2 hover:text-fg transition-colors"
          title={t('server.copyAddress')}
        >
          <span className="truncate">{address}</span>
          <Copy size={12} strokeWidth={1.75} className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
        </button>
        <p className="text-[12px] text-fg-3 truncate">{version || '—'}</p>
      </div>

      <p className="hidden md:block text-[13px] text-fg-2 tabular-nums">{formatRam(server.ram_mb)}</p>

      <div className="flex items-center justify-end gap-1.5">
        {/* Mobile : l'état sous forme de point */}
        <span className="md:hidden w-2 h-2 rounded-full" style={{ background: statusColor(server.status) }} />
        {BUSY.has(server.status) ? (
          <Loader2 size={15} className="animate-spin text-fg-3" />
        ) : canStop ? (
          <button className="btn-secondary !h-8 !px-2.5" onClick={e => act(e, 'stop')} disabled={pending} title={t('server.actions.stop')}>
            <Square size={12} strokeWidth={2} fill="currentColor" />
            <span className="hidden lg:inline">{t('server.actions.stop')}</span>
          </button>
        ) : canStart ? (
          <button className="btn-secondary !h-8 !px-2.5" onClick={e => act(e, 'start')} disabled={pending} title={t('server.actions.start')}>
            <Play size={12} strokeWidth={2} fill="currentColor" />
            <span className="hidden lg:inline">{t('server.actions.start')}</span>
          </button>
        ) : null}
        <ChevronRight size={16} className="text-fg-3 group-hover:text-fg transition-colors" />
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { t } = useI18n();
  const servers = useServerStore(s => s.servers);
  const [vanillaOpen, setVanillaOpen] = useState(false);

  const count = (pred) => servers.filter(pred).length;
  const running = count(s => s.status === 'running');
  const busy = count(s => ['starting', 'installing', 'updating'].includes(s.status));
  const errors = count(s => s.status === 'error');
  const totalRam = servers.filter(s => ['running', 'starting'].includes(s.status)).reduce((a, s) => a + (s.ram_mb || 0), 0);

  const actions = (
    <>
      <button className="btn-secondary" onClick={() => setVanillaOpen(true)}>
        <Box size={14} strokeWidth={1.75} /> {t('catalog.vanillaServer')}
      </button>
      <Link to="/catalog" className="btn-primary">
        <Plus size={15} strokeWidth={2} /> {t('nav.newServer')}
      </Link>
    </>
  );

  return (
    <Page>
      <PageHeader title={t('dashboard.title')} description={t('dashboard.subtitle')} actions={servers.length > 0 && actions} />

      {servers.length === 0 ? (
        <div className="card !p-0 flex flex-col items-center text-center py-16 px-6">
          <div className="w-12 h-12 rounded-xl border border-line-strong flex items-center justify-center mb-5">
            <Compass size={22} strokeWidth={1.5} className="text-fg-2" />
          </div>
          <h2 className="text-[16px] font-semibold text-fg">{t('dashboard.emptyTitle')}</h2>
          <p className="text-[13.5px] text-fg-2 mt-1.5 max-w-sm">{t('dashboard.emptyBody')}</p>
          <div className="flex gap-2 mt-6">{actions}</div>
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-line overflow-hidden grid grid-cols-2 lg:grid-cols-4 gap-px bg-line mb-6 [&>*]:bg-surface">
            <Stat label={t('dashboard.online')} value={running} color={running ? 'var(--success)' : undefined} />
            <Stat label={t('dashboard.total')} value={servers.length} />
            <Stat label={t('dashboard.busy')} value={busy} color={busy ? 'var(--warn)' : undefined} />
            {errors > 0
              ? <Stat label={t('dashboard.errors')} value={errors} color="var(--danger)" />
              : <Stat label={t('dashboard.ramInUse')} value={formatRam(totalRam)} />}
          </div>

          <div className="card !p-0 overflow-hidden">
            <div className="hidden md:grid grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,1.3fr)_88px_120px] gap-4 px-5 h-10 items-center border-b border-line text-[12px] text-fg-3 font-medium">
              <span>{t('dashboard.colServer')}</span>
              <span>{t('dashboard.colStatus')}</span>
              <span>{t('dashboard.colAddress')}</span>
              <span>RAM</span>
              <span />
            </div>
            <div className={clsx('stagger-fast')}>
              {servers.map(s => <ServerRow key={s.id} server={s} />)}
            </div>
          </div>
        </>
      )}

      <VanillaModal open={vanillaOpen} onClose={() => setVanillaOpen(false)} />
    </Page>
  );
}
