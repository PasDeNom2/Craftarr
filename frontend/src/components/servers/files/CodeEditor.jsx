import React, { useMemo, useRef, useCallback, useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import clsx from 'clsx';
import { ChevronUp, ChevronDown, X, CaseSensitive, Replace, ReplaceAll, ChevronRight } from 'lucide-react';
import { useI18n } from '../../../i18n';

// Au-delà, la coloration est coupée pour garder une frappe fluide
const HIGHLIGHT_LIMIT = 300 * 1024;
const MAX_MATCHES = 5000;
const LINE_HEIGHT = 20; // 12.5px × 1.6

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const span = (cls, s) => `<span class="${cls}">${esc(s)}</span>`;

const VALUE_RE = /("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|\b(true|false|null|yes|no|on|off)\b|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[dfLbsDF]?\b)|(\s#.*$|\s\/\/.*$)/g;

function values(text, inlineComments = true) {
  let out = '';
  let last = 0;
  text.replace(VALUE_RE, (m, str, bool, num, comment, idx) => {
    if (comment && !inlineComments) return m;
    out += esc(text.slice(last, idx));
    out += span(str ? 'tk-str' : bool ? 'tk-bool' : num ? 'tk-num' : 'tk-com', m);
    last = idx + m.length;
    return m;
  });
  return out + esc(text.slice(last));
}

function highlightLine(line, lang) {
  if (lang === 'plain') return esc(line);
  if (lang === 'log') {
    if (/\b(ERROR|FATAL|SEVERE)\b|Exception/.test(line)) return span('tk-err', line);
    if (/\bWARN(ING)?\b/.test(line)) return span('tk-warn', line);
    const m = line.match(/^(\[[^\]]*\](?: \[[^\]]*\])*:?)(.*)$/);
    return m ? span('tk-com', m[1]) + esc(m[2]) : esc(line);
  }
  if (/^\s*(#|\/\/|;|!)/.test(line)) return span('tk-com', line);
  if (lang === 'toml' || lang === 'properties' || lang === 'yaml') {
    if (/^\s*\[.*\]\s*$/.test(line)) return span('tk-sec', line);
    const m = line.match(/^(\s*(?:- )?)([^=:#\s"'][^=:]*?|"[^"]*")(\s*[=:])(.*)$/);
    if (m) return esc(m[1]) + span('tk-key', m[2]) + span('tk-punct', m[3]) + values(m[4], lang !== 'properties');
    return values(line, lang !== 'properties');
  }
  if (lang === 'json') {
    const m = line.match(/^(\s*)("(?:[^"\\]|\\.)*")(\s*:)(.*)$/);
    if (m) return esc(m[1]) + span('tk-key', m[2]) + span('tk-punct', m[3]) + values(m[4]);
    return values(line);
  }
  return values(line);
}

function findAll(text, query, caseSensitive) {
  if (!query) return [];
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const out = [];
  let i = hay.indexOf(needle);
  while (i !== -1 && out.length < MAX_MATCHES) {
    out.push(i);
    i = hay.indexOf(needle, i + Math.max(1, needle.length));
  }
  return out;
}

/**
 * Éditeur léger : numéros de ligne, coloration (toml/json/properties/yaml/log), Tab / Maj+Tab,
 * Ctrl+S, Ctrl+F (rechercher / remplacer). Technique du calque : un <pre> coloré sous un
 * <textarea> au texte transparent, plus un calque pour surligner les résultats de recherche.
 */
const CodeEditor = forwardRef(function CodeEditor({ value, onChange, language = 'plain', onSave, onCursor, readOnly }, ref) {
  const { t } = useI18n();
  const taRef = useRef(null);
  const preRef = useRef(null);
  const markRef = useRef(null);
  const gutterRef = useRef(null);
  const findRef = useRef(null);
  const charWidth = useRef(null);

  const [search, setSearch] = useState({ open: false, query: '', replace: '', caseSensitive: false, showReplace: false });
  const [current, setCurrent] = useState(0);

  const lineCount = useMemo(() => {
    let n = 1;
    for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) === 10) n++;
    return n;
  }, [value]);

  const html = useMemo(() => {
    if (value.length > HIGHLIGHT_LIMIT) return null;
    return value.split('\n').map(l => highlightLine(l, language)).join('\n') + '\n';
  }, [value, language]);

  const gutter = useMemo(() => Array.from({ length: lineCount }, (_, i) => i + 1).join('\n'), [lineCount]);

  const matches = useMemo(
    () => (search.open ? findAll(value, search.query, search.caseSensitive) : []),
    [value, search.open, search.query, search.caseSensitive],
  );
  const cur = matches.length ? Math.min(current, matches.length - 1) : -1;

  // Calque des résultats : texte transparent, seuls les <mark> sont visibles
  const marksHtml = useMemo(() => {
    if (!matches.length) return null;
    let out = '';
    let last = 0;
    const len = search.query.length;
    matches.forEach((pos, i) => {
      out += esc(value.slice(last, pos));
      out += `<mark class="${i === cur ? 'find-cur' : 'find-hit'}">${esc(value.slice(pos, pos + len))}</mark>`;
      last = pos + len;
    });
    return out + esc(value.slice(last)) + '\n';
  }, [matches, cur, value, search.query]);

  const syncScroll = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    const tr = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
    if (preRef.current) preRef.current.style.transform = tr;
    if (markRef.current) markRef.current.style.transform = tr;
    if (gutterRef.current) gutterRef.current.style.transform = `translateY(${-ta.scrollTop}px)`;
  }, []);
  useEffect(syncScroll, [marksHtml, html, syncScroll]);

  const reportCursor = useCallback(() => {
    const ta = taRef.current;
    if (!ta || !onCursor) return;
    const before = ta.value.slice(0, ta.selectionStart);
    const line = before.split('\n').length;
    const col = ta.selectionStart - before.lastIndexOf('\n');
    onCursor({ line, col, selected: Math.abs(ta.selectionEnd - ta.selectionStart) });
  }, [onCursor]);

  // Amène un résultat dans la zone visible (sans voler le focus au champ de recherche)
  const reveal = useCallback((pos, len) => {
    const ta = taRef.current;
    if (!ta) return;
    if (charWidth.current == null) {
      const probe = document.createElement('span');
      probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${getComputedStyle(ta).font}`;
      probe.textContent = 'M'.repeat(100);
      document.body.appendChild(probe);
      charWidth.current = probe.getBoundingClientRect().width / 100;
      probe.remove();
    }
    const before = value.slice(0, pos);
    const line = before.split('\n').length - 1;
    const col = pos - (before.lastIndexOf('\n') + 1);
    const y = 12 + line * LINE_HEIGHT;
    const x = 12 + col * charWidth.current;
    if (y < ta.scrollTop + 20 || y > ta.scrollTop + ta.clientHeight - 40) ta.scrollTop = Math.max(0, y - ta.clientHeight / 2);
    if (x < ta.scrollLeft + 20 || x + len * charWidth.current > ta.scrollLeft + ta.clientWidth - 40) ta.scrollLeft = Math.max(0, x - ta.clientWidth / 3);
    ta.setSelectionRange(pos, pos + len);
    syncScroll();
  }, [value, syncScroll]);

  // Ne suit un résultat que lorsqu'on navigue ou change la recherche — pas pendant la frappe dans le texte
  const matchesRef = useRef(matches);
  matchesRef.current = matches;
  useEffect(() => {
    const list = matchesRef.current;
    if (search.open && list.length) reveal(list[Math.min(current, list.length - 1)], search.query.length);
  }, [current, search.query, search.caseSensitive, search.open]); // eslint-disable-line react-hooks/exhaustive-deps

  const openSearch = useCallback(() => {
    const ta = taRef.current;
    const sel = ta && ta.selectionStart !== ta.selectionEnd ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : '';
    setSearch(s => ({ ...s, open: true, query: sel && !sel.includes('\n') ? sel : s.query }));
    requestAnimationFrame(() => { findRef.current?.focus(); findRef.current?.select(); });
  }, []);

  function closeSearch() {
    setSearch(s => ({ ...s, open: false }));
    taRef.current?.focus();
  }

  useImperativeHandle(ref, () => ({ openSearch, focus: () => taRef.current?.focus() }), [openSearch]);

  function step(dir) {
    if (!matches.length) return;
    setCurrent(c => (Math.min(c, matches.length - 1) + dir + matches.length) % matches.length);
  }

  function replaceOne() {
    if (readOnly || cur < 0) return;
    const pos = matches[cur];
    onChange(value.slice(0, pos) + search.replace + value.slice(pos + search.query.length));
  }
  function replaceAll() {
    if (readOnly || !matches.length) return;
    let out = '';
    let last = 0;
    for (const pos of matches) { out += value.slice(last, pos) + search.replace; last = pos + search.query.length; }
    onChange(out + value.slice(last));
  }

  // Modifie le texte en passant par execCommand pour garder l'annulation (Ctrl+Z) du navigateur
  function replaceRange(start, end, text, selStart, selEnd) {
    const ta = taRef.current;
    ta.setSelectionRange(start, end);
    if (!document.execCommand('insertText', false, text)) {
      onChange(ta.value.slice(0, start) + text + ta.value.slice(end));
    }
    requestAnimationFrame(() => ta.setSelectionRange(selStart, selEnd ?? selStart));
  }

  function onKeyDown(e) {
    const ta = e.currentTarget;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); onSave?.(); return; }
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); openSearch(); return; }
    if (mod && e.key.toLowerCase() === 'h') { e.preventDefault(); setSearch(s => ({ ...s, showReplace: true })); openSearch(); return; }
    if (e.key === 'F3') { e.preventDefault(); step(e.shiftKey ? -1 : 1); return; }
    if (e.key === 'Escape' && search.open) { e.preventDefault(); closeSearch(); return; }
    if (readOnly) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en, value: v } = ta;
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      if (e.shiftKey || v.slice(s, en).includes('\n')) {
        const lines = v.slice(lineStart, en).split('\n');
        const text = (e.shiftKey ? lines.map(l => l.replace(/^( {1,2}|\t)/, '')) : lines.map(l => '  ' + l)).join('\n');
        replaceRange(lineStart, en, text, lineStart, lineStart + text.length);
      } else {
        replaceRange(s, en, '  ', s + 2);
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      // Conserve l'indentation de la ligne courante
      const { selectionStart: s, selectionEnd: en, value: v } = ta;
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      const indent = v.slice(lineStart, s).match(/^[ \t]*/)[0];
      if (indent) {
        e.preventDefault();
        replaceRange(s, en, '\n' + indent, s + 1 + indent.length);
      }
    }
  }

  function onFindKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
    else if (e.key === 'F3') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); onSave?.(); }
    else if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); findRef.current?.select(); }
  }

  const common = 'font-mono text-[12.5px] leading-[1.6] py-3 pr-6 pl-3 whitespace-pre';
  const miniInput = 'h-7 w-full pl-2.5 rounded-lg bg-[rgba(118,118,128,0.2)] border border-transparent text-[12px] font-mono text-fg placeholder:text-fg-3 outline-none focus:border-white/20';

  return (
    <div className="relative flex-1 min-h-0 flex overflow-hidden">
      <div className="relative shrink-0 overflow-hidden select-none border-r border-white/[0.06]" aria-hidden>
        <pre ref={gutterRef} className="font-mono text-[12.5px] leading-[1.6] py-3 pl-4 pr-3 text-right" style={{ color: 'rgba(235,235,245,0.22)', minWidth: `${String(lineCount).length + 3}ch` }}>
          {gutter}
        </pre>
      </div>
      <div className="relative flex-1 min-w-0 overflow-hidden">
        {marksHtml != null && (
          <pre
            ref={markRef}
            aria-hidden
            className={`find-layer absolute top-0 left-0 m-0 pointer-events-none ${common}`}
            style={{ tabSize: 2, color: 'transparent' }}
            dangerouslySetInnerHTML={{ __html: marksHtml }}
          />
        )}
        {html != null && (
          <pre
            ref={preRef}
            aria-hidden
            className={`code-hl absolute top-0 left-0 m-0 pointer-events-none text-fg ${common}`}
            style={{ tabSize: 2 }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
        <textarea
          ref={taRef}
          value={value}
          readOnly={readOnly}
          onChange={e => onChange(e.target.value)}
          onScroll={syncScroll}
          onKeyDown={onKeyDown}
          onKeyUp={reportCursor}
          onClick={reportCursor}
          onSelect={reportCursor}
          wrap="off"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          className={`code-ta absolute inset-0 w-full h-full resize-none outline-none border-none bg-transparent overflow-auto ${common}`}
          style={{ color: html != null ? 'transparent' : 'var(--fg)', caretColor: 'var(--fg)', tabSize: 2 }}
        />

        {/* Rechercher / remplacer */}
        {search.open && (
          <div className="glass-strong absolute top-2 right-4 z-10 rounded-2xl p-1.5 w-[min(420px,calc(100%-2rem))] pop-in origin-top-right">
            <div className="flex items-center gap-1">
              <button
                className="icon-btn !h-7 !min-w-7"
                onClick={() => setSearch(s => ({ ...s, showReplace: !s.showReplace }))}
                aria-label={t('files.toggleReplace')}
                title={t('files.toggleReplace')}
                disabled={readOnly}
              >
                <ChevronRight size={14} className={clsx('transition-transform', search.showReplace && 'rotate-90')} />
              </button>
              <div className="relative flex-1 min-w-0">
                <input
                  ref={findRef}
                  className={clsx(miniInput, 'pr-16', search.query && !matches.length && '!border-[rgba(255,69,58,0.6)]')}
                  placeholder={t('files.find')}
                  value={search.query}
                  onChange={e => { setSearch(s => ({ ...s, query: e.target.value })); setCurrent(0); }}
                  onKeyDown={onFindKey}
                  spellCheck={false}
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10.5px] font-mono text-fg-3 tabular-nums">
                  {search.query ? `${matches.length ? cur + 1 : 0}/${matches.length}${matches.length >= MAX_MATCHES ? '+' : ''}` : ''}
                </span>
              </div>
              <button
                className="icon-btn !h-7 !min-w-7"
                aria-pressed={search.caseSensitive}
                onClick={() => setSearch(s => ({ ...s, caseSensitive: !s.caseSensitive }))}
                title={t('files.matchCase')}
                aria-label={t('files.matchCase')}
              >
                <CaseSensitive size={15} />
              </button>
              <button className="icon-btn !h-7 !min-w-7" onClick={() => step(-1)} disabled={!matches.length} title={t('files.prevMatch')} aria-label={t('files.prevMatch')}><ChevronUp size={14} /></button>
              <button className="icon-btn !h-7 !min-w-7" onClick={() => step(1)} disabled={!matches.length} title={t('files.nextMatch')} aria-label={t('files.nextMatch')}><ChevronDown size={14} /></button>
              <button className="icon-btn !h-7 !min-w-7" onClick={closeSearch} aria-label="×"><X size={14} /></button>
            </div>
            {search.showReplace && !readOnly && (
              <div className="flex items-center gap-1 mt-1 pl-8 fade-in">
                <input
                  className={clsx(miniInput, 'flex-1 min-w-0')}
                  placeholder={t('files.replaceWith')}
                  value={search.replace}
                  onChange={e => setSearch(s => ({ ...s, replace: e.target.value }))}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); if (e.ctrlKey || e.metaKey) replaceAll(); else replaceOne(); }
                    else onFindKey(e);
                  }}
                  spellCheck={false}
                />
                <button className="icon-btn !h-7 !min-w-7" onClick={replaceOne} disabled={cur < 0} title={t('files.replaceOne')} aria-label={t('files.replaceOne')}><Replace size={14} /></button>
                <button className="icon-btn !h-7 !min-w-7" onClick={replaceAll} disabled={!matches.length} title={t('files.replaceAll')} aria-label={t('files.replaceAll')}><ReplaceAll size={14} /></button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

export default CodeEditor;
