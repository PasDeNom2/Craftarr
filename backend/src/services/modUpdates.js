// @ts-check
/**
 * Vérification et application des mises à jour mod par mod via l'API Modrinth (empreinte SHA-1).
 *
 * - Scanne mods/ (ou plugins/ pour Paper/Purpur/Spigot/Bukkit/Folia), en ignorant les .disabled.
 * - Interroge POST /v2/version_files/update et POST /v2/version_files (plus GET /v2/projects pour
 *   les titres et icônes), avec cache mémoire de 1 h par serveur (invalidé après mise à jour).
 * - Télécharge le nouveau .jar (SHA-1 vérifié), déplace l'ancien dans la corbeille modManager
 *   (.craftarr/trash/mods) sous verrou serveur, et signale si un redémarrage est nécessaire.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const modManager = require('./modManager');
const { readModInfo } = require('./modJar');
const serverLock = require('./serverLock');
const { PLUGIN_LOADERS } = require('./modrinthInstall');

const MODRINTH = 'https://api.modrinth.com/v2';
const UA = { 'User-Agent': 'Craftarr (github.com/PasDeNom2/Craftarr)' };
const TIMEOUT_MS = 20000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const BATCH_SIZE = 100;

/** @type {Map<string, { expiresAt: number, signature: string, data: any }>} */
const cache = new Map();

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function invalidateCache(serverId) {
  cache.delete(serverId);
}

/** Dossier des jars, corbeille, dossier temporaire et loaders acceptés pour ce serveur. */
function targetContext(server) {
  const { mcVersion, loader } = modManager.targetOf(server);
  const { root, mods, trash, tmp } = modManager.dirsOf(server.id);
  const isPlugin = PLUGIN_LOADERS.has(loader);
  const dir = isPlugin ? path.join(root, 'plugins') : mods;
  const loaders = isPlugin
    ? [...new Set([loader, 'paper', 'bukkit', 'spigot'])]
    : loader === 'quilt'
      ? ['quilt', 'fabric']
      : loader
        ? [loader]
        : [];
  return { mcVersion, loader, loaders, dir, trash, tmp, isPlugin };
}

/** Liste les .jar actifs du dossier (les .disabled sont ignorés). */
function scanActiveJars(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const entries = [];
  for (const file of names) {
    if (!modManager.validModFile(file) || /\.disabled$/i.test(file)) continue;
    const abs = path.join(dir, file);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    entries.push({ file, path: abs, size: st.size, mtimeMs: st.mtimeMs });
  }
  entries.sort((a, b) => a.file.localeCompare(b.file));
  return entries;
}

function buildSignature(mcVersion, loader, entries) {
  return `${mcVersion || ''}|${loader || ''}|${entries.map(e => `${e.file}:${e.size}:${e.mtimeMs}`).join(',')}`;
}

function sha1File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
    stream.on('error', reject);
  });
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function selectPrimaryJar(version) {
  const files = Array.isArray(version?.files) ? version.files : [];
  const file = files.find(f => f.primary) || files[0] || null;
  if (!file || !file.url || !file.filename) return null;
  // Téléchargement uniquement en https et avec empreinte SHA-1 vérifiable
  if (!/^https:\/\//i.test(String(file.url)) || !/^[0-9a-f]{40}$/i.test(String(file.hashes?.sha1 || ''))) return null;
  if (!modManager.validModFile(file.filename) || /\.disabled$/i.test(file.filename)) return null;
  return file;
}

function isCompatibleVersion(version, mcVersion, allowedLoaders) {
  if (!version || typeof version !== 'object') return false;
  if (!Array.isArray(version.game_versions) || !version.game_versions.includes(mcVersion)) return false;
  if (Array.isArray(version.loaders) && !version.loaders.some(l => allowedLoaders.has(String(l).toLowerCase()))) {
    return false;
  }
  return Boolean(selectPrimaryJar(version));
}

function moveFile(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

/**
 * Vérifie les mises à jour disponibles sur Modrinth pour tous les .jar actifs d'un serveur.
 * Utilise un cache de 1 h par serveur (contournable via { force: true }).
 */
async function checkUpdates(server, { force = false } = {}) {
  const ctx = targetContext(server);
  const entries = scanActiveJars(ctx.dir);
  const signature = buildSignature(ctx.mcVersion, ctx.loader, entries);

  if (!force) {
    const hit = cache.get(server.id);
    if (hit && hit.expiresAt > Date.now() && hit.signature === signature) {
      return { ...hit.data, cached: true };
    }
  }

  if (!entries.length) {
    const data = {
      mods: [],
      updatesCount: 0,
      checkedAt: new Date().toISOString(),
      target: { mcVersion: ctx.mcVersion, loader: ctx.loader },
    };
    cache.set(server.id, { expiresAt: Date.now() + CACHE_TTL_MS, signature, data });
    return { ...data, cached: false };
  }

  const fileItems = await Promise.all(entries.map(async entry => {
    const sha1 = await sha1File(entry.path);
    let localInfo = null;
    try { localInfo = readModInfo(entry.path, { prefer: ctx.loader }); } catch {}
    return { ...entry, sha1, localInfo };
  }));

  // Sans version MC ou loader compatible Modrinth (ex. vanilla), aucun mod n'est suivi
  if (!ctx.mcVersion || !ctx.loader || ctx.loader === 'vanilla') {
    const mods = fileItems.map(item => ({
      file: item.file,
      sha1: item.sha1,
      name: item.localInfo?.name || item.file.replace(/\.jar$/i, ''),
      icon: null,
      projectId: null,
      slug: null,
      url: null,
      currentVersion: item.localInfo?.version || null,
      currentVersionId: null,
      status: 'untracked',
      latestVersion: item.localInfo?.version || null,
      latestVersionId: null,
      latestFile: null,
      versionType: null,
      changelog: null,
    })).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    const data = {
      mods,
      updatesCount: 0,
      checkedAt: new Date().toISOString(),
      target: { mcVersion: ctx.mcVersion, loader: ctx.loader },
    };
    cache.set(server.id, { expiresAt: Date.now() + CACHE_TTL_MS, signature, data });
    return { ...data, cached: false };
  }

  const uniqueHashes = [...new Set(fileItems.map(i => i.sha1))];
  /** @type {Record<string, any>} */
  const updateByHash = {};
  /** @type {Record<string, any>} */
  const currentByHash = {};

  for (const batch of chunk(uniqueHashes, BATCH_SIZE)) {
    const [updateRes, currentRes] = await Promise.all([
      axios.post(`${MODRINTH}/version_files/update`, {
        hashes: batch,
        algorithm: 'sha1',
        loaders: ctx.loaders,
        game_versions: [ctx.mcVersion],
      }, { headers: UA, timeout: TIMEOUT_MS }),
      axios.post(`${MODRINTH}/version_files`, {
        hashes: batch,
        algorithm: 'sha1',
      }, { headers: UA, timeout: TIMEOUT_MS }).catch(() => ({ data: {} })),
    ]);
    Object.assign(updateByHash, updateRes?.data || {});
    Object.assign(currentByHash, currentRes?.data || {});
  }

  const projectIds = [...new Set([
    ...Object.values(currentByHash).map(v => v?.project_id),
    ...Object.values(updateByHash).map(v => v?.project_id),
  ].filter(Boolean))];

  /** @type {Record<string, any>} */
  const projectsById = {};
  if (projectIds.length) {
    for (const pBatch of chunk(projectIds, 50)) {
      try {
        const res = await axios.get(`${MODRINTH}/projects`, {
          params: { ids: JSON.stringify(pBatch) },
          headers: UA,
          timeout: TIMEOUT_MS,
        });
        for (const proj of res?.data || []) {
          if (proj?.id) projectsById[proj.id] = proj;
        }
      } catch {
        // L'enrichissement (titre, icône) reste optionnel si /projects échoue
      }
    }
  }

  const allowedLoaders = new Set(ctx.loaders.map(l => l.toLowerCase()));
  const mods = fileItems.map(item => {
    const currentVer = currentByHash[item.sha1] || null;
    const updateVer = updateByHash[item.sha1] || null;
    const projectId = currentVer?.project_id || updateVer?.project_id || null;
    const project = projectId ? projectsById[projectId] || null : null;

    const knownOnModrinth = Boolean(currentVer || updateVer);
    const compatible = Boolean(updateVer && isCompatibleVersion(updateVer, ctx.mcVersion, allowedLoaders));
    const nextFile = compatible ? selectPrimaryJar(updateVer) : null;
    const nextSha1 = nextFile?.hashes?.sha1 ? String(nextFile.hashes.sha1).toLowerCase() : null;
    const sameFile = Boolean(nextSha1 && nextSha1 === item.sha1);
    const sameVersionId = Boolean(currentVer?.id && updateVer?.id && currentVer.id === updateVer.id);

    let status = 'untracked';
    if (knownOnModrinth) {
      status = (compatible && nextFile && !sameFile && !sameVersionId) ? 'update_available' : 'up_to_date';
    }

    const currentVersion = currentVer?.version_number || item.localInfo?.version || null;
    const latestVersion = status === 'update_available' ? (updateVer.version_number || null) : currentVersion;
    const slug = project?.slug || null;

    return {
      file: item.file,
      sha1: item.sha1,
      name: project?.title || item.localInfo?.name || item.file.replace(/\.jar$/i, ''),
      icon: project?.icon_url || null,
      projectId,
      slug,
      url: slug ? `https://modrinth.com/mod/${slug}` : null,
      currentVersion,
      currentVersionId: currentVer?.id || null,
      status,
      latestVersion,
      latestVersionId: status === 'update_available' ? (updateVer.id || null) : null,
      latestFile: status === 'update_available'
        ? {
            filename: nextFile.filename,
            url: nextFile.url,
            sha1: nextSha1,
            size: nextFile.size || null,
          }
        : null,
      versionType: status === 'update_available' ? (updateVer.version_type || null) : null,
      changelog: status === 'update_available' ? (updateVer.changelog || null) : null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const data = {
    mods,
    updatesCount: mods.filter(m => m.status === 'update_available').length,
    checkedAt: new Date().toISOString(),
    target: { mcVersion: ctx.mcVersion, loader: ctx.loader },
  };
  cache.set(server.id, { expiresAt: Date.now() + CACHE_TTL_MS, signature, data });
  return { ...data, cached: false };
}

/**
 * Met à jour un ou plusieurs mods (ou 'all'), séquentiellement, sous verrou serveur.
 * L'ancien .jar est déplacé dans la corbeille modManager (restauration possible).
 */
async function updateMods(server, filenames) {
  const ctx = targetContext(server);
  const isAll = filenames === 'all';
  let requestedFiles = [];

  if (!isAll) {
    if (!Array.isArray(filenames) || filenames.length === 0) {
      throw httpError(400, 'Liste de fichiers requise (tableau non vide ou "all")');
    }
    requestedFiles = [...new Set(filenames)];
    for (const file of requestedFiles) {
      if (!modManager.validModFile(file)) {
        throw httpError(400, `Nom de fichier invalide : ${file}`);
      }
      const abs = path.join(ctx.dir, file);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        throw httpError(404, `Mod introuvable : ${file}`);
      }
    }
  }

  return serverLock.withLock(server.id, 'mise à jour des mods', async () => {
    const check = await checkUpdates(server);
    const byFile = new Map(check.mods.map(m => [m.file, m]));
    /** @type {any[]} */
    const results = [];

    /** @type {any[]} */
    const queue = [];
    if (isAll) {
      queue.push(...check.mods.filter(m => m.status === 'update_available'));
    } else {
      for (const file of requestedFiles) {
        if (/\.disabled$/i.test(file)) {
          results.push({ file, name: file.replace(/\.jar\.disabled$/i, ''), status: 'skipped', reason: 'disabled' });
          continue;
        }
        const entry = byFile.get(file);
        if (!entry) {
          results.push({ file, name: file.replace(/\.jar$/i, ''), status: 'skipped', reason: 'untracked' });
          continue;
        }
        queue.push(entry);
      }
    }

    fs.rmSync(ctx.tmp, { recursive: true, force: true });
    fs.mkdirSync(ctx.tmp, { recursive: true });
    const { _internals: { downloadFile } } = require('./installer');

    try {
      for (const item of queue) {
        if (item.status !== 'update_available' || !item.latestFile?.url) {
          results.push({
            file: item.file,
            name: item.name,
            fromVersion: item.currentVersion,
            toVersion: item.latestVersion,
            status: 'skipped',
            reason: item.status || 'up_to_date',
          });
          continue;
        }

        const newFilename = item.latestFile.filename;
        if (!modManager.validModFile(newFilename) || /\.disabled$/i.test(newFilename)) {
          results.push({
            file: item.file,
            name: item.name,
            status: 'error',
            error: `Nom de fichier distant invalide : ${newFilename}`,
          });
          continue;
        }

        const oldPath = path.join(ctx.dir, item.file);
        if (!fs.existsSync(oldPath)) {
          results.push({ file: item.file, name: item.name, status: 'skipped', reason: 'missing' });
          continue;
        }

        const tmpDest = path.join(ctx.tmp, newFilename);
        const finalDest = path.join(ctx.dir, newFilename);
        try {
          const expected = { sha1: item.latestFile.sha1 };
          await downloadFile(item.latestFile.url, tmpDest, null, expected);

          fs.mkdirSync(ctx.trash, { recursive: true });
          let trashDest = path.join(ctx.trash, item.file);
          if (fs.existsSync(trashDest)) trashDest = path.join(ctx.trash, `${Date.now()}-${item.file}`);
          moveFile(oldPath, trashDest);

          // Si un fichier du même nom cible existe déjà (différent de l'ancien), on le sauvegarde en corbeille aussi
          if (newFilename !== item.file && fs.existsSync(finalDest)) {
            let existingTrash = path.join(ctx.trash, newFilename);
            if (fs.existsSync(existingTrash)) existingTrash = path.join(ctx.trash, `${Date.now()}-${newFilename}`);
            moveFile(finalDest, existingTrash);
          }

          moveFile(tmpDest, finalDest);
          modManager._internals?.infoCache?.delete(oldPath);
          modManager._internals?.infoCache?.delete(finalDest);

          results.push({
            file: item.file,
            newFile: newFilename,
            name: item.name,
            fromVersion: item.currentVersion,
            toVersion: item.latestVersion,
            status: 'updated',
          });
        } catch (err) {
          try { fs.rmSync(tmpDest, { force: true }); } catch {}
          results.push({
            file: item.file,
            name: item.name,
            fromVersion: item.currentVersion,
            toVersion: item.latestVersion,
            status: 'error',
            error: err.message,
          });
        }
      }
    } finally {
      fs.rmSync(ctx.tmp, { recursive: true, force: true });
      invalidateCache(server.id);
    }

    const updatedCount = results.filter(r => r.status === 'updated').length;
    const skippedCount = results.filter(r => r.status === 'skipped').length;
    const failedCount = results.filter(r => r.status === 'error').length;
    const restartRequired = ['running', 'starting'].includes(server.status) && updatedCount > 0;

    return { results, updatedCount, skippedCount, failedCount, restartRequired };
  });
}

module.exports = {
  checkUpdates,
  updateMods,
  invalidateCache,
  _internals: { cache, targetContext, isCompatibleVersion, selectPrimaryJar, sha1File },
};
