/**
 * Comparaison de versions de mods et test d'appartenance à une plage, pour savoir si une
 * incompatibilité déclarée (« breaks » Fabric, type="incompatible" Forge/NeoForge) concerne
 * VRAIMENT la version installée. Sans ça : 47 faux « problèmes » sur un pack qui marche.
 *
 * Prudence : toute plage qu'on ne sait pas interpréter est considérée comme NON satisfaite
 * (on préfère taire un problème douteux qu'inquiéter à tort).
 */

/** "1.20.1-0.5.3+build.12" → { nums: [1,20,1], pre: '0.5.3' } (la partie +build est ignorée). */
function parse(v) {
  const s = String(v || '').trim().replace(/^v/i, '').split('+')[0];
  const m = s.match(/^(\d+(?:\.\d+)*)(?:-(.+))?/);
  if (!m) return null;
  return { nums: m[1].split('.').map(n => parseInt(n, 10)), pre: m[2] || null };
}

function compare(a, b) {
  const pa = typeof a === 'string' ? parse(a) : a;
  const pb = typeof b === 'string' ? parse(b) : b;
  if (!pa || !pb) return null;
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const d = (pa.nums[i] || 0) - (pb.nums[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  // Une pré-version (1.0.0-beta) précède la version finale (1.0.0)
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && pb.pre) return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0;
  return 0;
}

/** Un prédicat Fabric unitaire : "*", "1.2.x", ">=1.2", "<1", "~1.2", "^1.2", "=1.2", "1.2.3". */
function matchFabricTerm(version, term) {
  const t = term.trim();
  if (!t || t === '*') return true;
  const x = t.match(/^(\d+(?:\.\d+)*)\.[xX*]$/);
  if (x) {
    const prefix = x[1].split('.').map(Number);
    const p = parse(version);
    return !!p && prefix.every((n, i) => p.nums[i] === n);
  }
  const m = t.match(/^(>=|<=|>|<|=|~|\^)?\s*(.+)$/);
  if (!m) return null;
  const [, op = '=', ref] = m;
  const c = compare(version, ref);
  if (c === null) return null;
  const r = parse(ref);
  switch (op) {
    case '>=': return c >= 0;
    case '<=': return c <= 0;
    case '>': return c > 0;
    case '<': return c < 0;
    case '=': return c === 0;
    case '~': { // même majeur.mineur, >= ref
      const p = parse(version);
      return c >= 0 && p.nums[0] === r.nums[0] && (p.nums[1] || 0) === (r.nums[1] || 0);
    }
    case '^': { // même majeur, >= ref
      const p = parse(version);
      return c >= 0 && p.nums[0] === r.nums[0];
    }
    default: return null;
  }
}

/** Plage Fabric : chaîne (termes séparés par des espaces = ET) ou tableau (= OU). */
function satisfiesFabric(version, range) {
  if (range === undefined || range === null) return true;
  const ranges = Array.isArray(range) ? range : [range];
  return ranges.some(r => String(r).split(/\s+/).filter(Boolean).every(term => matchFabricTerm(version, term) === true)
    || String(r).trim() === '' || String(r).trim() === '*');
}

/** Plage Maven (Forge/NeoForge) : "[1.0,2.0)", "[1.2,)", "(,3]", "1.0" (= au moins), plusieurs plages séparées par des virgules. */
function satisfiesMaven(version, range) {
  const r = String(range || '').trim();
  if (!r || r === '*') return true;
  if (!/^[[(]/.test(r)) return compare(version, r) !== null && compare(version, r) >= 0;
  const parts = r.match(/[[(][^\])]*[\])]/g);
  if (!parts) return false;
  return parts.some(p => {
    const lowIncl = p[0] === '[';
    const highIncl = p[p.length - 1] === ']';
    const inner = p.slice(1, -1);
    const [low, high] = inner.includes(',') ? inner.split(',').map(s => s.trim()) : [inner.trim(), inner.trim()];
    if (low) { const c = compare(version, low); if (c === null || c < 0 || (c === 0 && !lowIncl)) return false; }
    if (high) { const c = compare(version, high); if (c === null || c > 0 || (c === 0 && !highIncl)) return false; }
    return true;
  });
}

module.exports = { parse, compare, satisfiesFabric, satisfiesMaven };
