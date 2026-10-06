/**
 * Gestion des mods d'un serveur : liste (métadonnées lues dans les jars), activation /
 * désactivation, corbeille, recherche Modrinth + CurseForge filtrée sur la version Minecraft et
 * le loader du serveur, installation avec dépendances obligatoires.
 *
 * Rien n'est jamais supprimé définitivement : un mod retiré part dans .craftarr/trash/mods.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { readModInfo, analyze, describeProblems } = require('./modJar');
const curseforge = require('./curseforge');
const { getCurseForgeKey } = require('./sourceAggregator');

const DATA_PATH = process.env.DATA_PATH || '/data';
const MODRINTH = 'https://api.modrinth.com/v2';
const UA = { 'User-Agent': 'Craftarr (github.com/PasDeNom2/Craftarr)' };
const CF_LOADER = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
const MAX_INSTALLS = 30; // garde-fou contre une chaîne de dépendances délirante

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

function dirsOf(serverId) {
  const root = path.join(DATA_PATH, 'servers', serverId, 'server');
  return {
    root,
    mods: path.join(root, 'mods'),
    trash: path.join(root, '.craftarr', 'trash', 'mods'),
    tmp: path.join(root, '.craftarr', 'tmp-mods'),
  };
}

/** Nom de fichier de mod acceptable (pas de chemin, extension .jar ou .jar.disabled). */
function validModFile(name) {
  return typeof name === 'string' && /^[^/\\\0]+\.jar(\.disabled)?$/i.test(name) && name.length <= 255;
}

/** Version MC + loader réellement utilisés par le serveur (métadonnées du pack prioritaires). */
function targetOf(server) {
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(path.join(dirsOf(server.id).root, '.craftarr-pack.json'), 'utf8')); } catch {}
  const loader = (meta?.loader || server.loader_type || '').toLowerCase();
  return { mcVersion: meta?.mcVersion || server.mc_version || null, loader };
}

// ─── Liste ───────────────────────────────────────────────────────────────────
const infoCache = new Map(); // chemin → { key, info }

function cachedInfo(file, prefer = null) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const key = `${st.size}:${st.mtimeMs}:${prefer || ''}`;
  const hit = infoCache.get(file);
  if (hit && hit.key === key) return { info: hit.info, st };
  const info = readModInfo(file, { prefer });
  infoCache.set(file, { key, info });
  return { info, st };
}

function listMods(server) {
  const { mods } = dirsOf(server.id);
  const { loader } = targetOf(server);
  let names = [];
  try { names = fs.readdirSync(mods).filter(validModFile); } catch {}
  const list = names.map(file => {
    const abs = path.join(mods, file);
    const { info, st } = cachedInfo(abs, loader) || {};
    return {
      file,
      enabled: !/\.disabled$/i.test(file),
      size: st?.size || 0,
      mtime: st?.mtimeMs || 0,
      name: info?.name || file.replace(/\.jar(\.disabled)?$/i, ''),
      version: info?.version || null,
      modId: info?.ids?.[0] || null,
      loader: info?.loader || null,
      loaders: info?.loaders || [],
      clientOnly: !!info?.clientOnly,
    };
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const enabledPaths = list.filter(m => m.enabled).map(m => path.join(mods, m.file));
  const problems = describeProblems(analyze(enabledPaths, f => cachedInfo(f, loader)?.info || null));
  // Jar d'un autre loader (ex. mod Fabric sur un serveur Forge) : ignoré au mieux, crash au pire
  for (const m of list) {
    if (m.enabled && m.loaders.length && loader && !m.loaders.some(l => loaderAccepts(loader, l))) {
      problems.push(`${m.file} est un mod ${m.loader}, le serveur utilise ${loader}`);
    }
  }
  return { mods: list, problems, target: targetOf(server) };
}

function loaderAccepts(serverLoader, modLoader) {
  if (serverLoader === modLoader) return true;
  if (serverLoader === 'quilt' && modLoader === 'fabric') return true;
  if (serverLoader === 'neoforge' && modLoader === 'forge') return true; // NeoForge 1.20.1 charge les mods Forge
  return false;
}

// ─── Activation / corbeille ──────────────────────────────────────────────────
function setEnabled(server, file, enabled) {
  if (!validModFile(file)) throw httpError(400, 'Nom de fichier invalide');
  const { mods } = dirsOf(server.id);
  const src = path.join(mods, file);
  if (!fs.existsSync(src)) throw httpError(404, 'Mod introuvable');
  const base = file.replace(/\.disabled$/i, '');
  const target = enabled ? base : `${base}.disabled`;
  if (target === file) return file;
  if (fs.existsSync(path.join(mods, target))) throw httpError(409, `${target} existe déjà`);
  fs.renameSync(src, path.join(mods, target));
  return target;
}

function trashMods(server, files) {
  const { mods, trash } = dirsOf(server.id);
  fs.mkdirSync(trash, { recursive: true });
  const moved = [];
  for (const file of files) {
    if (!validModFile(file)) throw httpError(400, `Nom de fichier invalide : ${file}`);
    const src = path.join(mods, file);
    if (!fs.existsSync(src)) continue;
    let dest = path.join(trash, file);
    if (fs.existsSync(dest)) dest = path.join(trash, `${Date.now()}-${file}`);
    fs.renameSync(src, dest);
    moved.push(file);
  }
  return moved;
}

// ─── Recherche ───────────────────────────────────────────────────────────────
async function searchModrinth(query, { mcVersion, loader }) {
  const facets = [['project_type:mod'], ['server_side:required', 'server_side:optional']];
  if (mcVersion) facets.push([`versions:${mcVersion}`]);
  if (loader) facets.push(loader === 'quilt' ? ['categories:quilt', 'categories:fabric'] : [`categories:${loader}`]);
  const { data } = await axios.get(`${MODRINTH}/search`, {
    params: { query: query || undefined, facets: JSON.stringify(facets), limit: 20, index: query ? 'relevance' : 'downloads' },
    headers: UA, timeout: 15000,
  });
  return data.hits.map(h => ({
    source: 'modrinth', id: h.project_id, slug: h.slug, name: h.title, summary: h.description,
    icon: h.icon_url || null, downloads: h.downloads, author: h.author,
    url: `https://modrinth.com/mod/${h.slug}`,
  }));
}

async function searchCurseForge(query, { mcVersion, loader }) {
  const key = getCurseForgeKey();
  if (!key) return [];
  const params = { gameId: 432, classId: 6, searchFilter: query || undefined, sortField: 2, sortOrder: 'desc', pageSize: 20 };
  if (mcVersion) params.gameVersion = mcVersion;
  if (CF_LOADER[loader]) params.modLoaderType = CF_LOADER[loader];
  const { data } = await axios.get('https://api.curseforge.com/v1/mods/search', { params, headers: { 'x-api-key': key }, timeout: 15000 });
  return (data.data || []).map(m => ({
    source: 'curseforge', id: String(m.id), slug: m.slug, name: m.name, summary: m.summary,
    icon: m.logo?.thumbnailUrl || null, downloads: m.downloadCount, author: m.authors?.[0]?.name || null,
    url: m.links?.websiteUrl || null,
  }));
}

async function search(server, query, source) {
  const target = targetOf(server);
  const tasks = [];
  if (!source || source === 'modrinth') tasks.push(searchModrinth(query, target));
  if (!source || source === 'curseforge') tasks.push(searchCurseForge(query, target));
  const results = await Promise.allSettled(tasks);
  const hits = results.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
  const errors = results.filter(r => r.status === 'rejected').map(r => r.reason?.message);
  return { results: hits, target, errors };
}

// ─── Résolution d'un fichier compatible ──────────────────────────────────────
async function resolveModrinth(projectId, { mcVersion, loader }) {
  const loaders = loader === 'quilt' ? ['quilt', 'fabric'] : loader ? [loader] : undefined;
  const { data } = await axios.get(`${MODRINTH}/project/${encodeURIComponent(projectId)}/version`, {
    params: {
      loaders: loaders ? JSON.stringify(loaders) : undefined,
      game_versions: mcVersion ? JSON.stringify([mcVersion]) : undefined,
    },
    headers: UA, timeout: 15000,
  });
  const version = data.find(v => v.version_type === 'release') || data[0];
  if (!version) return null;
  const file = version.files.find(f => f.primary) || version.files[0];
  return {
    fileName: file.filename,
    urls: [file.url],
    expected: file.hashes?.sha512 ? { sha512: file.hashes.sha512 } : file.hashes?.sha1 ? { sha1: file.hashes.sha1 } : {},
    deps: (version.dependencies || [])
      .filter(d => d.dependency_type === 'required' && d.project_id)
      .map(d => ({ source: 'modrinth', id: d.project_id })),
    label: version.version_number,
  };
}

async function resolveCurseForge(modId, { mcVersion, loader }) {
  const key = getCurseForgeKey();
  if (!key) throw httpError(400, 'Clé API CurseForge manquante (Paramètres)');
  const loaderTypes = loader === 'quilt' ? [5, 4] : CF_LOADER[loader] ? [CF_LOADER[loader]] : [undefined];
  for (const modLoaderType of loaderTypes) {
    const { data } = await axios.get(`https://api.curseforge.com/v1/mods/${encodeURIComponent(modId)}/files`, {
      params: { gameVersion: mcVersion || undefined, modLoaderType, pageSize: 20 },
      headers: { 'x-api-key': key }, timeout: 15000,
    });
    const files = (data.data || []).filter(f => f.isAvailable !== false && !f.isServerPack);
    const file = files.find(f => f.releaseType === 1) || files[0];
    if (!file) continue;
    const sha1 = (file.hashes || []).find(h => h.algo === 1)?.value;
    return {
      fileName: file.fileName,
      urls: curseforge.fileUrls({ id: file.id, fileName: file.fileName, downloadUrl: file.downloadUrl }),
      expected: sha1 ? { sha1 } : {},
      // relationType 3 = dépendance obligatoire
      deps: (file.dependencies || []).filter(d => d.relationType === 3).map(d => ({ source: 'curseforge', id: String(d.modId) })),
      label: file.displayName,
    };
  }
  return null;
}

// ─── Installation ────────────────────────────────────────────────────────────
async function download(urls, dest, expected) {
  const { _internals: { downloadAny } } = require('./installer');
  await downloadAny(urls, dest, null, expected);
}

/**
 * Installe un mod et ses dépendances obligatoires absentes.
 * Une dépendance déjà fournie par un mod présent (même id) n'est pas réinstallée.
 */
async function installMod(server, source, projectId, { asDependency = false, resolveMissing = !asDependency } = {}) {
  const target = targetOf(server);
  const { mods, tmp } = dirsOf(server.id);
  fs.mkdirSync(mods, { recursive: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  // Ids déjà fournis par les mods actifs
  const provided = new Set();
  for (const f of fs.readdirSync(mods).filter(n => /\.jar$/i.test(n))) {
    for (const id of cachedInfo(path.join(mods, f), target.loader)?.info?.ids || []) provided.add(id);
  }

  const installed = [];
  const skipped = [];
  const warnings = [];
  const queue = [{ source, id: String(projectId), root: !asDependency }];
  const seen = new Set();

  try {
    while (queue.length && installed.length < MAX_INSTALLS) {
      const item = queue.shift();
      const key = `${item.source}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const resolved = item.source === 'modrinth'
        ? await resolveModrinth(item.id, target)
        : await resolveCurseForge(item.id, target);
      if (!resolved) {
        const msg = `Aucune version compatible avec Minecraft ${target.mcVersion || '?'} (${target.loader || 'loader inconnu'})`;
        if (item.root) throw httpError(404, msg);
        warnings.push(`Dépendance ${item.id} : ${msg.toLowerCase()}`);
        continue;
      }
      if (!/^[^/\\\0]+\.jar$/i.test(resolved.fileName)) { warnings.push(`Fichier ignoré : ${resolved.fileName}`); continue; }
      if (fs.existsSync(path.join(mods, resolved.fileName))) {
        if (item.root) throw httpError(409, `${resolved.fileName} est déjà installé`);
        skipped.push(resolved.fileName);
        continue;
      }

      const tmpFile = path.join(tmp, resolved.fileName);
      await download(resolved.urls, tmpFile, resolved.expected);
      const info = readModInfo(tmpFile, { prefer: target.loader });
      const ids = info?.ids || [];

      if (!item.root && ids.length && ids.every(id => provided.has(id))) {
        // Dépendance déjà présente sous un autre nom de fichier
        skipped.push(resolved.fileName);
        fs.rmSync(tmpFile, { force: true });
        continue;
      }
      if (item.root && ids[0] && provided.has(ids[0])) {
        fs.rmSync(tmpFile, { force: true });
        throw httpError(409, `Ce mod (${ids[0]}) est déjà installé sous un autre nom de fichier`);
      }
      if (info?.loaders?.length && target.loader && !info.loaders.some(l => loaderAccepts(target.loader, l))) {
        warnings.push(`${resolved.fileName} est un mod ${info.loader}, le serveur utilise ${target.loader}`);
      }

      fs.renameSync(tmpFile, path.join(mods, resolved.fileName));
      ids.forEach(id => provided.add(id));
      installed.push(resolved.fileName);
      queue.push(...resolved.deps);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // Dépendances que l'API n'a pas déclarées mais que les jars exigent (ex. Fabric API)
  if (resolveMissing && installed.length) {
    const extra = await installMissingDependencies(server, new Set(installed));
    installed.push(...extra.installed);
    for (const dep of extra.unresolved) warnings.push(`Dépendance « ${dep} » introuvable automatiquement : à installer à la main`);
  }
  return { installed, skipped, warnings };
}

// Id de mod → projet Modrinth quand ils diffèrent (les autres : id = slug, « _ » → « - »)
const ID_TO_SLUG = { fabric: 'fabric-api', 'fabric-api': 'fabric-api', 'fabric-language-kotlin': 'fabric-language-kotlin', cloth_config: 'cloth-config', 'cloth-config2': 'cloth-config', architectury: 'architectury-api', geckolib: 'geckolib', owo: 'owo-lib' };

async function modrinthProjectFor(modId) {
  const candidates = [...new Set([ID_TO_SLUG[modId], modId, modId.replace(/_/g, '-')].filter(Boolean))];
  for (const slug of candidates) {
    try {
      const { data } = await axios.get(`${MODRINTH}/project/${encodeURIComponent(slug)}`, { headers: UA, timeout: 10000 });
      if (data?.project_type === 'mod') return data.id;
    } catch { /* projet inconnu : candidat suivant */ }
  }
  return null;
}

/**
 * Installe depuis Modrinth les dépendances obligatoires absentes du dossier mods/ (déduites des
 * métadonnées des jars, pas de l'API : certaines fiches oublient de déclarer Fabric API…).
 * onlyFor : limite aux dépendances de ces fichiers (après une installation).
 */
async function installMissingDependencies(server, onlyFor = null) {
  const { mods } = dirsOf(server.id);
  const { loader } = targetOf(server);
  const installed = [];
  const unresolved = [];
  const tried = new Set();
  for (let round = 0; round < 5; round++) {
    const files = fs.readdirSync(mods).filter(n => /.jar$/i.test(n)).map(n => path.join(mods, n));
    const { missing } = analyze(files, f => cachedInfo(f, loader)?.info || null);
    const todo = missing.filter(m => (!onlyFor || onlyFor.has(m.file) || installed.includes(m.file)) && !tried.has(m.dep));
    if (!todo.length) break;
    for (const { dep } of todo) {
      tried.add(dep);
      const projectId = await modrinthProjectFor(dep);
      if (!projectId) { unresolved.push(dep); continue; }
      try {
        const r = await installMod(server, 'modrinth', projectId, { asDependency: true });
        installed.push(...r.installed);
        if (!r.installed.length) unresolved.push(dep);
      } catch {
        unresolved.push(dep);
      }
    }
  }
  return { installed, unresolved: [...new Set(unresolved)] };
}

/** Vérifie un jar envoyé à la main (avant de le garder). Retourne les avertissements. */
function checkUploaded(server, absFile) {
  const { loader } = targetOf(server);
  const info = readModInfo(absFile, { prefer: loader });
  const warnings = [];
  if (!info) warnings.push(`${path.basename(absFile)} : pas de métadonnées de mod lisibles (librairie ou très ancien mod ?)`);
  else {
    if (loader && info.loaders?.length && !info.loaders.some(l => loaderAccepts(loader, l))) warnings.push(`${path.basename(absFile)} est un mod ${info.loader}, le serveur utilise ${loader}`);
    if (info.clientOnly) warnings.push(`${path.basename(absFile)} est déclaré client-only : il ne sera pas chargé par le serveur`);
  }
  return { info, warnings };
}

module.exports = {
  listMods, setEnabled, trashMods, search, installMod, installMissingDependencies, checkUploaded, dirsOf, validModFile, targetOf,
  _internals: { loaderAccepts, infoCache },
};
