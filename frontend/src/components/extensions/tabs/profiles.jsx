import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceToNow } from 'date-fns';
import toast from 'react-hot-toast';
import {
  Layers, BookmarkPlus, Plus, Play, Pencil, Trash2, Search, Package, Gamepad2, Layers3, HardDrive, Check,
} from 'lucide-react';
import { useI18n } from '../../../i18n';
import { useServerStore } from '../../../store';
import { getCatalog, getModpackVersions } from '../../../services/api';
import {
  getProfiles, saveCurrentProfile, activateProfile, renameProfile, deleteProfile, createProfileFromModpack,
} from '../../../services/features/profiles';
import Modal from '../../ui/Modal';
import ConfirmDialog from '../../ui/ConfirmDialog';
import { parseDbDate } from '../../../utils/dates';
import { useDateLocale } from '../../../utils/dateLocale';
import { loaderLabel } from '../../../utils/loaders';

export const tab = { id: 'profiles', Icon: Layers, labelKey: 'profiles.tab', order: 85 };

const RELEASE_TYPE_LABEL = { 1: 'Release', 2: 'Beta', 3: 'Alpha' };
const MC_VERSION_RE = /^(1\.\d+|2\d\.\d+)(\.\d+)?$/;

function formatSize(bytes) {
  if (!bytes) return '0 Mo';
  if (bytes > 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} Go`;
  if (bytes > 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} Mo`;
  return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
}

function ProfileMeta({ item, sizeBytes, lastUsed, locale, t }) {
  const date = parseDbDate(lastUsed);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-2 mt-1">
      {item.modpack_name && (
        <span className="inline-flex items-center gap-1 min-w-0">
          <Package size={12} strokeWidth={1.75} className="text-fg-3 shrink-0" />
          <span className="truncate max-w-[14rem]">{item.modpack_name}</span>
        </span>
      )}
      {item.modpack_version && (
        <span className="text-fg-3 font-mono truncate max-w-[10rem]">{item.modpack_version}</span>
      )}
      {item.mc_version && (
        <span className="inline-flex items-center gap-1">
          <Gamepad2 size={12} strokeWidth={1.75} className="text-fg-3 shrink-0" />
          <span>MC {item.mc_version}</span>
        </span>
      )}
      {item.loader_type && (
        <span className="inline-flex items-center gap-1">
          <Layers3 size={12} strokeWidth={1.75} className="text-fg-3 shrink-0" />
          <span>{loaderLabel(item.loader_type)}</span>
        </span>
      )}
      <span className="inline-flex items-center gap-1 font-mono">
        <HardDrive size={12} strokeWidth={1.75} className="text-fg-3 shrink-0" />
        <span>{formatSize(sizeBytes)}</span>
      </span>
      {date && (
        <span className="text-fg-3" title={format(date, 'dd/MM/yyyy HH:mm:ss')}>
          {t('profiles.lastUsed', { ago: formatDistanceToNow(date, { addSuffix: true, locale }) })}
        </span>
      )}
    </div>
  );
}

function NewFromModpackModal({ open, onClose, server, onCreated }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [versionId, setVersionId] = useState('');

  useEffect(() => {
    if (!open) {
      setName('');
      setSearchInput('');
      setQuery('');
      setSelected(null);
      setVersionId('');
    }
  }, [open]);

  useEffect(() => {
    const id = setTimeout(() => setQuery(searchInput.trim()), 350);
    return () => clearTimeout(id);
  }, [searchInput]);

  const { data: catalogData, isLoading: catalogLoading } = useQuery({
    queryKey: ['profiles-catalog', query],
    queryFn: () => getCatalog({ query, limit: 12 }),
    enabled: open && !selected,
    staleTime: 60000,
  });

  const { data: versions = [], isLoading: versionsLoading } = useQuery({
    queryKey: ['modpack-versions', selected?.source, selected?.id],
    queryFn: () => getModpackVersions(selected.source, selected.id),
    enabled: open && !!selected,
    staleTime: 300000,
  });

  useEffect(() => {
    if (versions.length > 0 && !versionId) {
      setVersionId(String(versions[0].id));
    }
  }, [versions, versionId]);

  const createMut = useMutation({
    mutationFn: (payload) => createProfileFromModpack(server.id, payload),
    onSuccess: (updatedServer) => {
      onCreated(updatedServer, name.trim());
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  const modpacks = catalogData?.data || [];
  const selectedVersion = versions.find(v => String(v.id) === versionId);
  const detectedLoaders = selectedVersion?.loaders || [];
  const detectedMcVersions = (selectedVersion?.mcVersions || selectedVersion?.game_versions || [])
    .filter(v => MC_VERSION_RE.test(v));

  function pickModpack(mp) {
    setSelected(mp);
    setVersionId('');
    if (!name.trim()) {
      setName((mp.name || '').slice(0, 48));
    }
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!selected || !name.trim()) return;
    createMut.mutate({
      name: name.trim(),
      modpack_id: selected.id,
      modpack_name: selected.name,
      modpack_source: selected.source,
      modpack_version: selectedVersion?.displayName || selectedVersion?.name || selectedVersion?.versionNumber || null,
      modpack_version_id: versionId || undefined,
      mc_version: detectedMcVersions[0] || selected.mcVersions?.[0] || null,
      loader_type: detectedLoaders[0] || 'forge',
    });
  }

  return (
    <Modal open={open} onClose={onClose} title={t('profiles.newModalTitle')} size="lg">
      <form onSubmit={handleSubmit} className="p-6 space-y-5">
        <p className="text-xs text-fg-2">{t('profiles.newModalNote')}</p>

        <div>
          <label htmlFor="profile-new-name" className="label">{t('profiles.nameLabel')}</label>
          <input
            id="profile-new-name"
            className="input"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={t('profiles.namePlaceholder')}
            maxLength={48}
            required
          />
          <p className="text-[11px] text-fg-3 mt-1">{t('profiles.nameHint')}</p>
        </div>

        {!selected ? (
          <div className="space-y-3">
            <label htmlFor="profile-catalog-search" className="label">{t('profiles.searchLabel')}</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search size={14} strokeWidth={1.75} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-3 pointer-events-none" />
                <input
                  id="profile-catalog-search"
                  className="input pl-9"
                  value={searchInput}
                  onChange={e => setSearchInput(e.target.value)}
                  placeholder={t('profiles.searchPlaceholder')}
                />
              </div>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setQuery(searchInput.trim())}
              >
                {t('profiles.searchBtn')}
              </button>
            </div>

            <div className="border border-line rounded-xl divide-y divide-line max-h-72 overflow-y-auto">
              {catalogLoading ? (
                <div className="p-6 text-center text-xs text-fg-3">{t('profiles.searchLoading')}</div>
              ) : modpacks.length === 0 ? (
                <div className="p-6 text-center text-xs text-fg-3">{t('profiles.searchEmpty')}</div>
              ) : (
                modpacks.map(mp => (
                  <button
                    key={`${mp.source}:${mp.id}`}
                    type="button"
                    onClick={() => pickModpack(mp)}
                    className="w-full text-left px-3.5 py-2.5 flex items-center gap-3 row-hover transition-colors"
                  >
                    {mp.iconUrl ? (
                      <img src={mp.iconUrl} alt="" className="w-9 h-9 rounded-lg object-cover shrink-0 bg-surface-2" />
                    ) : (
                      <div className="w-9 h-9 rounded-lg bg-surface-2 flex items-center justify-center shrink-0">
                        <Package size={16} className="text-fg-3" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-fg truncate">{mp.name}</p>
                      <p className="text-xs text-fg-3 truncate">
                        {mp.source}{mp.author ? ` · ${mp.author}` : ''}{mp.mcVersions?.length ? ` · MC ${mp.mcVersions[0]}` : ''}
                      </p>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <span className="label">{t('profiles.selectedModpack')}</span>
              <div className="card !p-3 flex items-center gap-3">
                {selected.iconUrl ? (
                  <img src={selected.iconUrl} alt="" className="w-10 h-10 rounded-lg object-cover shrink-0" />
                ) : (
                  <div className="w-10 h-10 rounded-lg bg-surface-2 flex items-center justify-center shrink-0">
                    <Package size={16} className="text-fg-3" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-fg truncate">{selected.name}</p>
                  <p className="text-xs text-fg-3 truncate">{selected.source}{selected.author ? ` · ${selected.author}` : ''}</p>
                </div>
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  onClick={() => { setSelected(null); setVersionId(''); }}
                >
                  {t('profiles.changeModpack')}
                </button>
              </div>
            </div>

            <div>
              <label htmlFor="profile-new-version" className="label">{t('profiles.versionLabel')}</label>
              {versionsLoading ? (
                <div className="input text-fg-3 text-sm flex items-center">{t('profiles.versionLoading')}</div>
              ) : versions.length === 0 ? (
                <div className="input text-fg-3 text-sm flex items-center">{t('profiles.versionNone')}</div>
              ) : (
                <select
                  id="profile-new-version"
                  className="input"
                  value={versionId}
                  onChange={e => setVersionId(e.target.value)}
                >
                  {versions.map(v => {
                    const label = v.displayName || v.name || v.versionNumber || v.id;
                    const type = RELEASE_TYPE_LABEL[v.releaseType] || '';
                    const mcVer = (v.mcVersions || v.game_versions || [])
                      .filter(x => MC_VERSION_RE.test(x))
                      .slice(0, 2)
                      .join(', ');
                    return (
                      <option key={v.id} value={String(v.id)}>
                        {label}{type ? ` [${type}]` : ''}{mcVer ? ` — MC ${mcVer}` : ''}
                      </option>
                    );
                  })}
                </select>
              )}
            </div>
          </div>
        )}

        <div className="flex gap-2 pt-2 border-t border-line">
          <button type="button" className="btn-ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button
            type="submit"
            className="btn-primary ml-auto"
            disabled={!selected || !name.trim() || createMut.isPending}
          >
            <Check size={14} strokeWidth={2} />
            {createMut.isPending ? t('profiles.creating') : t('profiles.createSubmit')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function ProfilesTab({ server }) {
  const { t } = useI18n();
  const locale = useDateLocale();
  const qc = useQueryClient();
  const patchStore = useServerStore(s => s.updateServer);

  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [toActivate, setToActivate] = useState(null);
  const [toRename, setToRename] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [toDelete, setToDelete] = useState(null);

  const qKey = ['profiles', server.id];
  const { data, isLoading } = useQuery({
    queryKey: qKey,
    queryFn: () => getProfiles(server.id),
    refetchInterval: 30000,
  });

  const active = data?.active;
  const profiles = data?.profiles || [];

  const isBusy = ['installing', 'updating'].includes(server.status);
  const isStopped = ['stopped', 'error'].includes(server.status);
  const isRunning = ['running', 'starting'].includes(server.status);

  const saveMut = useMutation({
    mutationFn: (name) => saveCurrentProfile(server.id, name),
    onSuccess: (created) => {
      setSaveOpen(false);
      setSaveName('');
      qc.invalidateQueries({ queryKey: qKey });
      toast.success(t('profiles.saveSuccess', { name: created.name }));
    },
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  const activateMut = useMutation({
    mutationFn: (pid) => activateProfile(server.id, pid),
    onSuccess: (res, pid) => {
      const target = profiles.find(p => p.id === pid);
      setToActivate(null);
      if (res?.server) patchStore(server.id, res.server);
      qc.invalidateQueries({ queryKey: ['server', server.id] });
      qc.invalidateQueries({ queryKey: qKey });
      toast.success(t('profiles.activateSuccess', { name: target?.name || res?.server?.active_profile_name || '' }));
    },
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  const renameMut = useMutation({
    mutationFn: ({ pid, name }) => renameProfile(server.id, pid, name),
    onSuccess: () => {
      setToRename(null);
      setRenameValue('');
      qc.invalidateQueries({ queryKey: ['server', server.id] });
      qc.invalidateQueries({ queryKey: qKey });
      toast.success(t('profiles.renameSuccess'));
    },
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  const deleteMut = useMutation({
    mutationFn: (pid) => deleteProfile(server.id, pid),
    onSuccess: () => {
      setToDelete(null);
      qc.invalidateQueries({ queryKey: qKey });
      toast.success(t('profiles.deleteSuccess'));
    },
    onError: (err) => toast.error(err.response?.data?.error || t('common.error')),
  });

  function openSaveModal() {
    setSaveName(server.active_profile_name || server.modpack_name?.slice(0, 48) || '');
    setSaveOpen(true);
  }

  function openRenameModal(profile) {
    setToRename(profile);
    setRenameValue(profile.name || '');
  }

  const activeDisplay = active || {
    id: 'active',
    name: server.active_profile_name,
    modpack_name: server.modpack_name,
    modpack_version: server.modpack_version,
    mc_version: server.mc_version,
    loader_type: server.loader_type,
    size_bytes: 0,
  };

  return (
    <div className="space-y-6 max-w-3xl">
      {/* En-tête + actions */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-fg">{t('profiles.title')}</h3>
          <p className="text-xs text-fg-2 mt-1">{t('profiles.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            className="btn-secondary"
            onClick={openSaveModal}
            disabled={!isStopped || isBusy}
            title={!isStopped ? t('profiles.saveCurrentHint') : undefined}
          >
            <BookmarkPlus size={14} strokeWidth={1.75} />
            {t('profiles.saveCurrent')}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => setNewOpen(true)}
            disabled={isBusy}
          >
            <Plus size={14} strokeWidth={2.25} />
            {t('profiles.newFromModpack')}
          </button>
        </div>
      </div>

      {!isStopped && !isBusy && (
        <p className="text-xs text-fg-3 -mt-3">{t('profiles.saveCurrentHint')}</p>
      )}
      {isBusy && (
        <p className="text-xs text-warn -mt-3">{t('profiles.busyHint')}</p>
      )}

      {/* Profil actif */}
      <section className="space-y-2">
        <p className="eyebrow">{t('profiles.activeSection')}</p>
        <div className="card !py-3.5 !px-4 flex items-center gap-4">
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: 'rgba(var(--success-rgb),0.12)', border: '1px solid rgba(var(--success-rgb),0.3)', color: 'var(--success)' }}
          >
            <Layers size={16} strokeWidth={1.75} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-fg truncate">
                {activeDisplay.name || t('profiles.defaultActiveName')}
              </span>
              <span
                className="badge"
                style={{ background: 'rgba(var(--success-rgb),0.14)', color: 'var(--success)' }}
              >
                {t('profiles.activeBadge')}
              </span>
            </div>
            <ProfileMeta
              item={activeDisplay}
              sizeBytes={activeDisplay.size_bytes}
              lastUsed={null}
              locale={locale}
              t={t}
            />
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={() => openRenameModal({ id: 'active', name: activeDisplay.name || '' })}
            disabled={isBusy}
            title={t('profiles.rename')}
            aria-label={t('profiles.rename')}
          >
            <Pencil size={14} strokeWidth={1.75} />
          </button>
        </div>
      </section>

      {/* Liste des profils enregistrés */}
      <section className="space-y-2">
        <div className="flex items-baseline justify-between">
          <p className="eyebrow">{t('profiles.savedSection')}</p>
          {!isLoading && (
            <span className="text-xs text-fg-3">{t('profiles.count', { count: profiles.length })}</span>
          )}
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {[0, 1].map(i => <div key={i} className="skeleton h-[72px]" />)}
          </div>
        ) : profiles.length === 0 ? (
          <div className="card text-center py-12">
            <div className="w-12 h-12 rounded-xl mx-auto flex items-center justify-center bg-surface-2 border border-line">
              <Layers size={20} strokeWidth={1.5} className="text-fg-3" />
            </div>
            <p className="text-sm font-medium text-fg-2 mt-4">{t('profiles.empty')}</p>
            <p className="text-xs text-fg-3 mt-1">{t('profiles.emptyHint')}</p>
          </div>
        ) : (
          <ol className="space-y-2">
            {profiles.map((p, idx) => (
              <li
                key={p.id}
                className="card card-interactive card-in flex items-center gap-4 !py-3.5 !px-4"
                style={{ animationDelay: `${Math.min(idx, 10) * 25}ms` }}
              >
                <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-surface-2 border border-line text-fg-2">
                  <Layers size={16} strokeWidth={1.75} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-fg truncate">{p.name}</p>
                  <ProfileMeta
                    item={p}
                    sizeBytes={p.size_bytes}
                    lastUsed={p.last_used_at || p.created_at}
                    locale={locale}
                    t={t}
                  />
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    className="btn-secondary text-xs px-3 py-1.5"
                    onClick={() => setToActivate(p)}
                    disabled={isBusy}
                  >
                    <Play size={12} strokeWidth={2} />
                    {t('profiles.activate')}
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => openRenameModal(p)}
                    disabled={isBusy}
                    title={t('profiles.rename')}
                    aria-label={t('profiles.rename')}
                  >
                    <Pencil size={13} strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    className="btn-danger px-2 py-1.5"
                    onClick={() => setToDelete(p)}
                    disabled={isBusy}
                    title={t('profiles.delete')}
                    aria-label={t('profiles.delete')}
                  >
                    <Trash2 size={13} strokeWidth={1.75} />
                  </button>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* Modal sauvegarder comme profil */}
      <Modal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title={t('profiles.saveModalTitle')}
        size="sm"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!saveName.trim()) return;
            saveMut.mutate(saveName.trim());
          }}
          className="p-5 space-y-4"
        >
          <p className="text-xs text-fg-2 leading-relaxed">{t('profiles.saveModalDesc')}</p>
          <div>
            <label htmlFor="profile-save-name" className="label">{t('profiles.nameLabel')}</label>
            <input
              id="profile-save-name"
              className="input"
              value={saveName}
              onChange={e => setSaveName(e.target.value)}
              placeholder={t('profiles.namePlaceholder')}
              maxLength={48}
              autoFocus
              required
            />
            <p className="text-[11px] text-fg-3 mt-1">{t('profiles.nameHint')}</p>
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" className="btn-ghost" onClick={() => setSaveOpen(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className="btn-primary ml-auto"
              disabled={!saveName.trim() || saveMut.isPending}
            >
              {saveMut.isPending ? t('profiles.saving') : t('profiles.saveSubmit')}
            </button>
          </div>
        </form>
      </Modal>

      {/* Modal renommer */}
      <Modal
        open={!!toRename}
        onClose={() => setToRename(null)}
        title={t('profiles.renameModalTitle')}
        size="sm"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!toRename || !renameValue.trim()) return;
            renameMut.mutate({ pid: toRename.id, name: renameValue.trim() });
          }}
          className="p-5 space-y-4"
        >
          <div>
            <label htmlFor="profile-rename-input" className="label">{t('profiles.nameLabel')}</label>
            <input
              id="profile-rename-input"
              className="input"
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              maxLength={48}
              autoFocus
              required
            />
            <p className="text-[11px] text-fg-3 mt-1">{t('profiles.nameHint')}</p>
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" className="btn-ghost" onClick={() => setToRename(null)}>
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className="btn-primary ml-auto"
              disabled={!renameValue.trim() || renameMut.isPending}
            >
              {renameMut.isPending ? '…' : t('profiles.renameSubmit')}
            </button>
          </div>
        </form>
      </Modal>

      {/* Modal nouveau profil depuis modpack */}
      <NewFromModpackModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        server={server}
        onCreated={(updatedServer, profileName) => {
          if (updatedServer) patchStore(server.id, updatedServer);
          qc.invalidateQueries({ queryKey: ['server', server.id] });
          qc.invalidateQueries({ queryKey: qKey });
          toast.success(t('profiles.createSuccess', { name: profileName }));
        }}
      />

      {/* Confirmation activation */}
      <ConfirmDialog
        open={!!toActivate}
        onClose={() => setToActivate(null)}
        onConfirm={() => activateMut.mutate(toActivate.id)}
        busy={activateMut.isPending}
        tone="default"
        title={t('profiles.activateTitle', { name: toActivate?.name || '' })}
        message={isRunning ? t('profiles.activateConfirm') : t('profiles.activateConfirmStopped')}
        confirmLabel={t('profiles.activate')}
      />

      {/* Confirmation suppression */}
      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => deleteMut.mutate(toDelete.id)}
        busy={deleteMut.isPending}
        tone="danger"
        title={t('profiles.deleteTitle', { name: toDelete?.name || '' })}
        message={t('profiles.deleteConfirm')}
        confirmLabel={t('profiles.delete')}
      />
    </div>
  );
}
