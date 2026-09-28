import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import {
  ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Search, X, FolderPlus, FilePlus2, Upload, RotateCw,
  Download, Pencil, Trash2, Check, Minus, FolderOpen, UploadCloud, Save, Lock, AlertTriangle, FileQuestion,
} from 'lucide-react';
import {
  getFiles, getFileContent, putFileContent, makeDir, renameFile, deleteFiles, uploadFiles, downloadFiles, getFileBlob,
} from '../../services/api';
import { useI18n } from '../../i18n';
import { useDateLocale } from '../../utils/dateLocale';
import Modal from '../ui/Modal';
import ConfirmDialog from '../ui/ConfirmDialog';
import CodeEditor from './files/CodeEditor';
import { iconOf, kindOf, languageOf, LANGUAGE_LABEL, formatSize, joinPath, parentOf } from './files/fileTypes';

const QUICK = ['server.properties', 'config', 'mods', 'defaultconfigs', 'kubejs', 'logs', 'crash_reports', 'ops.json', 'whitelist.json'];
const errMsg = (err, fallback) => err?.response?.data?.error || fallback;
const pathKey = id => `craftarr_files_path_${id}`;

// ─── Fenêtre « nom » (nouveau dossier / nouveau fichier) ─────────────────────
function NameDialog({ open, title, icon, initial = '', onClose, onSubmit }) {
  const { t } = useI18n();
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setName(initial); }, [open, initial]);
  const valid = name.trim() && !/[/\\]/.test(name) && name !== '.' && name !== '..';
  async function submit(e) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    try { await onSubmit(name.trim()); onClose(); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} title={title} icon={icon} size="sm">
      <form onSubmit={submit} className="px-6 pb-6 space-y-4">
        <input className="input font-mono" autoFocus value={name} onChange={e => setName(e.target.value)} placeholder={t('files.namePlaceholder')} spellCheck={false} />
        <div className="flex gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn-primary ml-auto" disabled={!valid || busy}>{busy ? '…' : t('files.create')}</button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Visionneuse / éditeur ────────────────────────────────────────────────────
function FileViewer({ server, file, onClose, onDownload }) {
  const { t } = useI18n();
  const kind = kindOf(file.name);
  const language = languageOf(file.name);
  const readOnly = language === 'log';
  const [state, setState] = useState({ status: 'loading' }); // loading | text | image | binary | error
  const [content, setContent] = useState('');
  const [saved, setSaved] = useState('');
  const [mtime, setMtime] = useState(null);
  const [saving, setSaving] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, col: 1, selected: 0 });
  const [conflict, setConflict] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const dirty = content !== saved;
  const running = server.status === 'running' || server.status === 'starting';

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    if (kind === 'image') {
      try {
        const blob = await getFileBlob(server.id, file.path);
        setState({ status: 'image', url: URL.createObjectURL(blob) });
      } catch (err) { setState({ status: 'error', message: errMsg(err, t('files.readError')) }); }
      return;
    }
    if (kind === 'binary') { setState({ status: 'binary' }); return; }
    try {
      const data = await getFileContent(server.id, file.path);
      setContent(data.content);
      setSaved(data.content);
      setMtime(data.mtime);
      setState({ status: 'text' });
    } catch (err) {
      const code = err?.response?.status;
      if (code === 415) setState({ status: 'binary' });
      else setState({ status: 'error', message: errMsg(err, t('files.readError')) });
    }
  }, [server.id, file.path, kind, t]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => () => { if (state.url) URL.revokeObjectURL(state.url); }, [state.url]);

  // Empêche de fermer l'onglet avec des modifications non enregistrées
  useEffect(() => {
    if (!dirty) return;
    const h = e => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  async function save(force = false) {
    if (readOnly || saving || (!dirty && !force)) return;
    setSaving(true);
    try {
      const res = await putFileContent(server.id, file.path, content, { baseMtime: mtime, force });
      setSaved(content);
      setMtime(res.mtime);
      setConflict(false);
      toast.success(running ? t('files.savedRestart') : t('files.saveSuccess'));
    } catch (err) {
      if (err?.response?.status === 409) setConflict(true);
      else toast.error(errMsg(err, t('files.loadError')));
    } finally {
      setSaving(false);
    }
  }

  function leave() { if (dirty) setConfirmLeave(true); else onClose(); }

  const { Icon, color } = iconOf({ name: file.name, isDir: false });
  const lines = useMemo(() => (state.status === 'text' ? content.split('\n').length : 0), [content, state.status]);

  return (
    <div className="flex flex-col h-full tab-in">
      {/* En-tête */}
      <div className="flex items-center gap-3 px-3 h-14 shrink-0 border-b border-white/[0.06]">
        <button className="icon-btn !h-9 !min-w-9" onClick={leave} title={t('files.back')} aria-label={t('files.back')}>
          <ChevronLeft size={18} />
        </button>
        <span className="w-9 h-9 rounded-xl flex items-center justify-center bg-white/[0.06] shrink-0" style={{ color }}>
          <Icon size={17} strokeWidth={1.75} />
        </span>
        <div className="min-w-0">
          <p className="text-[14px] font-semibold text-fg truncate flex items-center gap-2">
            {file.name}
            {dirty && <span className="w-2 h-2 rounded-full bg-warn shrink-0" title={t('files.modified')} />}
          </p>
          <p className="text-[11px] text-fg-3 font-mono truncate">/{file.path}</p>
        </div>
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {state.status === 'text' && (
            <span className="hidden sm:inline-flex h-6 px-2.5 items-center rounded-full bg-white/[0.07] text-[11px] font-medium text-fg-2">
              {LANGUAGE_LABEL[language]}
            </span>
          )}
          {readOnly && (
            <span className="inline-flex h-6 px-2.5 items-center gap-1 rounded-full bg-white/[0.07] text-[11px] font-medium text-fg-2">
              <Lock size={10} /> {t('files.readOnly')}
            </span>
          )}
          {(readOnly || state.status === 'error') && (
            <button className="icon-btn" onClick={load} title={t('files.reload')} aria-label={t('files.reload')}><RotateCw size={14} /></button>
          )}
          <button className="icon-btn" onClick={() => onDownload([file.path])} title={t('files.download')} aria-label={t('files.download')}><Download size={14} /></button>
          {state.status === 'text' && !readOnly && (
            <button className="btn-primary !h-8 ml-1" onClick={() => save()} disabled={!dirty || saving}>
              <Save size={13} /> {saving ? t('files.saving') : t('files.save')}
              <kbd className="hidden md:inline text-[10px] font-mono opacity-50 ml-0.5">Ctrl S</kbd>
            </button>
          )}
        </div>
      </div>

      {/* Contenu */}
      <div className="well flex-1 min-h-0 flex flex-col m-2 rounded-[18px] overflow-hidden">
        {state.status === 'loading' && (
          <div className="p-4 space-y-2">
            {[70, 45, 85, 60, 30, 75].map((w, i) => <div key={i} className="skeleton h-3" style={{ width: `${w}%`, borderRadius: 6 }} />)}
          </div>
        )}
        {state.status === 'text' && (
          <CodeEditor value={content} onChange={setContent} language={language} onSave={() => save()} onCursor={setCursor} readOnly={readOnly} />
        )}
        {state.status === 'image' && (
          <div className="flex-1 flex items-center justify-center p-8 checker">
            <img src={state.url} alt={file.name} className="max-w-full max-h-full object-contain rounded-lg shadow-2xl pop-in" style={{ imageRendering: file.size && file.size < 20000 ? 'pixelated' : 'auto', minWidth: 64 }} />
          </div>
        )}
        {(state.status === 'binary' || state.status === 'error') && (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center p-8 pop-in">
            <span className="w-14 h-14 rounded-2xl bg-white/[0.06] flex items-center justify-center text-fg-2">
              {state.status === 'error' ? <AlertTriangle size={24} className="text-warn" /> : <FileQuestion size={24} />}
            </span>
            <div>
              <p className="text-[15px] font-semibold text-fg">{state.status === 'error' ? t('files.readError') : t('files.binary')}</p>
              <p className="text-xs text-fg-3 mt-1 max-w-sm">{state.status === 'error' ? state.message : t('files.binaryDesc')}</p>
            </div>
            <button className="btn-secondary mt-1" onClick={() => onDownload([file.path])}>
              <Download size={14} /> {t('files.download')} {file.size != null && <span className="text-fg-3 font-normal">· {formatSize(file.size)}</span>}
            </button>
          </div>
        )}
      </div>

      {/* Barre d'état */}
      {state.status === 'text' && (
        <div className="flex items-center gap-4 px-5 h-8 shrink-0 text-[11px] text-fg-3 font-mono">
          <span>{t('files.cursor', { line: cursor.line, col: cursor.col })}{cursor.selected > 0 && ` (${cursor.selected})`}</span>
          <span>{t('files.lines', { count: lines })}</span>
          <span className="hidden sm:inline">UTF-8</span>
          {running && !readOnly && dirty && (
            <span className="ml-auto font-sans text-warn flex items-center gap-1.5 fade-in">
              <AlertTriangle size={11} /> {t('files.restartHint')}
            </span>
          )}
        </div>
      )}

      <ConfirmDialog
        open={conflict}
        onClose={() => setConflict(false)}
        onConfirm={() => save(true)}
        busy={saving}
        title={t('files.conflictTitle')}
        message={t('files.conflictBody')}
        confirmLabel={t('files.overwrite')}
      />
      <ConfirmDialog
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        onConfirm={() => { setConfirmLeave(false); onClose(); }}
        title={t('files.unsavedTitle')}
        message={t('files.unsavedBody')}
        confirmLabel={t('files.discard')}
      />
    </div>
  );
}

// ─── Explorateur ──────────────────────────────────────────────────────────────
export default function FileExplorer({ server }) {
  const { t } = useI18n();
  const locale = useDateLocale();
  const qc = useQueryClient();
  const [dir, setDirState] = useState(() => {
    try { return sessionStorage.getItem(pathKey(server.id)) || ''; } catch { return ''; }
  });
  const [openFile, setOpenFile] = useState(null);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState({ key: 'name', dir: 1 });
  const [selected, setSelected] = useState(() => new Set());
  const [anchor, setAnchor] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [dialog, setDialog] = useState(null); // 'folder' | 'file'
  const [confirmDelete, setConfirmDelete] = useState(null); // [paths]
  const [deleting, setDeleting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [upload, setUpload] = useState(null); // { count, progress }
  const fileInput = useRef(null);
  const listRef = useRef(null);
  const dragDepth = useRef(0);

  const setDir = useCallback((p) => {
    setDirState(p);
    setSelected(new Set());
    setFilter('');
    setRenaming(null);
    try { sessionStorage.setItem(pathKey(server.id), p); } catch {}
  }, [server.id]);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['files', server.id, dir],
    queryFn: () => getFiles(server.id, dir),
    retry: false,
  });
  // Dossier mémorisé qui n'existe plus → retour à la racine
  useEffect(() => { if (error?.response?.status === 404 && dir) setDir(''); }, [error, dir, setDir]);

  const { data: rootData } = useQuery({
    queryKey: ['files', server.id, ''],
    queryFn: () => getFiles(server.id, ''),
    retry: false,
    staleTime: 30_000,
  });
  const quick = useMemo(() => {
    const names = new Map((rootData?.entries || []).map(e => [e.name, e]));
    return QUICK.filter(n => names.has(n)).map(n => names.get(n));
  }, [rootData]);

  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: ['files', server.id] }), [qc, server.id]);

  const entries = useMemo(() => {
    const list = (data?.entries || []).filter(e => !filter || e.name.toLowerCase().includes(filter.toLowerCase()));
    const cmp = {
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
      mtime: (a, b) => (a.mtime || 0) - (b.mtime || 0),
      size: (a, b) => (a.size || 0) - (b.size || 0),
    }[sort.key];
    return list.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : cmp(a, b) * sort.dir));
  }, [data, filter, sort]);

  const selPaths = [...selected];
  const allSelected = entries.length > 0 && entries.every(e => selected.has(e.name));

  function open(entry) {
    if (entry.isDir) setDir(joinPath(dir, entry.name));
    else setOpenFile({ name: entry.name, path: joinPath(dir, entry.name), size: entry.size });
  }

  function onRowClick(e, entry, idx) {
    if (e.shiftKey && anchor != null) {
      const [a, b] = [Math.min(anchor, idx), Math.max(anchor, idx)];
      setSelected(new Set(entries.slice(a, b + 1).map(x => x.name)));
      return;
    }
    if (e.ctrlKey || e.metaKey) { toggle(entry.name); setAnchor(idx); return; }
    if (selected.size) { toggle(entry.name); setAnchor(idx); return; }
    open(entry);
  }

  function toggle(name) {
    setSelected(s => { const n = new Set(s); n.has(name) ? n.delete(name) : n.add(name); return n; });
  }

  async function doDownload(paths) {
    try { await downloadFiles(server.id, paths); }
    catch (err) { toast.error(errMsg(err, t('common.error'))); }
  }

  async function doDelete() {
    setDeleting(true);
    try {
      await deleteFiles(server.id, confirmDelete);
      toast.success(t('files.deleted', { count: confirmDelete.length }));
      setSelected(new Set());
      setConfirmDelete(null);
      refresh();
    } catch (err) { toast.error(errMsg(err, t('common.error'))); }
    finally { setDeleting(false); }
  }

  async function doRename(entry, next) {
    setRenaming(null);
    if (!next || next === entry.name) return;
    try {
      await renameFile(server.id, joinPath(dir, entry.name), joinPath(dir, next));
      toast.success(t('files.renamed'));
      setSelected(new Set());
      refresh();
    } catch (err) { toast.error(errMsg(err, t('common.error'))); }
  }

  async function doCreate(name) {
    const p = joinPath(dir, name);
    try {
      if (dialog === 'folder') await makeDir(server.id, p);
      else await putFileContent(server.id, p, '');
      toast.success(t('files.created'));
      refresh();
      if (dialog === 'file') setOpenFile({ name, path: p, size: 0 });
    } catch (err) { toast.error(errMsg(err, t('common.error'))); throw err; }
  }

  async function doUpload(fileList) {
    const files = [...fileList].filter(f => f.size > 0 || f.type);
    if (!files.length) return;
    const existing = new Set((data?.entries || []).map(e => e.name));
    const overwrite = files.some(f => existing.has(f.name)) && window.confirm(t('files.overwriteConfirm'));
    setUpload({ count: files.length, progress: 0 });
    try {
      const res = await uploadFiles(server.id, dir, files, { overwrite, onProgress: p => setUpload(u => u && { ...u, progress: p }) });
      if (res.saved.length) toast.success(t('files.uploaded', { count: res.saved.length }));
      if (res.skipped.length) toast(t('files.uploadSkipped', { count: res.skipped.length }));
      refresh();
    } catch (err) { toast.error(errMsg(err, t('common.error'))); }
    finally { setUpload(null); }
  }

  // Raccourcis clavier de la liste
  function onKeyDown(e) {
    if (e.target.tagName === 'INPUT' || renaming) return;
    if (e.key === 'Backspace' && dir) { e.preventDefault(); setDir(parentOf(dir)); }
    else if (e.key === 'Delete' && selected.size) { e.preventDefault(); setConfirmDelete(selPaths.map(n => joinPath(dir, n))); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); setSelected(new Set(entries.map(x => x.name))); }
    else if (e.key === 'Escape') setSelected(new Set());
    else if (e.key === 'F2' && selected.size === 1) { e.preventDefault(); setRenaming(selPaths[0]); }
  }

  useEffect(() => { if (!openFile) listRef.current?.focus({ preventScroll: true }); }, [openFile, dir]);

  // Glisser-déposer
  const dnd = {
    onDragEnter: e => { if ([...e.dataTransfer.types].includes('Files')) { dragDepth.current++; setDragging(true); } },
    onDragLeave: () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); },
    onDragOver: e => { if (dragging) e.preventDefault(); },
    onDrop: e => { e.preventDefault(); dragDepth.current = 0; setDragging(false); doUpload(e.dataTransfer.files); },
  };

  const crumbs = dir ? dir.split('/') : [];
  const SortHead = ({ k, children, className }) => (
    <button
      className={clsx('flex items-center gap-1 hover:text-fg transition-colors', sort.key === k && 'text-fg-2', className)}
      onClick={() => setSort(s => ({ key: k, dir: s.key === k ? -s.dir : 1 }))}
    >
      {children}
      {sort.key === k && (sort.dir === 1 ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
    </button>
  );

  return (
    <div className="glass relative h-full rounded-[26px] overflow-hidden flex flex-col card-in" {...(openFile ? {} : dnd)}>
      {openFile ? (
        <FileViewer
          key={openFile.path}
          server={server}
          file={openFile}
          onClose={() => { setOpenFile(null); refresh(); }}
          onDownload={doDownload}
        />
      ) : (
        <>
          {/* ── Barre d'outils ── */}
          <div className="flex items-center gap-2 px-3 pt-3 pb-2 shrink-0 flex-wrap">
            <button className="icon-btn !h-9 !min-w-9" disabled={!dir} onClick={() => setDir(parentOf(dir))} title={t('files.up')} aria-label={t('files.up')}>
              <ChevronLeft size={18} />
            </button>
            <nav className="flex items-center min-w-0 flex-1 overflow-x-auto text-[13px]" aria-label="breadcrumb">
              <button
                className={clsx('shrink-0 h-8 px-3 rounded-full font-semibold transition-colors', crumbs.length ? 'text-fg-2 hover:text-fg hover:bg-white/[0.07]' : 'text-fg')}
                onClick={() => setDir('')}
              >
                {t('files.root')}
              </button>
              {crumbs.map((c, i) => (
                <React.Fragment key={i}>
                  <ChevronRight size={13} className="text-fg-3 shrink-0" />
                  <button
                    className={clsx('shrink-0 h-8 px-3 rounded-full font-mono text-[12.5px] transition-colors truncate max-w-[16rem]',
                      i === crumbs.length - 1 ? 'text-fg bg-white/[0.08]' : 'text-fg-2 hover:text-fg hover:bg-white/[0.07]')}
                    onClick={() => setDir(crumbs.slice(0, i + 1).join('/'))}
                  >
                    {c}
                  </button>
                </React.Fragment>
              ))}
            </nav>

            <div className="relative w-44 shrink-0">
              <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-3 pointer-events-none" />
              <input
                className="w-full h-8 pl-8 pr-7 rounded-full bg-[rgba(118,118,128,0.2)] border border-transparent text-xs text-fg placeholder:text-fg-3 outline-none focus:border-white/20 transition-colors"
                placeholder={t('files.search')}
                value={filter}
                onChange={e => setFilter(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') setFilter(''); }}
              />
              {filter && <button className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-3 hover:text-fg" onClick={() => setFilter('')} aria-label="×"><X size={12} /></button>}
            </div>
            <div className="flex items-center gap-0.5 shrink-0">
              <button className="icon-btn !h-8 !min-w-8" onClick={() => setDialog('folder')} title={t('files.newFolder')} aria-label={t('files.newFolder')}><FolderPlus size={15} /></button>
              <button className="icon-btn !h-8 !min-w-8" onClick={() => setDialog('file')} title={t('files.newFile')} aria-label={t('files.newFile')}><FilePlus2 size={15} /></button>
              <button className="icon-btn !h-8 !min-w-8" onClick={() => refetch()} title={t('files.refresh')} aria-label={t('files.refresh')}>
                <RotateCw size={14} className={clsx(isFetching && 'animate-spin')} />
              </button>
              <button className="btn-primary !h-8 ml-1" onClick={() => fileInput.current?.click()}>
                <Upload size={13} /> {t('files.upload')}
              </button>
              <input ref={fileInput} type="file" multiple className="hidden" onChange={e => { doUpload(e.target.files); e.target.value = ''; }} />
            </div>
          </div>

          {/* ── Accès rapide ── */}
          {!dir && quick.length > 0 && (
            <div className="flex items-center gap-1.5 px-4 pb-2 overflow-x-auto shrink-0">
              {quick.map(e => {
                const { Icon, color } = iconOf(e);
                return (
                  <button key={e.name} onClick={() => open(e)}
                    className="shrink-0 inline-flex items-center gap-1.5 h-7 pl-2 pr-3 rounded-full bg-white/[0.06] hover:bg-white/[0.12] active:scale-95 text-[12px] text-fg-2 hover:text-fg transition-all">
                    <Icon size={13} style={{ color }} /> {e.name}
                  </button>
                );
              })}
            </div>
          )}

          {/* ── Liste ── */}
          <div className="well relative flex-1 min-h-0 mx-2 mb-2 rounded-[18px] flex flex-col overflow-hidden">
            <div className="grid grid-cols-[36px_1fr_88px] md:grid-cols-[36px_1fr_150px_88px_92px] items-center h-9 px-2 text-[11px] font-medium text-fg-3 border-b border-white/[0.06] shrink-0">
              <button
                className={clsx('w-[18px] h-[18px] mx-auto rounded-md border flex items-center justify-center transition-colors',
                  allSelected || selected.size ? 'bg-fg border-fg text-black' : 'border-white/20 hover:border-white/40')}
                onClick={() => setSelected(allSelected ? new Set() : new Set(entries.map(x => x.name)))}
                aria-label="select all"
              >
                {allSelected ? <Check size={12} strokeWidth={3} /> : selected.size ? <Minus size={12} strokeWidth={3} /> : null}
              </button>
              <SortHead k="name">{t('files.name')}</SortHead>
              <SortHead k="mtime" className="hidden md:flex">{t('files.modifiedAt')}</SortHead>
              <SortHead k="size" className="justify-end">{t('files.size')}</SortHead>
              <span className="hidden md:block" />
            </div>

            <div ref={listRef} tabIndex={0} onKeyDown={onKeyDown} className="flex-1 overflow-y-auto outline-none py-1">
              {isLoading ? (
                <div className="p-3 space-y-2">
                  {Array.from({ length: 8 }).map((_, i) => <div key={i} className="skeleton h-8" style={{ borderRadius: 10, opacity: 1 - i * 0.1 }} />)}
                </div>
              ) : error ? (
                <div className="h-full flex flex-col items-center justify-center gap-2 text-center p-8">
                  <AlertTriangle size={22} className="text-warn" />
                  <p className="text-sm text-fg-2">{t('files.inaccessible')}</p>
                </div>
              ) : entries.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center gap-3 text-center p-8 fade-in">
                  <span className="w-14 h-14 rounded-2xl bg-white/[0.06] flex items-center justify-center text-fg-3"><FolderOpen size={24} strokeWidth={1.5} /></span>
                  <p className="text-sm text-fg-2">{filter ? t('files.noMatch') : t('files.noFiles')}</p>
                  {!filter && <p className="text-xs text-fg-3">{t('files.dropHint')}</p>}
                </div>
              ) : (
                <ul className="stagger-fast">
                  {entries.map((entry, idx) => {
                    const { Icon, color } = iconOf(entry);
                    const isSel = selected.has(entry.name);
                    const date = entry.mtime ? new Date(entry.mtime) : null;
                    return (
                      <li
                        key={entry.name}
                        onClick={e => onRowClick(e, entry, idx)}
                        onDoubleClick={() => selected.size && open(entry)}
                        className={clsx('group grid grid-cols-[36px_1fr_88px] md:grid-cols-[36px_1fr_150px_88px_92px] items-center h-10 px-2 mx-1 rounded-xl cursor-pointer select-none transition-colors',
                          isSel ? 'bg-[rgba(10,132,255,0.18)]' : 'hover:bg-white/[0.05]')}
                      >
                        <button
                          onClick={e => { e.stopPropagation(); toggle(entry.name); setAnchor(idx); }}
                          className={clsx('w-[18px] h-[18px] mx-auto rounded-md border flex items-center justify-center transition-all',
                            isSel ? 'bg-info border-info text-white opacity-100' : 'border-white/20 opacity-0 group-hover:opacity-100', selected.size && 'opacity-100')}
                          aria-label={entry.name}
                        >
                          {isSel && <Check size={12} strokeWidth={3} />}
                        </button>
                        <div className="flex items-center gap-2.5 min-w-0">
                          <Icon size={16} strokeWidth={1.75} style={{ color }} className="shrink-0" />
                          {renaming === entry.name ? (
                            <input
                              autoFocus
                              defaultValue={entry.name}
                              onClick={e => e.stopPropagation()}
                              onFocus={e => { const i = entry.isDir ? -1 : entry.name.lastIndexOf('.'); e.target.setSelectionRange(0, i > 0 ? i : entry.name.length); }}
                              onKeyDown={e => { if (e.key === 'Enter') doRename(entry, e.target.value.trim()); if (e.key === 'Escape') setRenaming(null); }}
                              onBlur={e => doRename(entry, e.target.value.trim())}
                              className="flex-1 min-w-0 h-7 px-2 -ml-2 rounded-lg bg-black/40 border border-[rgba(10,132,255,0.6)] text-[13px] font-mono text-fg outline-none"
                            />
                          ) : (
                            <span className={clsx('truncate text-[13px]', entry.isDir ? 'text-fg font-medium' : 'text-fg font-mono text-[12.5px]')}>{entry.name}</span>
                          )}
                        </div>
                        <span className="hidden md:block text-[12px] text-fg-3 truncate" title={date?.toLocaleString()}>
                          {date ? formatDistanceToNow(date, { addSuffix: true, locale }) : ''}
                        </span>
                        <span className="text-[12px] text-fg-3 font-mono text-right tabular-nums">{entry.isDir ? '' : formatSize(entry.size)}</span>
                        <div className="hidden md:flex items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                          <button className="icon-btn" onClick={() => doDownload([joinPath(dir, entry.name)])} title={t('files.download')} aria-label={t('files.download')}><Download size={13} /></button>
                          <button className="icon-btn" onClick={() => setRenaming(entry.name)} title={t('files.rename')} aria-label={t('files.rename')}><Pencil size={13} /></button>
                          <button className="icon-btn hover:!text-danger" onClick={() => setConfirmDelete([joinPath(dir, entry.name)])} title={t('files.delete')} aria-label={t('files.delete')}><Trash2 size={13} /></button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Pied : nombre d'éléments */}
            {data && !selected.size && (
              <div className="h-8 px-4 flex items-center text-[11px] text-fg-3 border-t border-white/[0.06] shrink-0">
                {t('files.items', { count: data.entries.length })}
                <span className="ml-auto hidden md:inline">{t('files.shortcutsHint')}</span>
              </div>
            )}

            {/* Barre de sélection flottante */}
            {selected.size > 0 && (
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 pop-in">
                <div className="glass-strong flex items-center gap-1 h-11 pl-4 pr-1.5 rounded-full">
                  <span className="text-[13px] font-semibold text-fg mr-2 whitespace-nowrap">{t('files.selected', { count: selected.size })}</span>
                  <button className="btn-ghost !h-8 !px-3" onClick={() => doDownload(selPaths.map(n => joinPath(dir, n)))}><Download size={13} /> {t('files.download')}</button>
                  {selected.size === 1 && <button className="btn-ghost !h-8 !px-3" onClick={() => setRenaming(selPaths[0])}><Pencil size={13} /> {t('files.rename')}</button>}
                  <button className="btn-ghost !h-8 !px-3 !text-danger" onClick={() => setConfirmDelete(selPaths.map(n => joinPath(dir, n)))}><Trash2 size={13} /> {t('files.delete')}</button>
                  <button className="icon-btn !h-8 !min-w-8" onClick={() => setSelected(new Set())} aria-label="×"><X size={14} /></button>
                </div>
              </div>
            )}
          </div>

          {/* Glisser-déposer */}
          {dragging && (
            <div className="absolute inset-2 z-20 rounded-[22px] border-2 border-dashed border-[rgba(10,132,255,0.7)] bg-[rgba(10,132,255,0.10)] backdrop-blur-sm flex flex-col items-center justify-center gap-3 pointer-events-none fade-in">
              <UploadCloud size={36} className="text-info" />
              <p className="text-[15px] font-semibold text-fg">{t('files.drop', { dir: `/${dir}` })}</p>
            </div>
          )}
        </>
      )}

      {/* Envoi en cours */}
      {upload && (
        <div className="absolute bottom-4 right-4 z-30 glass-strong rounded-2xl px-4 py-3 w-64 pop-in">
          <div className="flex items-center justify-between text-xs mb-2">
            <span className="text-fg font-medium">{t('files.uploading', { count: upload.count })}</span>
            <span className="text-fg-3 font-mono">{Math.round(upload.progress * 100)} %</span>
          </div>
          <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
            <div className="h-full rounded-full bg-info transition-[width] duration-200" style={{ width: `${upload.progress * 100}%` }} />
          </div>
        </div>
      )}

      <NameDialog
        open={!!dialog}
        title={dialog === 'folder' ? t('files.newFolder') : t('files.newFile')}
        icon={dialog === 'folder' ? FolderPlus : FilePlus2}
        onClose={() => setDialog(null)}
        onSubmit={doCreate}
      />
      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={doDelete}
        busy={deleting}
        title={t('files.deleteTitle', { count: confirmDelete?.length || 0 })}
        message={t('files.deleteBody', { names: (confirmDelete || []).slice(0, 5).map(p => p.split('/').pop()).join(', ') + ((confirmDelete?.length || 0) > 5 ? '…' : '') })}
        confirmLabel={t('files.delete')}
      />
    </div>
  );
}
