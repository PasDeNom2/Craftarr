const path = require('path');
const fs = require('fs');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { getDb } = require('../../config/database');
const dockerService = require('../docker');
const curseforge = require('../curseforge');
const cfExcludes = require('../cfExcludes');
const { readModInfo, unmetRequirements, listJars } = require('../modJar');
const { isMcVersion, mcVersionFromNeoForge, loaderVersionFromSetupConfig } = require('../mcVersion');
const { emit, progress, getIo } = require('./progress');
const { downloadAny, safeJoin } = require('./download');
const { packLoader, reportModProblems, writePackMeta, formatFailures, extractMcVer, detectLoader } = require('./utils');

const DATA_PATH = process.env.DATA_PATH || '/data';

// Map serverId → { resolve, reject } pour attendre la confirmation utilisateur (no server pack)
const pendingClientPackConfirm = new Map();

function confirmClientPack(serverId) {
  const p = pendingClientPackConfirm.get(serverId);
  if (p) { pendingClientPackConfirm.delete(serverId); p.resolve(); }
}
function cancelClientPack(serverId) {
  const p = pendingClientPackConfirm.get(serverId);
  if (p) { pendingClientPackConfirm.delete(serverId); p.reject(new Error('Installation annulée par l\'utilisateur')); }
}

/**
 * Fichiers CurseForge à installer pour la version demandée :
 *  - clientFile : le client pack (manifest.json = source de vérité : version MC + loader exact),
 *  - serverPackFile : le server pack associé À CETTE VERSION uniquement, ou null.
 * Jamais de repli silencieux sur une autre version : un server pack d'une autre version
 * (autre version MC / autres mods) rendait le serveur incompatible avec les clients.
 */
async function resolveCurseForgeFiles(apiKey, server) {
  let clientFile = null;
  let serverPackFile = null;

  if (server.modpack_version_id) {
    let picked;
    try {
      picked = await curseforge.getFileById(apiKey, server.modpack_id, server.modpack_version_id);
    } catch (err) {
      throw new Error(`Version ${server.modpack_version_id} du modpack introuvable sur CurseForge (${err.response?.status || err.message})`);
    }
    if (picked.isServerPack) {
      // L'utilisateur a choisi le server pack lui-même : remonter au client pack correspondant
      serverPackFile = picked;
      clientFile = picked.parentProjectFileId
        ? await curseforge.getFileById(apiKey, server.modpack_id, picked.parentProjectFileId).catch(() => null)
        : null;
    } else {
      clientFile = picked;
    }
  } else {
    const files = await curseforge.getModpackFiles(apiKey, server.modpack_id);
    clientFile = files.find(f => !f.isServerPack) || null;
  }
  if (!clientFile && !serverPackFile) throw new Error('Aucun fichier de modpack trouvé pour ' + server.modpack_id);

  if (!serverPackFile && clientFile?.serverPackFileId) {
    try {
      serverPackFile = await curseforge.getFileById(apiKey, server.modpack_id, clientFile.serverPackFileId);
    } catch (err) {
      console.warn(`[Installer] Server pack ${clientFile.serverPackFileId} inaccessible : ${err.message}`);
    }
  }
  return { clientFile, serverPackFile };
}

/** Version MC + loader exacts déclarés par un manifest CurseForge (modLoaders[].id = "neoforge-21.1.77"). */
function manifestMeta(manifest) {
  if (!manifest) return { mcVersion: null, loader: null, loaderVersion: null };
  const loaders = manifest.minecraft?.modLoaders || [];
  const primary = loaders.find(l => l.primary) || loaders[0];
  const m = primary?.id?.match(/^(neoforge|forge|fabric|quilt)-(.+)$/i);
  return {
    mcVersion: isMcVersion(manifest.minecraft?.version) ? manifest.minecraft.version : null,
    loader: m ? m[1].toLowerCase() : null,
    loaderVersion: m ? m[2] : null,
  };
}

/** Slug CurseForge du modpack (pour les exceptions par pack de la liste client-only), ou null. */
async function modpackSlug(apiKey, modpackId) {
  try {
    return (await curseforge.getModsInfo(apiKey, [modpackId])).get(String(modpackId))?.slug || null;
  } catch { return null; }
}

/**
 * Installe un modpack CurseForge :
 *   1. server pack de la version choisie s'il existe (fat : mods inclus, thin : ServerStarter),
 *   2. sinon (ou server pack vide) client pack : manifest.json → mods via l'API, sans les mods client-only.
 * Dans tous les cas la version exacte du loader est lue dans le manifest du client pack et épinglée
 * (.craftarr-pack.json), sinon itzg installe le dernier Forge/NeoForge → mods incompatibles.
 */
async function installCurseForgeModpack(server, serverDir, modsDir, apiKey, mcVersion, runThinPackSetup) {
  const db = getDb();

  progress(server.id, 'resolve', 'Récupération des informations du modpack', 20);
  const { clientFile, serverPackFile } = await resolveCurseForgeFiles(apiKey, server);

  // Manifest du client pack : ne télécharge que manifest.json quand le CDN le permet
  const manifest = clientFile ? await curseforge.getClientManifest(clientFile).catch(() => null) : null;
  const meta = manifestMeta(manifest);
  const refFile = clientFile || serverPackFile;
  const loaderType = meta.loader || detectLoader(refFile.gameVersions);
  const resolvedMcVersion = meta.mcVersion || extractMcVer(refFile.gameVersions) || mcVersion;
  if (meta.loader) {
    progress(server.id, 'resolve', `Minecraft ${resolvedMcVersion || '?'} — ${meta.loader} ${meta.loaderVersion}`, 21);
  }

  db.prepare('UPDATE servers SET mc_version = ?, loader_type = ?, modpack_version = ?, modpack_version_id = ? WHERE id = ?')
    .run(resolvedMcVersion, loaderType, refFile.displayName || refFile.fileName, String(refFile.id), server.id);

  // Pas de server pack : demander confirmation avant d'installer depuis le pack client
  if (!serverPackFile) {
    progress(server.id, 'warn', 'Aucun server pack disponible pour cette version', 22);
    await waitClientPackConfirmation(server, clientFile);
    progress(server.id, 'info', 'Installation avec le pack client confirmée', 24);
  }

  const zipPath = path.join(DATA_PATH, 'servers', server.id, 'pack.zip');

  if (serverPackFile) {
    console.log(`[Installer] SERVER PACK : ${serverPackFile.displayName || serverPackFile.id}`);
    progress(server.id, 'download', 'Téléchargement du server pack', 25);
    await downloadAny(curseforge.fileUrls(serverPackFile), zipPath, pct =>
      progress(server.id, 'download', `Server pack : ${pct}%`, 25 + Math.floor(pct * 0.1)));

    progress(server.id, 'extract', 'Extraction du server pack', 40);
    const zip = new AdmZip(zipPath);
    for (const entry of zip.getEntries()) safeJoin(serverDir, entry.entryName); // zip-slip
    zip.extractAllTo(serverDir, true);
    fs.unlinkSync(zipPath);
    hoistNestedServerPack(serverDir);
    if (meta.loader) writePackMeta(serverDir, meta);

    // Server pack "fat" : les mods sont fournis
    const jarCount = listJars(modsDir).length;
    if (jarCount > 0) {
      progress(server.id, 'mods_done', `Server pack extrait (${jarCount} mods)`, 78);
      reportModProblems(server, serverDir);
      return;
    }

    // Thin server pack (ex: Craftoria, ATM) — startserver.sh dans un container temporaire installe loader + mods
    const thinScript = dockerService.detectThinPackStartScript(serverDir);
    if (thinScript) {
      await runThinPackSetup(server, serverDir, thinScript);
      // CurseForge ne liste pas toujours la version MC (schéma 26.x) → la déduire du NeoForge installé
      if (!isMcVersion(resolvedMcVersion)) {
        const mc = mcVersionFromNeoForge(loaderVersionFromSetupConfig(serverDir));
        if (mc) db.prepare('UPDATE servers SET mc_version = ? WHERE id = ?').run(mc, server.id);
      }
      reportModProblems(server, serverDir);
      return;
    }

    // Server pack sans mods ni ServerStarter : avant, le serveur démarrait sans aucun mod
    if (!clientFile) throw new Error('Server pack vide (aucun mod, aucun script d\'installation) et pack client introuvable');
    progress(server.id, 'warn', 'Server pack sans mods — installation des mods depuis le pack client', 45);
  }

  progress(server.id, 'download', 'Téléchargement du pack client', 46);
  await downloadAny(curseforge.fileUrls(clientFile), zipPath, pct =>
    progress(server.id, 'download', `Pack client : ${pct}%`, 46 + Math.floor(pct * 0.04)));
  progress(server.id, 'parse', 'Lecture du manifest', 50);
  await downloadModsFromClientPack(server, zipPath, serverDir, modsDir, apiKey);
  reportModProblems(server, serverDir);
}

/** Attend (5 min max) que l'utilisateur confirme l'installation sans server pack. */
function waitClientPackConfirmation(server, clientFile) {
  const io = getIo();
  if (io) io.to(`server:${server.id}`).emit('install:no-server-pack', {
    serverId: server.id,
    modpackName: clientFile?.displayName || clientFile?.fileName,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingClientPackConfirm.has(server.id)) {
        pendingClientPackConfirm.delete(server.id);
        reject(new Error('Délai dépassé — installation annulée (aucune réponse)'));
      }
    }, 5 * 60 * 1000);
    pendingClientPackConfirm.set(server.id, {
      resolve: () => { clearTimeout(timer); resolve(); },
      reject: (err) => { clearTimeout(timer); reject(err); },
    });
  });
}

/**
 * Beaucoup de server packs mettent tout dans un sous-dossier (ex: "Pack-Server-1.2/mods/…") :
 * mods/ n'était alors pas à la racine du serveur et le serveur démarrait sans mods.
 * Si la racine n'a pas de mods/ et qu'UN seul sous-dossier en a un, on remonte son contenu.
 */
function hoistNestedServerPack(serverDir) {
  if (listJars(path.join(serverDir, 'mods')).length > 0) return;
  const candidates = fs.readdirSync(serverDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !['mods', '__MACOSX', '.craftarr'].includes(e.name))
    .filter(d => listJars(path.join(serverDir, d.name, 'mods')).length > 0);
  if (candidates.length !== 1) return;
  const nested = path.join(serverDir, candidates[0].name);
  for (const name of fs.readdirSync(nested)) {
    const dest = path.join(serverDir, name);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(path.join(nested, name), dest);
  }
  fs.rmSync(nested, { recursive: true, force: true });
  console.log(`[Installer] Server pack remonté depuis le sous-dossier ${candidates[0].name}/`);
}

/** Dossier où sont mis de côté les mods client-only (consultables / restaurables à la main). */
const clientModsDir = serverDir => path.join(serverDir, '.craftarr', 'client-mods');

/**
 * Télécharge les mods depuis un client pack CurseForge (.zip avec manifest.json).
 * Extrait les overrides et télécharge chaque mod JAR depuis l'API CurseForge :
 *  - mods désactivés dans le pack (required: false) ignorés,
 *  - mods client-only (liste communautaire, tag CurseForge, server-setup-config.yaml) mis de côté,
 *    puis réintégrés si un mod serveur en dépend (sinon : crash "missing dependency").
 */
async function downloadModsFromClientPack(server, zipPath, serverDir, modsDir, apiKey) {
  const zip = new AdmZip(zipPath);
  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) {
    // Pas un manifest CurseForge standard — extraction brute
    for (const entry of zip.getEntries()) safeJoin(serverDir, entry.entryName);
    zip.extractAllTo(serverDir, true);
    fs.unlinkSync(zipPath);
    return;
  }

  const manifest = JSON.parse(zip.readAsText('manifest.json'));
  writePackMeta(serverDir, manifestMeta(manifest));

  // Extraire les overrides (configs, scripts, etc.)
  const overridesDir = manifest.overrides || 'overrides';
  zip.getEntries().forEach(entry => {
    if (entry.entryName.startsWith(overridesDir + '/') && !entry.isDirectory) {
      const relative = entry.entryName.slice(overridesDir.length + 1);
      const dest = safeJoin(serverDir, relative);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entry.getData());
    }
  });
  fs.unlinkSync(zipPath);

  // required: false = mod désactivé par l'auteur du pack (souvent justement parce qu'incompatible)
  const wanted = (manifest.files || []).filter(f => f.required !== false);
  const disabled = (manifest.files?.length || 0) - wanted.length;
  if (disabled) console.log(`[Installer] ${disabled} mod(s) désactivé(s) dans le manifest ignoré(s)`);
  const totalMods = wanted.length;
  console.log(`[Installer] ${totalMods} mods à télécharger pour ${server.modpack_id}`);
  if (totalMods === 0) return;

  progress(server.id, 'mods', `Résolution de ${totalMods} mods...`, 52);

  // Batch: récupérer les infos de tous les fichiers (CurseForge bulk endpoint)
  const fileIds = wanted.map(f => f.fileID);
  const modFiles = await fetchModFilesBulk(apiKey, fileIds);

  // Un fichier absent de la réponse API = un mod qu'on ne pourra pas installer → le serveur crasherait
  const returnedIds = new Set(modFiles.map(f => String(f.id)));
  const unresolved = fileIds.filter(id => !returnedIds.has(String(id)));
  if (unresolved.length) {
    throw new Error(`${unresolved.length} mod(s) introuvable(s) sur l'API CurseForge (fileID : ${formatFailures(unresolved)})`);
  }

  // Slugs des projets (liste client-only) + exceptions propres au modpack
  const projects = await curseforge.getModsInfo(apiKey, [...new Set(modFiles.map(f => f.modId))]).catch(err => {
    console.warn(`[Installer] Infos projets indisponibles (${err.message}) — filtrage client-only réduit`);
    return new Map();
  });
  const rules = await cfExcludes.getRules(await modpackSlug(apiKey, server.modpack_id));
  const ignoredProjectIds = readIgnoredProjects(serverDir);

  const holdDir = clientModsDir(serverDir);
  fs.rmSync(holdDir, { recursive: true, force: true });
  fs.mkdirSync(holdDir, { recursive: true });

  let done = 0;
  let excluded = 0;
  const failures = [];
  const CONCURRENCY = 6;

  for (let i = 0; i < modFiles.length; i += CONCURRENCY) {
    const batch = modFiles.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (file) => {
      if (!file.fileName) { failures.push(`fileID ${file.id}`); return; }
      const project = projects.get(String(file.modId));
      const reason = clientOnlyReason(file, project?.slug, rules, ignoredProjectIds);
      if (reason) excluded++;

      const dest = safeJoin(reason ? holdDir : modsDir, file.fileName);
      if (fs.existsSync(dest)) { done++; return; }
      const sha1 = (file.hashes || []).find(h => h.algo === 1)?.value;
      try {
        await downloadAny(curseforge.fileUrls(file), dest, null, sha1 ? { sha1 } : {});
        done++;
      } catch (err) {
        console.warn(`[Installer] ${err.message}`);
        if (reason) return; // un mod client-only introuvable n'empêche pas le serveur de démarrer
        const blocked = project && !project.allowModDistribution;
        failures.push(blocked ? `${file.fileName} (distribution tierce interdite par l'auteur)` : file.fileName);
      }
    }));
    const pct = Math.min(100, Math.round((i + CONCURRENCY) / modFiles.length * 100));
    progress(server.id, 'mods', `Mods : ${done}/${totalMods} téléchargés`, 52 + Math.floor(pct * 0.26));
  }

  if (failures.length) {
    // Mieux vaut échouer clairement que démarrer un serveur qui crashera en boucle (mods manquants)
    throw new Error(`${failures.length} mod(s) n'ont pas pu être téléchargés : ${formatFailures(failures)}. `
      + 'Relancez l\'installation, ou téléchargez-les depuis CurseForge et déposez-les dans mods/.');
  }

  const restored = restoreRequiredClientMods(modsDir, holdDir);
  if (restored.length) {
    emit(server.id, 'log', {
      line: `[Craftarr] ${restored.length} mod(s) marqué(s) client-only mais requis par d'autres mods, conservé(s) : ${formatFailures(restored)}`,
      timestamp: Date.now(),
    });
  }
  const setAside = excluded - restored.length;
  console.log(`[Installer] Mods : ${listJars(modsDir).length} installés, ${setAside} client-only mis de côté, ${restored.length} réintégrés`);
  progress(server.id, 'mods_done', `${listJars(modsDir).length} mods installés`
    + (setAside > 0 ? ` (${setAside} mods client-only écartés)` : ''), 80);
}

/**
 * Pourquoi un mod CurseForge ne doit pas aller sur le serveur, ou null s'il doit y aller.
 * Ordre : exceptions du pack > server-setup-config.yaml > liste communautaire > tag CurseForge.
 */
function clientOnlyReason(file, slug, rules, ignoredProjectIds) {
  if (slug && rules.forceIncludes.has(slug)) return null;
  if (file.modId && ignoredProjectIds.has(String(file.modId))) return 'server-setup-config.yaml';
  if (slug && rules.excludes.has(slug)) return 'liste client-only';
  const versions = file.gameVersions || [];
  if (versions.includes('Client') && !versions.includes('Server')) return 'tag CurseForge « Client »';
  return null;
}

/**
 * Réintègre dans mods/ les jars mis de côté dont un mod serveur a besoin (dépendance obligatoire),
 * jusqu'à stabilisation. Les tags/listes client-only se trompent parfois : sans ça, le serveur
 * crashe sur "Missing mandatory dependencies". Retourne les noms des jars réintégrés.
 */
function restoreRequiredClientMods(modsDir, holdDir) {
  const prefer = packLoader(path.dirname(modsDir));
  const kept = listJars(modsDir).map(f => readModInfo(f, { prefer })).filter(Boolean);
  let held = listJars(holdDir).map(file => ({ file, info: readModInfo(file, { prefer }) })).filter(e => e.info);
  const restored = [];
  for (;;) {
    const need = unmetRequirements(kept);
    const pick = held.filter(e => e.info.ids.some(id => need.has(id)));
    if (!pick.length) break;
    for (const e of pick) {
      fs.renameSync(e.file, path.join(modsDir, path.basename(e.file)));
      kept.push(e.info);
      restored.push(path.basename(e.file));
    }
    held = held.filter(e => !pick.includes(e));
  }
  return restored;
}

/**
 * Lit la liste des projets CurseForge à ignorer depuis server-setup-config.yaml.
 * Ces IDs correspondent aux mods client-only listés par le modpack.
 */
function readIgnoredProjects(serverDir) {
  const ids = new Set();
  const configPath = path.join(serverDir, 'server-setup-config.yaml');
  if (!fs.existsSync(configPath)) return ids;
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    // Parser les IDs numériques sous ignoreProject: sans dépendance YAML
    let inIgnoreProject = false;
    for (const line of content.split('\n')) {
      if (line.trim().startsWith('ignoreProject:')) { inIgnoreProject = true; continue; }
      if (inIgnoreProject) {
        const match = line.match(/^\s+-\s+(\d+)/);
        if (match) ids.add(match[1]);
        else if (line.trim() && !line.trim().startsWith('-')) inIgnoreProject = false;
      }
    }
  } catch (err) {
    console.warn('[Installer] Impossible de lire server-setup-config.yaml:', err.message);
  }
  return ids;
}

async function fetchModFilesBulk(apiKey, fileIds) {
  // CurseForge bulk files endpoint — max 50 par appel, 3 tentatives par lot
  const results = [];
  for (let i = 0; i < fileIds.length; i += 50) {
    const chunk = fileIds.slice(i, i + 50);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await axios.post('https://api.curseforge.com/v1/mods/files', { fileIds: chunk }, {
          headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
          timeout: 30000,
        });
        results.push(...(res.data.data || []));
        break;
      } catch (err) {
        console.error(`[Installer] Bulk files error (tentative ${attempt}/3):`, err.response?.status, err.message);
        if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }
  return results;
}

module.exports = {
  confirmClientPack,
  cancelClientPack,
  resolveCurseForgeFiles,
  manifestMeta,
  modpackSlug,
  installCurseForgeModpack,
  waitClientPackConfirmation,
  hoistNestedServerPack,
  downloadModsFromClientPack,
  clientOnlyReason,
  restoreRequiredClientMods,
  readIgnoredProjects,
  fetchModFilesBulk,
};
