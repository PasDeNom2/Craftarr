import React, { useMemo, useRef, useState, useEffect } from 'react';
import clsx from 'clsx';
import { CornerDownLeft } from 'lucide-react';
import { useI18n } from '../../../i18n';

// Commandes courantes (syntaxe officielle, indépendante de la langue). <player> = joueur en ligne.
export const COMMANDS = [
  'list', 'say <message>', 'tell <player> <message>', 'kick <player> [reason]', 'ban <player> [reason]',
  'pardon <player>', 'op <player>', 'deop <player>', 'whitelist add <player>', 'whitelist remove <player>',
  'whitelist list', 'gamemode <survival|creative|adventure|spectator> <player>', 'tp <player> <target>',
  'give <player> <item> [count]', 'kill <player>', 'time set <day|noon|night|midnight>',
  'weather <clear|rain|thunder>', 'difficulty <peaceful|easy|normal|hard>', 'gamerule <rule> <value>',
  'save-all', 'seed', 'tps', 'neoforge tps', 'forge tps', 'spark tps', 'stop',
].map(syntax => {
  const words = syntax.split(' ');
  const literal = [];
  for (const w of words) { if (/^[<[]/.test(w)) break; literal.push(w); }
  return { syntax, name: literal.join(' '), args: words.slice(literal.length) };
});

function historyKey(serverId) { return `craftarr_cmd_history_${serverId}`; }
function loadHistory(serverId) {
  try { return JSON.parse(localStorage.getItem(historyKey(serverId)) || '[]'); } catch { return []; }
}

/**
 * Champ de commande de la console : historique persistant (↑/↓), auto-complétion (Tab) des
 * commandes et des joueurs en ligne, et garde-fou sur « stop » (préférer le bouton Arrêter,
 * qui sauvegarde proprement).
 */
export default function CommandInput({ serverId, disabled, onSend, players = [], inputRef, sending, insert }) {
  const { t } = useI18n();
  const [value, setValue] = useState('');
  const [history, setHistory] = useState(() => loadHistory(serverId));
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [selected, setSelected] = useState(0);
  const [showSuggest, setShowSuggest] = useState(false);
  const localRef = useRef(null);
  const ref = inputRef || localRef;

  useEffect(() => { setHistory(loadHistory(serverId)); }, [serverId]);

  // Insertion depuis l'extérieur (clic sur un joueur du panneau) : { text, key }
  useEffect(() => {
    if (!insert?.text) return;
    setValue(v => (v.trim() ? v.replace(/\s*$/, ' ') : '') + insert.text + ' ');
    ref.current?.focus();
  }, [insert?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Suggestions : nom de commande (1er mot) ou joueur en ligne (argument <player>)
  const suggestions = useMemo(() => {
    const text = value.replace(/^\//, '');
    if (!text) return [];
    const endsWithSpace = /\s$/.test(text);
    const words = text.trim().split(/\s+/);
    const current = endsWithSpace ? '' : words[words.length - 1];
    const done = endsWithSpace ? words : words.slice(0, -1);

    // Commandes qui correspondent à ce qui est déjà tapé
    const cmdMatches = COMMANDS.filter(c => c.name.startsWith(text.trimStart().toLowerCase()) && c.name !== text.trim());
    if (cmdMatches.length && done.length < 2) {
      return cmdMatches.slice(0, 8).map(c => ({ label: c.syntax, insert: c.name + (c.args.length ? ' ' : ''), kind: 'cmd' }));
    }

    // Argument joueur de la commande reconnue
    const cmd = COMMANDS.filter(c => (done.join(' ') + ' ').startsWith(c.name + ' ')).sort((a, b) => b.name.length - a.name.length)[0];
    if (!cmd) return [];
    const argIndex = done.length - cmd.name.split(' ').length;
    const arg = cmd.args[argIndex];
    if (!arg) return [];
    const base = done.join(' ') + ' ';
    if (/player|target/.test(arg)) {
      return players
        .filter(p => p.toLowerCase().startsWith(current.toLowerCase()) && p !== current)
        .slice(0, 8)
        .map(p => ({ label: p, insert: base + p + ' ', kind: 'player' }));
    }
    const choices = arg.match(/^<([^>]+\|[^>]+)>$/);
    if (choices) {
      return choices[1].split('|').filter(c => c.startsWith(current) && c !== current)
        .map(c => ({ label: c, insert: base + c + ' ', kind: 'choice' }));
    }
    return [{ label: `${cmd.syntax}`, insert: null, kind: 'hint' }];
  }, [value, players]);

  const actionable = suggestions.filter(s => s.insert);
  const open = showSuggest && suggestions.length > 0;

  function accept(s) {
    if (!s?.insert) return;
    setValue(s.insert);
    setSelected(0);
    ref.current?.focus();
  }

  function submit(e) {
    e.preventDefault();
    const cmd = value.trim().replace(/^\//, '');
    if (!cmd || disabled) return;
    const next = [cmd, ...history.filter(h => h !== cmd)].slice(0, 100);
    setHistory(next);
    try { localStorage.setItem(historyKey(serverId), JSON.stringify(next)); } catch {}
    setHistoryIdx(-1);
    setShowSuggest(false);
    onSend(cmd).then(ok => { if (ok !== false) setValue(''); });
  }

  function onKeyDown(e) {
    // Entrée gérée ici (preventDefault évite la double soumission implicite du formulaire)
    if (e.key === 'Enter') {
      e.preventDefault();
      submit(e);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      accept(actionable[Math.min(selected, actionable.length - 1)] || actionable[0]);
      return;
    }
    if (e.key === 'Escape') { setShowSuggest(false); return; }
    if (open && actionable.length && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      setSelected(i => (i + (e.key === 'ArrowDown' ? 1 : -1) + actionable.length) % actionable.length);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const idx = Math.min(historyIdx + 1, history.length - 1);
      if (idx >= 0) { setHistoryIdx(idx); setValue(history[idx]); setShowSuggest(false); }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const idx = Math.max(historyIdx - 1, -1);
      setHistoryIdx(idx);
      setValue(idx === -1 ? '' : history[idx]);
      setShowSuggest(false);
    }
  }

  return (
    <form onSubmit={submit} className="relative shrink-0 border-t border-line bg-bg-2">
      {open && (
        <ul
          className="absolute left-3 right-3 bottom-full mb-1 rounded-lg overflow-hidden py-1 z-20 pop-in"
          style={{ background: 'var(--surface)', boxShadow: 'var(--shadow-pop)' }}
          role="listbox"
        >
          {suggestions.map((s, i) => {
            const active = s.insert && actionable.indexOf(s) === selected;
            return (
              <li
                key={s.label + i}
                role="option"
                aria-selected={active}
                onMouseDown={e => { e.preventDefault(); accept(s); }}
                className={clsx(
                  'flex items-center justify-between gap-3 px-3 py-1.5 font-mono text-xs',
                  s.insert ? 'cursor-pointer' : 'cursor-default',
                  active ? 'bg-surface-2 text-fg' : 'text-fg-2 hover:bg-surface-2',
                )}
              >
                <span className="truncate">{s.label}</span>
                {active && <kbd className="text-[10px] text-fg-3 border border-line rounded px-1">Tab</kbd>}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex items-center gap-2 px-4 h-11">
        <span className={clsx('font-mono text-sm select-none', disabled ? 'text-fg-3' : 'text-fg')}>{'>'}</span>
        <input
          ref={ref}
          className="flex-1 bg-transparent border-none outline-none text-[13px] font-mono text-fg placeholder:text-fg-3 disabled:opacity-40"
          placeholder={disabled ? t('console.stoppedPlaceholder') : t('console.placeholder')}
          value={value}
          onChange={e => { setValue(e.target.value); setHistoryIdx(-1); setSelected(0); setShowSuggest(true); }}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => setShowSuggest(false), 120)}
          onFocus={() => setShowSuggest(true)}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          aria-label={t('console.placeholder')}
        />
        {value.trim() && (
          <button
            type="submit"
            disabled={disabled || sending}
            className="flex items-center gap-1.5 text-[11px] text-fg-2 hover:text-fg font-mono disabled:opacity-40 transition-colors"
          >
            {sending ? '…' : <><CornerDownLeft size={12} /> {t('console.send')}</>}
          </button>
        )}
      </div>
    </form>
  );
}
