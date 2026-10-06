const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { openZip } = require('./localZip');
const { satisfiesFabric, satisfiesMaven } = require('./versionRange');

/**
 * Lecture des métadonnées d'un mod (.jar) : ids fournis, dépendances obligatoires côté serveur,
 * incompatibilités déclarées, mod client-only. Formats : META-INF/mods.toml (Forge, NeoForge 1.20.1),
 * META-INF/neoforge.mods.toml, fabric.mod.json, quilt.mod.json — jars imbriqués compris
 * (META-INF/jarjar, META-INF/jars) car ils fournissent eux aussi des ids (ex: Fabric API).
 *
 * Sert à vérifier un dossier mods/ AVANT le premier démarrage : un mod manquant ou en double
 * fait crasher le serveur en boucle avec une stacktrace peu lisible.
 */

// Ids fournis par le loader lui-même (jamais présents comme jar dans mods/)
const BUILTIN_IDS = new Set([
  'minecraft', 'java', 'forge', 'neoforge', 'fml', 'javafml', 'lowcodefml', 'mixinextras',
  'fabricloader', 'fabric-loader', 'quilt_loader', 'quilt-loader',
]);

const MAX_NESTED_DEPTH = 3;

/** Valeur scalaire TOML minimale : chaîne, booléen, nombre ou chaîne brute. */
function parseTomlScalar(raw) {
  const v = raw.trim();
  const quoted = v.match(/^"((?:[^"\\]|\\.)*)"|^'([^']*)'/);
  if (quoted) return quoted[1] !== undefined ? quoted[1] : quoted[2];
  const bare = v.replace(/\s+#.*$/, '').trim();
  if (bare === 'true') return true;
  if (bare === 'false') return false;
  return bare;
}

/**
 * Parseur TOML volontairement limité aux structures des mods.toml :
 * clés de premier niveau, [[mods]], [[dependencies.<id>]]. Les autres tables sont ignorées.
 */
function parseModsToml(text) {
  const top = {};
  const mods = [];
  const deps = {};
  let cur = top;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    const arr = line.match(/^\[\[\s*([^\]]+?)\s*\]\]/);
    if (arr) {
      cur = {};
      const name = arr[1];
      if (name === 'mods') mods.push(cur);
      else if (name.startsWith('dependencies.')) {
        const owner = name.slice('dependencies.'.length).replace(/^["']|["']$/g, '');
        (deps[owner] ||= []).push(cur);
      }
      continue;
    }
    if (/^\[[^\]]+\]/.test(line)) { cur = {}; continue; } // table non gérée : ignorée

    const kv = line.match(/^"?([A-Za-z0-9_.-]+)"?\s*=\s*(.*)$/);
    if (!kv) continue;
    const [, key, val] = kv;
    // Chaînes multi-lignes (description) et tableaux multi-lignes : sautés
    const triple = val.match(/^('''|""")/);
    if (triple) {
      if (!val.slice(3).includes(triple[1])) {
        while (++i < lines.length && !lines[i].includes(triple[1]));
      }
      continue;
    }
    if (val.startsWith('[') && !val.includes(']')) {
      while (++i < lines.length && !lines[i].includes(']'));
      continue;
    }
    cur[key] = parseTomlScalar(val);
  }
  return { top, mods, deps };
}

function fromToml(text, loader) {
  const { top, mods, deps } = parseModsToml(text);
  const ids = mods.map(m => m.modId).filter(Boolean);
  const requires = [];
  const breaks = [];
  for (const owner of Object.keys(deps)) {
    for (const d of deps[owner]) {
      if (!d.modId) continue;
      const side = String(d.side || 'BOTH').toUpperCase();
      // NeoForge : type = required|optional|incompatible|discouraged ; Forge : mandatory = true|false
      const type = d.type ? String(d.type).toLowerCase() : (d.mandatory === true || d.mandatory === 'true' ? 'required' : 'optional');
      if (type === 'incompatible') breaks.push({ id: d.modId, range: d.versionRange || '*', kind: 'maven' });
      else if (type === 'required' && side !== 'CLIENT') requires.push(d.modId);
    }
  }
  const clientOnly = top.clientSideOnly === true || top.clientSideOnly === 'true';
  const main = mods[0] || {};
  return { loader, ids, requires, breaks, clientOnly, name: main.displayName || main.modId || null, version: main.version || null };
}

/** breaks Fabric/Quilt → [{ id, range }] (objet id → plage, ou tableau d'ids / d'objets). */
function asBreaks(v) {
  if (!v) return [];
  if (Array.isArray(v)) {
    return v.map(x => (typeof x === 'string' ? { id: x, range: '*', kind: 'fabric' } : x?.id ? { id: x.id, range: x.versions ?? '*', kind: 'fabric' } : null)).filter(Boolean);
  }
  return Object.entries(v).map(([id, range]) => ({ id, range, kind: 'fabric' }));
}

function asIdList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(x => (typeof x === 'string' ? x : x?.id)).filter(Boolean);
  return Object.keys(v);
}

function fromFabric(json) {
  return {
    loader: 'fabric',
    ids: [json.id, ...asIdList(json.provides)].filter(Boolean),
    requires: asIdList(json.depends),
    breaks: asBreaks(json.breaks),
    clientOnly: json.environment === 'client',
    nested: (json.jars || []).map(j => j?.file).filter(Boolean),
    name: json.name || json.id || null,
    version: json.version || null,
  };
}

function fromQuilt(json) {
  const q = json.quilt_loader || {};
  const deps = Array.isArray(q.depends) ? q.depends : [];
  return {
    loader: 'quilt',
    ids: [q.id, ...asIdList(q.provides)].filter(Boolean),
    requires: deps.filter(d => typeof d === 'string' || !d.optional).map(d => (typeof d === 'string' ? d : d.id)).filter(Boolean),
    breaks: asBreaks(q.breaks),
    clientOnly: json.minecraft?.environment === 'client',
    nested: (q.jars || []).map(j => (typeof j === 'string' ? j : j?.file)).filter(Boolean),
    name: q.metadata?.name || q.id || null,
    version: q.version || null,
  };
}

/**
 * JSON « à la Fabric » : BOM, commentaires, virgules finales et retours à la ligne bruts dans
 * les chaînes sont tolérés par le loader. JSON.parse strict faisait ignorer des mods bien présents
 * (→ fausses « dépendances manquantes »).
 */
function parseLenientJson(text) {
  const src = String(text).replace(/^\uFEFF/, '');
  try { return JSON.parse(src); } catch {}
  let out = '';
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') { out += c + (src[i + 1] ?? ''); i++; continue; }
      if (c === '"') inStr = false;
      if (c === '\n') { out += '\\n'; continue; }
      if (c === '\r') continue;
      if (c === '\t') { out += '\\t'; continue; }
      out += c;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/**
 * Métadonnées d'un jar (chemin ou Buffer), ou null si ce n'est pas un mod reconnu
 * (librairie pure, mod 1.12 avec mcmod.info…). Les ids des jars imbriqués sont ajoutés à `ids`.
 */
/** Ordre de préférence des métadonnées : celles du loader du serveur d'abord (jars multi-loaders). */
function loaderOrder(prefer) {
  const base = ['neoforge', 'forge', 'quilt', 'fabric'];
  if (!prefer) return base;
  const first = prefer === 'quilt' ? ['quilt', 'fabric'] : prefer === 'neoforge' ? ['neoforge', 'forge'] : [prefer];
  return [...first, ...base.filter(l => !first.includes(l))];
}

/**
 * opts : { prefer: loader du serveur } — un jar « Fabric+Forge » contient les métadonnées des deux :
 * sur un serveur Fabric, ce sont celles de Fabric qui comptent (sinon : faux « mauvais loader »).
 * (Un nombre est accepté pour compatibilité : profondeur d'imbrication.)
 */
function readModInfo(jar, opts = {}) {
  const { depth = 0, prefer = null } = typeof opts === 'number' ? { depth: opts } : opts;
  let zip;
  try {
    zip = openZip(jar);
  } catch {
    // Zip atypique (zip64…) : repli sur adm-zip, plus lent mais plus tolérant
    try {
      const az = new AdmZip(jar);
      zip = {
        names: az.getEntries().map(e => e.entryName),
        read: name => az.getEntry(name)?.getData() || null,
        close() {},
      };
    } catch { return null; }
  }
  try {
    return readModInfoFrom(zip, depth, prefer);
  } finally {
    zip.close();
  }
}

function readModInfoFrom(zip, depth, prefer) {
  const read = (name) => {
    try { return zip.read(name)?.toString('utf8') ?? null; } catch { return null; }
  };

  const raw = {
    neoforge: read('META-INF/neoforge.mods.toml'),
    forge: read('META-INF/mods.toml'),
    quilt: read('quilt.mod.json'),
    fabric: read('fabric.mod.json'),
  };
  const parsers = {
    neoforge: t => fromToml(t, 'neoforge'),
    forge: t => fromToml(t, 'forge'),
    quilt: t => fromQuilt(parseLenientJson(t)),
    fabric: t => fromFabric(parseLenientJson(t)),
  };
  const loaders = Object.keys(raw).filter(l => raw[l]);
  let info = null;
  for (const l of loaderOrder(prefer)) {
    if (!raw[l]) continue;
    try { info = parsers[l](raw[l]); break; } catch { /* métadonnées illisibles : loader suivant */ }
  }
  if (!info) return null;
  info.loaders = loaders;

  // Version « ${file.jarVersion} » (Forge/NeoForge) : la vraie est dans le MANIFEST du jar
  if (!info.version || info.version.includes('${')) {
    const mf = read('META-INF/MANIFEST.MF') || '';
    info.version = mf.match(/^Implementation-Version:\s*(.+)$/m)?.[1]?.trim() || null;
  }

  // Jars imbriqués (jar-in-jar) : Forge/NeoForge → META-INF/jarjar/, Fabric/Quilt → liste "jars"
  if (depth < MAX_NESTED_DEPTH) {
    const nestedNames = new Set(info.nested || []);
    info.nestedVersions = {};
    for (const name of zip.names) {
      if (/^META-INF\/(jarjar|jars)\/.+\.jar$/.test(name)) nestedNames.add(name);
    }
    for (const name of nestedNames) {
      try {
        const data = zip.read(name);
        const sub = data && readModInfo(data, { depth: depth + 1, prefer });
        if (sub) {
          info.ids.push(...sub.ids);
          for (const id of sub.ids) if (sub.version && !info.nestedVersions[id]) info.nestedVersions[id] = sub.version;
        }
      } catch {}
    }
  }
  delete info.nested;
  if (!info.nestedVersions) info.nestedVersions = {};
  info.ids = [...new Set(info.ids)];
  return info;
}

function listJars(dir) {
  try {
    return fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.jar')).map(f => path.join(dir, f));
  } catch { return []; }
}

/**
 * Analyse un ensemble de jars : retourne pour chacun ses infos, et les problèmes détectés.
 *  - missing    : [{ mod, file, dep }] dépendance obligatoire fournie par aucun jar
 *  - duplicates : [{ id, files }] même id fourni par plusieurs jars de premier niveau
 *  - conflicts  : [{ mod, file, other, otherFile }] incompatibilité déclarée entre deux mods présents
 */
function analyze(jarPaths, infoOf = readModInfo) {
  const entries = jarPaths.map(file => ({ file, info: infoOf(file) }));
  // Version installée de chaque id (jar principal, sinon jar imbriqué)
  const versions = new Map();
  for (const { info } of entries) {
    if (!info) continue;
    for (const [id, v] of Object.entries(info.nestedVersions || {})) if (!versions.has(id)) versions.set(id, v);
  }
  for (const { info } of entries) if (info?.ids[0] && info.version) versions.set(info.ids[0], info.version);
  const providers = new Map(); // id → [file]
  for (const { file, info } of entries) {
    if (!info) continue;
    for (const id of info.ids) {
      if (!providers.has(id)) providers.set(id, []);
      providers.get(id).push(file);
    }
  }

  const missing = [];
  const conflicts = [];
  const duplicates = [];
  const seenDup = new Set();

  for (const { file, info } of entries) {
    if (!info || info.clientOnly) continue; // non chargé sur un serveur dédié
    const name = info.ids[0] || path.basename(file);
    for (const dep of info.requires) {
      if (BUILTIN_IDS.has(dep) || providers.has(dep)) continue;
      missing.push({ mod: name, file: path.basename(file), dep });
    }
    for (const br of info.breaks) {
      const otherFiles = (providers.get(br.id) || []).filter(f => f !== file);
      if (!otherFiles.length) continue;
      const range = br.range ?? '*';
      const anyVersion = range === '*' || range === '' || (Array.isArray(range) && range.includes('*'));
      const installed = versions.get(br.id);
      // Plage précise : on ne signale que si la version installée est réellement concernée
      const hit = anyVersion || (installed && (br.kind === 'maven' ? satisfiesMaven(installed, range) : satisfiesFabric(installed, range)));
      if (hit) conflicts.push({ mod: name, file: path.basename(file), other: br.id, otherFile: path.basename(otherFiles[0]) });
    }
    // Doublon = même id PRINCIPAL dans deux jars distincts (les ids imbriqués peuvent légitimement se répéter)
    const primary = info.ids[0];
    if (primary && !seenDup.has(primary)) {
      const sameMain = entries.filter(e => e.info?.ids[0] === primary).map(e => path.basename(e.file));
      if (sameMain.length > 1) { duplicates.push({ id: primary, files: sameMain }); seenDup.add(primary); }
    }
  }
  return { entries, providers, missing, duplicates, conflicts };
}

/**
 * Ids requis (côté serveur) par les jars "gardés" et fournis par aucun d'eux.
 * Utilisé pour réintégrer un mod exclu à tort comme client-only.
 */
function unmetRequirements(keptInfos) {
  const provided = new Set();
  for (const info of keptInfos) for (const id of info.ids) provided.add(id);
  const need = new Set();
  for (const info of keptInfos) {
    if (info.clientOnly) continue;
    for (const dep of info.requires) if (!BUILTIN_IDS.has(dep) && !provided.has(dep)) need.add(dep);
  }
  return need;
}

/** Messages lisibles pour la console à partir d'un résultat d'analyze(). */
function describeProblems({ missing, duplicates, conflicts }) {
  const lines = [];
  for (const m of missing) lines.push(`Dépendance manquante : ${m.file} exige le mod « ${m.dep} » (absent du dossier mods/)`);
  for (const d of duplicates) lines.push(`Mod en double « ${d.id} » : ${d.files.join(', ')} — n'en garder qu'un`);
  for (const c of conflicts) lines.push(`Incompatibilité déclarée : ${c.file} est incompatible avec ${c.otherFile}`);
  return lines;
}

module.exports = { readModInfo, analyze, unmetRequirements, describeProblems, listJars, BUILTIN_IDS, _internals: { parseModsToml, parseLenientJson } };
