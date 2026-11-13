import React, { useState } from 'react';
import clsx from 'clsx';
import {
  Play, Square, RotateCcw, Trash2, ArrowUp, Package,
  AlertTriangle, Pencil, Copy, Gamepad2, Layers3, MemoryStick, Moon,
} from 'lucide-react';
import { useI18n } from '../../../i18n';
import StatusBadge from '../../ui/StatusBadge';
import ServerAvatar from '../../ui/ServerAvatar';
import { loaderLabel } from '../../../utils/loaders';

export default function ServerHeader({
  server,
  tabs,
  activeTab,
  onTabChange,
  scrolled,
  address,
  startMut,
  stopMut,
  restartMut,
  reinstallMut,
  deleteMut,
  onRequestPowerAction,
  onOpenUpdate,
  onOpenDelete,
  onCopyAddress,
  onIconChange,
  onSaveName,
}) {
  const { t } = useI18n();
  const [editingName, setEditingName] = useState(false);
  const [headerName, setHeaderName] = useState('');

  const isBusy = startMut.isPending || stopMut.isPending || restartMut.isPending;
  const canStart = ['stopped', 'error'].includes(server.status);
  const canStop = ['running', 'starting'].includes(server.status);
  const canUpdate = ['running', 'stopped'].includes(server.status);

  const meta = [
    { icon: Package, value: server.modpack_name },
    server.mc_version && { icon: Gamepad2, value: `MC ${server.mc_version}` },
    server.loader_type && server.loader_type !== 'vanilla' && { icon: Layers3, value: loaderLabel(server.loader_type) },
    { icon: MemoryStick, value: server.ram_mb >= 1024 ? `${server.ram_mb / 1024} Go` : `${server.ram_mb} Mo` },
  ].filter(Boolean);

  async function commitName() {
    setEditingName(false);
    const trimmed = headerName.trim();
    if (!trimmed || trimmed === server.name) return;
    await onSaveName(trimmed);
  }

  return (
    <header
      className={clsx(
        // Collant à partir de 640 px seulement : sur mobile l'en-tête replié occupe trop d'écran
        'sm:sticky sm:top-0 z-20 shrink-0 backdrop-blur-md border-b transition-colors',
        scrolled ? 'border-line' : 'border-transparent',
      )}
      style={{ backgroundColor: 'rgba(var(--bg-rgb), 0.8)' }}
    >
      <div className="px-4 sm:px-6 lg:px-8 pt-4 sm:pt-5">
        <div className="flex items-start justify-between gap-4 sm:gap-6 flex-wrap">
          {/* Identité */}
          <div className="flex items-center gap-3.5 sm:gap-4 min-w-0 max-w-full">
            <div className="relative shrink-0 group/icon">
              <input type="file" accept="image/png,image/jpeg" id="header-icon-input" className="hidden" onChange={onIconChange} />
              <ServerAvatar server={server} size={48} showDot={false} />
              <label
                htmlFor="header-icon-input"
                className="absolute inset-0 rounded-[10px] flex items-center justify-center cursor-pointer bg-black/55 text-white opacity-0 group-hover/icon:opacity-100 transition-opacity"
                title={t('server.settings.icon')}
                aria-label={t('server.settings.icon')}
              >
                <Pencil size={14} strokeWidth={2} />
              </label>
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2.5 flex-wrap">
                {editingName ? (
                  <input
                    autoFocus
                    className="text-[20px] font-semibold text-fg bg-transparent border-b border-fg-3 outline-none min-w-0 w-48 sm:min-w-[12rem] max-w-full tracking-tight"
                    value={headerName}
                    onChange={e => setHeaderName(e.target.value)}
                    onBlur={commitName}
                    onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') setEditingName(false); }}
                  />
                ) : (
                  <h1
                    className="group text-[20px] font-semibold text-fg tracking-tight cursor-text flex items-center gap-2 min-w-0 max-w-full"
                    onClick={() => { setHeaderName(server.name); setEditingName(true); }}
                    title={t('server.settings.serverName')}
                  >
                    <span className="truncate">{server.name}</span>
                    <Pencil size={12} strokeWidth={2} className="text-fg-3 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                  </h1>
                )}
                <StatusBadge status={server.status} />
                {server.sleeping && (
                  <span className="inline-flex items-center gap-1.5 h-6 px-2 rounded-md text-[12px] font-medium text-info border border-info/30 bg-info/[0.08]">
                    <Moon size={12} strokeWidth={2} /> {t('sleep.badge')}
                  </span>
                )}
                {server.needs_recreate && (
                  <span className="inline-flex items-center gap-1.5 h-6 px-2 rounded-md text-[12px] font-medium text-warn border border-warn/30 bg-warn/[0.08]">
                    <AlertTriangle size={12} strokeWidth={2} /> {t('server.needsRecreate')}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-x-4 gap-y-1 mt-1.5 flex-wrap text-[12.5px] text-fg-2">
                <button
                  onClick={onCopyAddress}
                  className="group inline-flex items-center gap-1.5 font-mono text-fg hover:text-fg-2 transition-colors min-w-0 max-w-full"
                  title={t('server.copyAddress')}
                  aria-label={t('server.copyAddress')}
                >
                  <span className="truncate">{address}</span>
                  <Copy size={11} strokeWidth={2} className="text-fg-3 shrink-0" />
                </button>
                {meta.map(({ icon: Icon, value, capitalize }) => (
                  <span key={value} className={clsx('inline-flex items-center gap-1.5 min-w-0', capitalize && 'capitalize')}>
                    <Icon size={12} strokeWidth={1.75} className="text-fg-3 shrink-0" />
                    <span className="truncate max-w-[12rem] sm:max-w-[16rem]">{value}</span>
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 flex-wrap max-w-full">
            {server.status === 'error' && !server.container_id ? (
              <button className="btn-primary min-h-[40px] sm:min-h-0" onClick={() => reinstallMut.mutate()} disabled={reinstallMut.isPending}>
                <RotateCcw size={14} strokeWidth={2} /> {t('server.actions.reinstall')}
              </button>
            ) : canStart && (
              <button className="btn-primary min-h-[40px] sm:min-h-0" onClick={() => startMut.mutate()} disabled={isBusy}>
                <Play size={13} strokeWidth={2} fill="currentColor" /> {startMut.isPending ? '…' : t('server.actions.start')}
              </button>
            )}
            {canStop && (
              <>
                <button className="btn-secondary min-h-[40px] sm:min-h-0" onClick={() => onRequestPowerAction('restart')} disabled={isBusy}>
                  <RotateCcw size={13} strokeWidth={2} className={clsx(restartMut.isPending && 'animate-spin')} /> {t('server.actions.restart')}
                </button>
                <button className="btn-secondary min-h-[40px] sm:min-h-0" onClick={() => onRequestPowerAction('stop')} disabled={isBusy}>
                  <Square size={11} strokeWidth={2} fill="currentColor" /> {stopMut.isPending ? '…' : t('server.actions.stop')}
                </button>
              </>
            )}
            {canUpdate && (
              <button className="btn-secondary min-h-[40px] sm:min-h-0" onClick={onOpenUpdate}>
                <ArrowUp size={14} strokeWidth={2} /> {t('server.actions.update')}
              </button>
            )}
            <button
              className="btn-danger w-10 sm:w-9 min-h-[40px] sm:min-h-0 !px-0"
              onClick={onOpenDelete}
              disabled={deleteMut.isPending}
              title={t('server.actions.delete')}
              aria-label={t('server.actions.delete')}
            >
              <Trash2 size={15} strokeWidth={1.75} />
            </button>
          </div>
        </div>

        {/* Onglets */}
        <nav className="tabs mt-4 -mb-px !border-b-0 max-w-full" role="tablist">
          {tabs.filter(tb => !tb.modded || server.loader_type !== 'vanilla').map(({ id: tabId, Icon, labelKey }) => (
            <button
              key={tabId}
              role="tab"
              aria-selected={activeTab === tabId}
              onClick={() => onTabChange(tabId)}
              className="tab"
            >
              <Icon size={14} strokeWidth={1.75} />
              {t(labelKey)}
            </button>
          ))}
        </nav>
      </div>
    </header>
  );
}
