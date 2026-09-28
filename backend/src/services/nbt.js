// NBT (Java Edition, big-endian) ⇄ SNBT, sans dépendance.
//
// Sert à éditer level.dat, *.nbt, playerdata/*.dat… dans le navigateur : le binaire (gzip, zlib ou
// brut) est converti en SNBT — le texte des commandes Minecraft, où chaque nombre garde son type
// (1b, 2s, 3, 4L, 5.0f, 6.0d, [I; …]) — puis reconverti à l'identique à l'enregistrement.
const zlib = require('zlib');

const T = { END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6, BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12 };

// ─── Binaire → arbre ─────────────────────────────────────────
function decompress(buf) {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return { data: zlib.gunzipSync(buf), compression: 'gzip' };
  if (buf.length >= 2 && buf[0] === 0x78 && [0x01, 0x5e, 0x9c, 0xda].includes(buf[1])) {
    try { return { data: zlib.inflateSync(buf), compression: 'zlib' }; } catch { /* pas du zlib */ }
  }
  return { data: buf, compression: 'none' };
}

function readTree(buf) {
  let o = 0;
  const need = n => { if (o + n > buf.length) throw new Error('NBT tronqué'); };
  const u8 = () => { need(1); return buf.readUInt8(o++); };
  const i8 = () => { need(1); return buf.readInt8(o++); };
  const i16 = () => { need(2); const v = buf.readInt16BE(o); o += 2; return v; };
  const u16 = () => { need(2); const v = buf.readUInt16BE(o); o += 2; return v; };
  const i32 = () => { need(4); const v = buf.readInt32BE(o); o += 4; return v; };
  const i64 = () => { need(8); const v = buf.readBigInt64BE(o); o += 8; return v; };
  const f32 = () => { need(4); const v = buf.readFloatBE(o); o += 4; return v; };
  const f64 = () => { need(8); const v = buf.readDoubleBE(o); o += 8; return v; };
  const str = () => { const n = u16(); need(n); const s = buf.toString('utf8', o, o + n); o += n; return s; };
  const count = () => { const n = i32(); if (n < 0 || n > 50_000_000) throw new Error('Longueur NBT invalide'); return n; };

  function payload(type, depth) {
    if (depth > 512) throw new Error('NBT trop profond');
    switch (type) {
      case T.BYTE: return i8();
      case T.SHORT: return i16();
      case T.INT: return i32();
      case T.LONG: return i64();
      case T.FLOAT: return f32();
      case T.DOUBLE: return f64();
      case T.STRING: return str();
      case T.BYTE_ARRAY: { const n = count(); const a = []; for (let i = 0; i < n; i++) a.push(i8()); return a; }
      case T.INT_ARRAY: { const n = count(); const a = []; for (let i = 0; i < n; i++) a.push(i32()); return a; }
      case T.LONG_ARRAY: { const n = count(); const a = []; for (let i = 0; i < n; i++) a.push(i64()); return a; }
      case T.LIST: {
        const elType = u8();
        const n = count();
        if (elType > 12) throw new Error('Type NBT inconnu');
        const items = [];
        for (let i = 0; i < n; i++) items.push(payload(elType, depth + 1));
        return { elType, items };
      }
      case T.COMPOUND: {
        const entries = [];
        for (;;) {
          const t = u8();
          if (t === T.END) break;
          if (t > 12) throw new Error('Type NBT inconnu');
          const name = str();
          entries.push([name, { type: t, value: payload(t, depth + 1) }]);
        }
        return entries;
      }
      default: throw new Error(`Type NBT inconnu (${type})`);
    }
  }

  const type = u8();
  if (type !== T.COMPOUND && type !== T.LIST) throw new Error('Ce fichier n\'est pas du NBT');
  const name = str();
  const root = { type, value: payload(type, 0) };
  if (o !== buf.length) throw new Error('Données en trop après le NBT');
  return { name, root };
}

function parseNbt(fileBuf) {
  const { data, compression } = decompress(fileBuf);
  const { name, root } = readTree(data);
  return { name, root, compression };
}

// ─── Arbre → binaire ─────────────────────────────────────────
function writeTree(name, root) {
  const chunks = [];
  const b = (n, fn) => { const x = Buffer.alloc(n); fn(x); chunks.push(x); };
  const u8 = v => b(1, x => x.writeUInt8(v));
  const i8 = v => b(1, x => x.writeInt8(v));
  const i16 = v => b(2, x => x.writeInt16BE(v));
  const i32 = v => b(4, x => x.writeInt32BE(v));
  const i64 = v => b(8, x => x.writeBigInt64BE(BigInt(v)));
  const str = s => { const d = Buffer.from(s, 'utf8'); if (d.length > 65535) throw new Error('Chaîne trop longue'); b(2, x => x.writeUInt16BE(d.length)); chunks.push(d); };

  function payload(type, v) {
    switch (type) {
      case T.BYTE: return i8(v);
      case T.SHORT: return i16(v);
      case T.INT: return i32(v);
      case T.LONG: return i64(v);
      case T.FLOAT: return b(4, x => x.writeFloatBE(v));
      case T.DOUBLE: return b(8, x => x.writeDoubleBE(v));
      case T.STRING: return str(v);
      case T.BYTE_ARRAY: i32(v.length); return v.forEach(i8);
      case T.INT_ARRAY: i32(v.length); return v.forEach(i32);
      case T.LONG_ARRAY: i32(v.length); return v.forEach(i64);
      case T.LIST: u8(v.items.length ? v.elType : T.END); i32(v.items.length); return v.items.forEach(it => payload(v.elType, it));
      case T.COMPOUND:
        for (const [k, tag] of v) { u8(tag.type); str(k); payload(tag.type, tag.value); }
        return u8(T.END);
      default: throw new Error('Type NBT inconnu');
    }
  }
  u8(root.type);
  str(name);
  payload(root.type, root.value);
  return Buffer.concat(chunks);
}

function serializeNbt({ name, root, compression }) {
  const raw = writeTree(name, root);
  if (compression === 'gzip') return zlib.gzipSync(raw);
  if (compression === 'zlib') return zlib.deflateSync(raw);
  return raw;
}

// ─── Arbre → SNBT ────────────────────────────────────────────
const SAFE_KEY = /^[A-Za-z0-9._+-]+$/;
const quote = s => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
const key = k => (SAFE_KEY.test(k) ? k : quote(k));

/** Représentation décimale la plus courte qui redonne exactement le même float32. */
function floatText(v) {
  if (!Number.isFinite(v)) throw new Error('Float non fini');
  for (let p = 1; p <= 9; p++) {
    const s = Number(v.toPrecision(p));
    if (Math.fround(s) === v) return fixDot(String(s));
  }
  return fixDot(String(v));
}
function doubleText(v) {
  if (!Number.isFinite(v)) throw new Error('Double non fini');
  return fixDot(String(v));
}
// 1 → 1.0 ; 1e+21 garde sa notation
const fixDot = s => (/[.eE]/.test(s) ? s : s + '.0');

function scalar(type, v) {
  switch (type) {
    case T.BYTE: return `${v}b`;
    case T.SHORT: return `${v}s`;
    case T.INT: return `${v}`;
    case T.LONG: return `${v}L`;
    case T.FLOAT: return `${floatText(v)}f`;
    case T.DOUBLE: return `${doubleText(v)}d`;
    case T.STRING: return quote(v);
    default: return null;
  }
}

function toSnbt(tag, indent = '') {
  const inner = indent + '  ';
  const { type, value } = tag;
  const s = scalar(type, value);
  if (s !== null) return s;
  if (type === T.BYTE_ARRAY || type === T.INT_ARRAY || type === T.LONG_ARRAY) {
    const prefix = { [T.BYTE_ARRAY]: 'B', [T.INT_ARRAY]: 'I', [T.LONG_ARRAY]: 'L' }[type];
    const el = { [T.BYTE_ARRAY]: T.BYTE, [T.INT_ARRAY]: T.INT, [T.LONG_ARRAY]: T.LONG }[type];
    if (!value.length) return `[${prefix};]`;
    const parts = value.map(v => scalar(el, v));
    return wrapInline(`[${prefix}; `, parts, ']', indent);
  }
  if (type === T.LIST) {
    if (!value.items.length) return '[]';
    const parts = value.items.map(v => toSnbt({ type: value.elType, value: v }, inner));
    if (value.elType !== T.COMPOUND && value.elType !== T.LIST) return wrapInline('[', parts, ']', indent);
    return `[\n${parts.map(p => inner + p).join(',\n')}\n${indent}]`;
  }
  if (type === T.COMPOUND) {
    if (!value.length) return '{}';
    return `{\n${value.map(([k, t]) => `${inner}${key(k)}: ${toSnbt(t, inner)}`).join(',\n')}\n${indent}}`;
  }
  throw new Error('Type NBT inconnu');
}

function wrapInline(open, parts, close, indent) {
  const oneLine = open + parts.join(', ') + close;
  if (oneLine.length + indent.length <= 100) return oneLine;
  const inner = indent + '  ';
  const lines = [];
  let line = '';
  for (const p of parts) {
    if (line && (line.length + p.length + 2) > 90) { lines.push(line + ','); line = ''; }
    line += (line ? ', ' : '') + p;
  }
  if (line) lines.push(line);
  return `${open.trimEnd()}\n${lines.map(l => inner + l).join('\n')}\n${indent}${close}`;
}

// ─── SNBT → arbre ────────────────────────────────────────────
function parseSnbt(text) {
  let i = 0;
  const len = text.length;
  const where = () => {
    const before = text.slice(0, i);
    const line = before.split('\n').length;
    return `ligne ${line}, colonne ${i - before.lastIndexOf('\n')}`;
  };
  const fail = msg => { throw new Error(`SNBT invalide (${where()}) : ${msg}`); };
  const ws = () => {
    for (;;) {
      while (i < len && /\s/.test(text[i])) i++;
      // commentaires « // … » tolérés (pratiques pour annoter pendant l'édition)
      if (text[i] === '/' && text[i + 1] === '/') { while (i < len && text[i] !== '\n') i++; continue; }
      break;
    }
  };
  const peek = () => { ws(); return text[i]; };
  const expect = c => { if (peek() !== c) fail(`« ${c} » attendu`); i++; };

  function quoted() {
    const q = text[i++];
    let out = '';
    while (i < len && text[i] !== q) {
      if (text[i] === '\\') {
        const n = text[++i];
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
        i++;
      } else out += text[i++];
    }
    if (text[i] !== q) fail('guillemet fermant manquant');
    i++;
    return out;
  }
  function bare() {
    const start = i;
    while (i < len && /[A-Za-z0-9._+-]/.test(text[i])) i++;
    if (i === start) fail('valeur attendue');
    return text.slice(start, i);
  }

  const INT_MIN = -(2 ** 31), INT_MAX = 2 ** 31 - 1;
  function literal(tok) {
    let m;
    const range = (v, lo, hi, what) => { if (v < lo || v > hi) fail(`${tok} dépasse la plage d'un ${what}`); return v; };
    if ((m = tok.match(/^([-+]?\d+)[bB]$/))) return { type: T.BYTE, value: range(+m[1], -128, 127, 'byte') };
    if ((m = tok.match(/^([-+]?\d+)[sS]$/))) return { type: T.SHORT, value: range(+m[1], -32768, 32767, 'short') };
    if ((m = tok.match(/^([-+]?\d+)[lL]$/))) {
      const v = BigInt(m[1]);
      if (v < -(2n ** 63n) || v > 2n ** 63n - 1n) fail(`${tok} dépasse la plage d'un long`);
      return { type: T.LONG, value: v };
    }
    if (/^[-+]?\d+$/.test(tok)) return { type: T.INT, value: range(+tok, INT_MIN, INT_MAX, 'int') };
    if ((m = tok.match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)[fF]$/))) return { type: T.FLOAT, value: Math.fround(+m[1]) };
    if ((m = tok.match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)[dD]$/))) return { type: T.DOUBLE, value: +m[1] };
    if (/^[-+]?(?:\d+\.\d*|\.\d+|\d+[eE][-+]?\d+|\d+\.\d*[eE][-+]?\d+)$/.test(tok)) return { type: T.DOUBLE, value: +tok };
    if (tok === 'true') return { type: T.BYTE, value: 1 };
    if (tok === 'false') return { type: T.BYTE, value: 0 };
    return { type: T.STRING, value: tok };
  }

  function value() {
    const c = peek();
    if (c === '{') return compound();
    if (c === '[') return list();
    if (c === '"' || c === "'") return { type: T.STRING, value: quoted() };
    return literal(bare());
  }
  function compound() {
    expect('{');
    const entries = [];
    const seen = new Set();
    if (peek() === '}') { i++; return { type: T.COMPOUND, value: entries }; }
    for (;;) {
      ws();
      const k = (text[i] === '"' || text[i] === "'") ? quoted() : bare();
      if (seen.has(k)) fail(`clé « ${k} » en double`);
      seen.add(k);
      expect(':');
      entries.push([k, value()]);
      const n = peek();
      if (n === ',') { i++; if (peek() === '}') { i++; break; } continue; }
      if (n === '}') { i++; break; }
      fail('« , » ou « } » attendu');
    }
    return { type: T.COMPOUND, value: entries };
  }
  function list() {
    expect('[');
    ws();
    // Tableaux typés [B; …] [I; …] [L; …]
    const arr = text.slice(i).match(/^([BIL])\s*;/);
    if (arr) {
      i += arr[0].length;
      const [type, el] = { B: [T.BYTE_ARRAY, T.BYTE], I: [T.INT_ARRAY, T.INT], L: [T.LONG_ARRAY, T.LONG] }[arr[1]];
      const out = [];
      if (peek() === ']') { i++; return { type, value: out }; }
      for (;;) {
        const v = value();
        let vv = v.value;
        if (v.type !== el) {
          // tolère 1 au lieu de 1b / 1L dans un tableau
          if (v.type === T.INT && el === T.BYTE && vv >= -128 && vv <= 127) vv = v.value;
          else if (v.type === T.INT && el === T.LONG) vv = BigInt(v.value);
          else if (!(v.type === T.BYTE && el === T.BYTE)) fail(`élément de type incompatible dans [${arr[1]};]`);
        }
        out.push(vv);
        const n = peek();
        if (n === ',') { i++; if (peek() === ']') { i++; break; } continue; }
        if (n === ']') { i++; break; }
        fail('« , » ou « ] » attendu');
      }
      return { type, value: out };
    }
    const items = [];
    let elType = T.END;
    if (peek() === ']') { i++; return { type: T.LIST, value: { elType, items } }; }
    for (;;) {
      const v = value();
      if (elType === T.END) elType = v.type;
      else if (v.type !== elType) fail('tous les éléments d\'une liste doivent avoir le même type');
      items.push(v.value);
      const n = peek();
      if (n === ',') { i++; if (peek() === ']') { i++; break; } continue; }
      if (n === ']') { i++; break; }
      fail('« , » ou « ] » attendu');
    }
    return { type: T.LIST, value: { elType, items } };
  }

  const root = value();
  ws();
  if (i < len) fail('contenu en trop après la fin');
  if (root.type !== T.COMPOUND && root.type !== T.LIST) fail('la racine doit être un compound { … }');
  return root;
}

module.exports = { parseNbt, serializeNbt, toSnbt, parseSnbt, T };
