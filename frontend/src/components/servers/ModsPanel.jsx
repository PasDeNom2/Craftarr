import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import {
  Search, Plus, Upload, Trash2, AlertTriangle, Download, RotateCcw, Loader2, Package, Wrench, ExternalLink,
} from 'lucide-react';
import {
  getMods, setModEnabled, trashMods, searchMods, installMod, fixModDependencies, uploadMods, restartServer,
} from '../../services/api';
import { useI18n } from '../../i18n';
import Switch from '../ui/Switch';
import Modal from '../ui/Modal';
import Segmented from '../ui/Segmented';
import SourceBadge from '../ui/SourceBadge';
import { LOADER_LABEL } from '../../utils/loaders';


function formatCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n || 0);
}

/** Message d'erreur API lisible. */
const errMsg = (err, fallback) => err.response?.data?.error || err.message || fallback;

// ─── Recherche et installation ────────────────────────────────────────────────
function AddModsModal({ server, target, onClose, onInstalled }) {
  const { t } = useI18n();
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  const [installing, setInstalling] = useState(null);

  useEffect(() => {
    const id = setTimeout(() => setQuery(input.trim()), 350);
    return () => clearTimeout(id);
  }, [input]);

  const { data, isFetching, isError } = useQuery({
    queryKey: ['mod-search', server.id, query, source],
    queryFn: () => searchMods(server.id, query, source === 'all' ? undefined : source),
    staleTime: 60000,
  });
  const results = data?.results || [];

  async function install(mod) {
    setInstalling(`${mod.source}:${mod.id}`);
    try {
      const r = await installMod(server.id, mod.source, mod.id);
      const extra = r.installed.length > 1 ? ` (+${r.installed.length - 1} ${t('mods.dependencies')})` : '';
      toast.success(`${mod.name} ${t('mods.installed')}${extra}`);
      for (const w of r.warnings || []) toast(w, { icon: '⚠️', duration: 8000 });
      onInstalled(r);
    } catch (err) {
      toast.error(errMsg(err, t('common.error')));
    } finally {
      setInstalling(null);
    }
  }

  return (
    <Modal open onClose={onClose} title={t('mods.addTitle')} icon={Plus} size="lg">
      <div className="p-5 space-y-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search size={15} strokeWidth={1.75} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-3 pointer-events-none" />
            <input
              autoFocus
              className="input pl-9"
              placeholder={t('mods.searchPlaceholder')}
              value={input}
              onChange={e => setInput(e.target.value)}
            />
          </div>
          <Segmented
            value={source}
            onChange={setSource}
            items={[
              { id: 'all', label: t('mods.sourceAll') },
              { id: 'modrinth', label: 'Modrinth' },
              { id: 'curseforge', label: 'CurseForge' },
            ]}
          />
        </div>
        <p className="text-[12px] text-fg-3">
          {t('mods.compatibleWith', { mc: target?.mcVersion || '?', loader: LOADER_LABEL[target?.loader] || target?.loader || '?' })}
        </p>

        <div className="min-h-[360px] max-h-[52vh] overflow-y-auto -mx-5 px-5 border-t border-line">
          {isFetching && !results.length ? (
            <div className="space-y-2 pt-3">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-16" />)}</div>
          ) : isError ? (
            <p className="text-[13px] text-danger py-10 text-center">{t('mods.searchError')}</p>
          ) : !results.length ? (
            <p className="text-[13px] text-fg-3 py-10 text-center">{t('mods.noResults')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {results.map(mod => {
                const key = `${mod.source}:${mod.id}`;
                return (
                  <li key={key} className="flex items-center gap-3 py-3">
                    {mod.icon
                      ? <img src={mod.icon} alt="" loading="lazy" className="w-10 h-10 rounded-lg object-cover bg-surface-2 shrink-0" />
                      : <div className="w-10 h-10 rounded-lg bg-surface-2 border border-line flex items-center justify-center shrink-0"><Package size={16} className="text-fg-3" /></div>}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <p className="text-[13.5px] font-medium text-fg truncate">{mod.name}</p>
                        <SourceBadge source={mod.source} />
                      </div>
                      <p className="text-[12px] text-fg-2 line-clamp-1">{mod.summary}</p>
                      <p className="text-[11.5px] text-fg-3 mt-0.5 flex items-center gap-2">
                        <span className="flex items-center gap-1"><Download size={11} />{formatCount(mod.downloads)}</span>
                        {mod.author && <span className="truncate">{mod.author}</span>}
                        {mod.url && (
                          <a href={mod.url} target="_blank" rel="noreferrer" className="hover:text-fg inline-flex items-center gap-0.5" onClick={e => e.stopPropagation()}>
                            <ExternalLink size={11} />
                          </a>
                        )}
                      </p>
                    </div>
                    <button className="btn-secondary !h-8 shrink-0" disabled={!!installing} onClick={() => install(mod)}>
                      {installing === key ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} strokeWidth={2} />}
                      {t('mods.install')}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {data?.errors?.length > 0 && (
            <p className="text-[11.5px] text-fg-3 py-2">{t('mods.partialResults')}</p>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ─── Panneau principal ────────────────────────────────────────────────────────
export default function ModsPanel({ server }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const fileRef = useRef(null);
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState(false);
  const [busyFile, setBusyFile] = useState(null);
  const [uploadPct, setUploadPct] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [needsRestart, setNeedsRestart] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['mods', server.id],
    queryFn: () => getMods(server.id),
    staleTime: 10000,
  });
  const mods = useMemo(() => data?.mods || [], [data]);
  const problems = data?.problems || [];
  const running = ['running', 'starting'].includes(server.status);
  const busy = ['installing', 'updating'].includes(server.status);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return mods;
    return mods.filter(m => `${m.name} ${m.file} ${m.modId || ''}`.toLowerCase().includes(q));
  }, [mods, filter]);
  const disabledCount = mods.filter(m => !m.enabled).length;

  function changed(result) {
    if (result?.restartRequired) setNeedsRestart(true);
    qc.invalidateQueries({ queryKey: ['mods', server.id] });
  }

  async function toggle(mod) {
    setBusyFile(mod.file);
    try { changed(await setModEnabled(server.id, mod.file, !mod.enabled)); }
    catch (err) { toast.error(errMsg(err, t('common.error'))); }
    finally { setBusyFile(null); }
  }

  async function remove(mod) {
    setBusyFile(mod.file);
    try {
      changed(await trashMods(server.id, [mod.file]));
      toast.success(t('mods.movedToTrash', { name: mod.name }));
    } catch (err) { toast.error(errMsg(err, t('common.error'))); }
    finally { setBusyFile(null); }
  }

  async function upload(files) {
    const jars = [...files].filter(f => /\.jar$/i.test(f.name));
    if (!jars.length) { toast.error(t('mods.onlyJars')); return; }
    setUploadPct(0);
    try {
      const r = await uploadMods(server.id, jars, setUploadPct);
      if (r.saved.length) toast.success(t('mods.uploaded', { count: r.saved.length }));
      for (const s of r.skipped) toast(s, { icon: '↷' });
      for (const w of r.warnings) toast(w, { icon: '⚠️', duration: 8000 });
      changed(r);
    } catch (err) {
      toast.error(errMsg(err, t('common.error')));
    } finally {
      setUploadPct(null);
    }
  }

  async function fixDeps() {
    setFixing(true);
    try {
      const r = await fixModDependencies(server.id);
      if (r.installed.length) toast.success(t('mods.depsInstalled', { count: r.installed.length }));
      if (r.unresolved.length) toast(t('mods.depsUnresolved', { list: r.unresolved.join(', ') }), { icon: '⚠️', duration: 10000 });
      if (!r.installed.length && !r.unresolved.length) toast(t('mods.depsNothing'));
      changed(r);
    } catch (err) { toast.error(errMsg(err, t('common.error'))); }
    finally { setFixing(false); }
  }

  async function restart() {
    setRestarting(true);
    try { await restartServer(server.id); setNeedsRestart(false); toast.success(t('server.restarted')); }
    catch (err) { toast.error(errMsg(err, t('common.error'))); }
    finally { setRestarting(false); }
  }

  const hasMissing = problems.some(p => /manquante|missing/i.test(p));

  return (
    <div
      className="space-y-4 relative"
      onDragOver={e => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }}
      onDrop={e => { e.preventDefault(); setDragging(false); if (!busy) upload(e.dataTransfer.files); }}
    >
      {/* Barre d'actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search size={14} strokeWidth={1.75} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-3 pointer-events-none" />
          <input className="input pl-9" placeholder={t('mods.filterPlaceholder')} value={filter} onChange={e => setFilter(e.target.value)} />
        </div>
        <p className="text-[12.5px] text-fg-3 mr-auto">
          {t('mods.count', { count: mods.length })}{disabledCount > 0 && ` · ${t('mods.disabledCount', { count: disabledCount })}`}
        </p>
        <input ref={fileRef} type="file" accept=".jar" multiple className="hidden" onChange={e => { upload(e.target.files); e.target.value = ''; }} />
        <button className="btn-secondary" onClick={() => fileRef.current?.click()} disabled={busy || uploadPct !== null}>
          {uploadPct !== null ? <><Loader2 size={14} className="animate-spin" /> {uploadPct}%</> : <><Upload size={14} strokeWidth={1.75} /> {t('mods.upload')}</>}
        </button>
        <button className="btn-primary" onClick={() => setAdding(true)} disabled={busy}>
          <Plus size={15} strokeWidth={2} /> {t('mods.add')}
        </button>
      </div>

      {busy && (
        <div className="card !py-3 text-[13px] text-fg-2 flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" /> {t('mods.busy')}
        </div>
      )}

      {/* Redémarrage nécessaire */}
      {needsRestart && running && (
        <div className="card !py-3 flex items-center gap-3 flex-wrap fade-in">
          <RotateCcw size={15} className="text-fg-2 shrink-0" />
          <p className="text-[13px] text-fg flex-1 min-w-[200px]">{t('mods.restartRequired')}</p>
          <button className="btn-secondary !h-8" onClick={() => setNeedsRestart(false)}>{t('mods.later')}</button>
          <button className="btn-primary !h-8" onClick={restart} disabled={restarting}>
            {restarting ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} {t('server.actions.restart')}
          </button>
        </div>
      )}

      {/* Problèmes détectés */}
      {problems.length > 0 && (
        <div className="rounded-xl border border-warn/30 bg-warn/[0.06] p-4 fade-in">
          <div className="flex items-start gap-3">
            <AlertTriangle size={16} className="text-warn shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-medium text-fg">{t('mods.problemsTitle', { count: problems.length })}</p>
              <ul className="mt-1.5 space-y-1">
                {problems.slice(0, 8).map(p => <li key={p} className="text-[12.5px] text-fg-2 break-words">{p}</li>)}
                {problems.length > 8 && <li className="text-[12.5px] text-fg-3">… +{problems.length - 8}</li>}
              </ul>
            </div>
            {hasMissing && (
              <button className="btn-secondary !h-8 shrink-0" onClick={fixDeps} disabled={fixing || busy}>
                {fixing ? <Loader2 size={13} className="animate-spin" /> : <Wrench size={13} />} {t('mods.fixDeps')}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Liste */}
      <div className="card !p-0 overflow-hidden">
        {isLoading ? (
          <div className="p-4 space-y-2">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-11" />)}</div>
        ) : isError ? (
          <div className="py-12 text-center">
            <p className="text-[13px] text-danger">{t('mods.loadError')}</p>
            <button className="btn-secondary mt-3" onClick={() => refetch()}>{t('catalog.retry')}</button>
          </div>
        ) : !mods.length ? (
          <div className="py-14 text-center px-6">
            <Package size={22} strokeWidth={1.5} className="text-fg-3 mx-auto mb-3" />
            <p className="text-[14px] font-medium text-fg">{t('mods.emptyTitle')}</p>
            <p className="text-[13px] text-fg-2 mt-1">{t('mods.emptyBody')}</p>
          </div>
        ) : (
          <>
            <div className="hidden md:grid grid-cols-[minmax(0,1fr)_160px_96px_72px] gap-4 px-4 h-9 items-center border-b border-line text-[12px] text-fg-3 font-medium">
              <span>{t('mods.colMod')}</span><span>{t('mods.colVersion')}</span><span>{t('mods.colLoader')}</span><span />
            </div>
            <ul className="divide-y divide-line">
              {shown.map(mod => (
                <li key={mod.file} className={clsx('grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_160px_96px_72px] gap-4 px-4 py-2.5 items-center row-hover', !mod.enabled && 'opacity-55')}>
                  <div className="min-w-0">
                    <p className="text-[13.5px] text-fg truncate">{mod.name}</p>
                    <p className="text-[11.5px] text-fg-3 font-mono truncate">{mod.file}</p>
                  </div>
                  <p className="hidden md:block text-[12.5px] text-fg-2 font-mono truncate" title={mod.version || ''}>{mod.version || '—'}</p>
                  <p className="hidden md:flex text-[12px] text-fg-2 items-center gap-1.5">
                    {LOADER_LABEL[mod.loader] || '—'}
                    {mod.clientOnly && <span className="text-[10.5px] px-1.5 rounded border border-line-strong text-fg-3">client</span>}
                  </p>
                  <div className="flex items-center justify-end gap-1">
                    <Switch checked={mod.enabled} onChange={() => toggle(mod)} disabled={busyFile === mod.file || busy} label={t('mods.toggle')} />
                    <button className="icon-btn" onClick={() => remove(mod)} disabled={busyFile === mod.file || busy} title={t('mods.remove')} aria-label={t('mods.remove')}>
                      <Trash2 size={14} strokeWidth={1.75} />
                    </button>
                  </div>
                </li>
              ))}
              {!shown.length && <li className="py-8 text-center text-[13px] text-fg-3">{t('mods.noMatch')}</li>}
            </ul>
          </>
        )}
      </div>
      <p className="text-[12px] text-fg-3">{t('mods.footer')}</p>

      {dragging && (
        <div className="absolute inset-0 z-20 rounded-xl border-2 border-dashed border-fg-2 bg-bg/85 flex items-center justify-center pointer-events-none">
          <p className="text-[14px] font-medium text-fg flex items-center gap-2"><Upload size={16} /> {t('mods.dropHere')}</p>
        </div>
      )}

      {adding && (
        <AddModsModal
          server={server}
          target={data?.target}
          onClose={() => setAdding(false)}
          onInstalled={changed}
        />
      )}
    </div>
  );
}

