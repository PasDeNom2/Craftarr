import React, { useMemo, useRef, useCallback } from 'react';

// Au-delà, la coloration est coupée pour garder une frappe fluide
const HIGHLIGHT_LIMIT = 300 * 1024;

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

/**
 * Éditeur léger : numéros de ligne, coloration (toml/json/properties/yaml/log), Tab / Maj+Tab,
 * Ctrl+S. Technique du calque : un <pre> coloré sous un <textarea> au texte transparent.
 */
export default function CodeEditor({ value, onChange, language = 'plain', onSave, onCursor, readOnly }) {
  const taRef = useRef(null);
  const preRef = useRef(null);
  const gutterRef = useRef(null);

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

  const syncScroll = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    if (preRef.current) preRef.current.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
    if (gutterRef.current) gutterRef.current.style.transform = `translateY(${-ta.scrollTop}px)`;
  }, []);

  const reportCursor = useCallback(() => {
    const ta = taRef.current;
    if (!ta || !onCursor) return;
    const before = ta.value.slice(0, ta.selectionStart);
    const line = before.split('\n').length;
    const col = ta.selectionStart - before.lastIndexOf('\n');
    onCursor({ line, col, selected: Math.abs(ta.selectionEnd - ta.selectionStart) });
  }, [onCursor]);

  // Modifie le texte en passant par execCommand pour garder l'annulation (Ctrl+Z) du navigateur
  function replaceRange(start, end, text, selStart, selEnd) {
    const ta = taRef.current;
    ta.setSelectionRange(start, end);
    if (!document.execCommand('insertText', false, text)) {
      const v = ta.value.slice(0, start) + text + ta.value.slice(end);
      onChange(v);
    }
    requestAnimationFrame(() => ta.setSelectionRange(selStart, selEnd ?? selStart));
  }

  function onKeyDown(e) {
    const ta = e.currentTarget;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      onSave?.();
      return;
    }
    if (readOnly) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en, value: v } = ta;
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      if (e.shiftKey || v.slice(s, en).includes('\n')) {
        // (Dés)indentation des lignes sélectionnées
        const block = v.slice(lineStart, en);
        const lines = block.split('\n');
        const next = e.shiftKey ? lines.map(l => l.replace(/^( {1,2}|\t)/, '')) : lines.map(l => '  ' + l);
        const text = next.join('\n');
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

  const common = 'font-mono text-[12.5px] leading-[1.6] py-3 pr-6 pl-3 whitespace-pre';

  return (
    <div className="relative flex-1 min-h-0 flex overflow-hidden">
      <div className="relative shrink-0 overflow-hidden select-none border-r border-white/[0.06]" aria-hidden>
        <pre ref={gutterRef} className="font-mono text-[12.5px] leading-[1.6] py-3 pl-4 pr-3 text-right" style={{ color: 'rgba(235,235,245,0.22)', minWidth: `${String(lineCount).length + 3}ch` }}>
          {gutter}
        </pre>
      </div>
      <div className="relative flex-1 min-w-0 overflow-hidden">
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
          style={{
            color: html != null ? 'transparent' : 'var(--fg)',
            caretColor: 'var(--fg)',
            tabSize: 2,
          }}
        />
      </div>
    </div>
  );
}
