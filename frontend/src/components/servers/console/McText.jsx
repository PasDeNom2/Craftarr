import React from 'react';

// Couleurs officielles des codes § de Minecraft
const COLORS = {
  0: '#000000', 1: '#0000AA', 2: '#00AA00', 3: '#00AAAA', 4: '#AA0000', 5: '#AA00AA', 6: '#FFAA00', 7: '#AAAAAA',
  8: '#555555', 9: '#5555FF', a: '#55FF55', b: '#55FFFF', c: '#FF5555', d: '#FF55FF', e: '#FFFF55', f: '#FFFFFF',
};

/**
 * Affiche un texte contenant des codes couleur Minecraft (§a, §l…) — typiquement la réponse
 * d'une commande RCON (« §6TPS from last 1m… »). Sans code, le texte est rendu tel quel.
 */
export default function McText({ text, highlight }) {
  if (!text) return null;
  if (!text.includes('§')) return <Highlight text={text} term={highlight} />;

  const parts = [];
  let style = {};
  let buf = '';
  const flush = () => { if (buf) { parts.push({ text: buf, style: { ...style } }); buf = ''; } };

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '§' && i + 1 < text.length) {
      flush();
      const code = text[++i].toLowerCase();
      if (COLORS[code]) style = { color: COLORS[code] };
      else if (code === 'l') style.fontWeight = 700;
      else if (code === 'o') style.fontStyle = 'italic';
      else if (code === 'n') style.textDecoration = 'underline';
      else if (code === 'm') style.textDecoration = 'line-through';
      else if (code === 'r') style = {};
      continue;
    }
    buf += text[i];
  }
  flush();
  return parts.map((p, i) => <span key={i} style={p.style}><Highlight text={p.text} term={highlight} /></span>);
}

/** Surligne les occurrences de la recherche (insensible à la casse). */
export function Highlight({ text, term }) {
  if (!term || !text) return text;
  const lower = text.toLowerCase();
  const needle = term.toLowerCase();
  const out = [];
  let from = 0;
  let idx;
  while ((idx = lower.indexOf(needle, from)) !== -1) {
    if (idx > from) out.push(text.slice(from, idx));
    out.push(<mark key={idx} className="bg-fg text-inverse rounded-[2px] px-px">{text.slice(idx, idx + needle.length)}</mark>);
    from = idx + needle.length;
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}
