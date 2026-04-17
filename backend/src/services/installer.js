const path = require('path');
const fs = require('fs');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { getDb } = require('../config/database');
const dockerService = require('./docker');
const { getSourceApiKey } = require('./sourceAggregator');
const curseforge = require('./curseforge');
const modrinth = require('./modrinth');

const DATA_PATH = process.env.DATA_PATH || '/data';

let io;
function setIo(ioInstance) { io = ioInstance; }

function startLogStreamImmediate(ioInstance, serverId, containerId) {
  dockerService.streamContainerLogs(
    containerId,
    line => {
      ioInstance.to(`server:${serverId}`).emit('log', { serverId, line, timestamp: Date.now() });
      if (line.includes(']: Done (') || line.includes(': Done (')) {
        const db = getDb();
        db.prepare('UPDATE servers SET status = ? WHERE id = ? AND status = ?').run('running', serverId, 'starting');
      }
    },
    err => console.error(`[Installer][Logs] ${serverId.slice(0,8)}:`, err.message)
  );
}

function emit(serverId, event, data) {
  if (io) io.to(`server:${serverId}`).emit(event, { serverId, ...data });
}

function progress(serverId, step, message, percent) {
  emit(serverId, 'install:progress', { step, message, percent });
  console.log(`[Installer][${serverId.slice(0, 8)}] ${step}: ${message}`);
}

async function installServer(server) {
  const db = getDb();
  const serverDir = path.join(DATA_PATH, 'servers', server.id, 'server');
  const modsDir = path.join(serverDir, 'mods');
  fs.mkdirSync(serverDir, { recursive: true });
  fs.mkdirSync(modsDir, { recursive: true });

  try {
    progress(server.id, 'prepare', 'Préparation du répertoire serveur', 5);

    const { mcVersion, loaderType, apiKey } = await resolveModpackMeta(server);

    progress(server.id, 'pull', 'Téléchargement de l\'image Docker itzg/minecraft-server', 15);
    await dockerService.pullImage('itzg/minecraft-server:latest',
      evt => { if (evt.status === 'Downloading') progress(server.id, 'pull', `Docker pull: ${evt.id || ''}`, 15); }
    );

    // Téléchargement et installation des mods selon la source
    if (server.modpack_source === 'curseforge' && apiKey) {
      await installCurseForgeModpack(server, serverDir, modsDir, apiKey, mcVersion);
    } else {
      await installGenericModpack(server, serverDir);
    }

    const updatedServer = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);

    progress(server.id, 'container', 'Téléchargement de l\'image Java (première fois uniquement)...', 82);
    const { containerId, containerName } = await dockerService.createServerContainer(updatedServer, (event) => {
      if (event.status && event.progress) {
        progress(server.id, 'container', `Image Docker : ${event.status} ${event.progress}`, 82);
      }
    });

    progress(server.id, 'start', 'Démarrage du serveur Minecraft', 92);
    await dockerService.startContainer(containerId);

    db.prepare('UPDATE servers SET status = ?, container_id = ?, container_name = ? WHERE id = ?')
      .run('starting', containerId, containerName, server.id);
    progress(server.id, 'done', 'Container démarré — initialisation Minecraft en cours...', 100);
    emit(server.id, 'install:done', { status: 'starting' });

    if (io) startLogStreamImmediate(io, server.id, containerId);
  } catch (err) {
    db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('error', server.id);
    emit(server.id, 'install:error', { message: err.message });
    throw err;
  }
}

/**
 * Installe un modpack CurseForge en téléchargeant tous les mods via l'API.
 * Méthode :
 *   1. Récupère le fichier client pack (manifest.json + overrides)
 *   2. Parse manifest.json pour lister les mods
 *   3. Télécharge chaque mod JAR depuis CurseForge CDN
 *   4. Copie les overrides (configs) dans serverDir
 */
async function installCurseForgeModpack(server, serverDir, modsDir, apiKey, mcVersion) {
  const db = getDb();

  // Trouver le server pack (priorité) ou le client pack si aucun server pack disponible
  progress(server.id, 'resolve', 'Récupération des informations du modpack', 20);
  const files = await curseforge.getModpackFiles(apiKey, server.modpack_id);

  // Séparer server packs et client packs
  const serverPacks = files.filter(f => f.isServerPack);
  const clientPacks = files.filter(f => !f.isServerPack);

  let clientFile = clientPacks[0]; // fichier client de référence (pour la version)
  if (server.modpack_version_id) {
    clientFile = clientPacks.find(f => String(f.id) === String(server.modpack_version_id)) || clientPacks[0];
  }
  if (!clientFile) throw new Error('Aucun fichier de modpack trouvé pour ' + server.modpack_id);

  // Chercher le server pack correspondant à la version client sélectionnée
  // La liste paginée peut ne pas le contenir — on le récupère directement par ID si possible
  let serverPackFile = null;
  if (clientFile.serverPackFileId) {
    // Essayer d'abord dans la liste déjà chargée
    serverPackFile = serverPacks.find(f => String(f.id) === String(clientFile.serverPackFileId));
    // Sinon fetch direct par ID
    if (!serverPackFile) {
      try {
        const fetched = await curseforge.getFileById(apiKey, server.modpack_id, clientFile.serverPackFileId);
        if (fetched && fetched.isServerPack) serverPackFile = fetched;
        else if (fetched) serverPackFile = fetched; // accepter même si isServerPack n'est pas marqué
      } catch (err) {
        console.warn(`[Installer] Impossible de récupérer le server pack ${clientFile.serverPackFileId}:`, err.message);
      }
    }
  }
  if (!serverPackFile && serverPacks.length > 0) {
    // Prendre le server pack le plus récent de la liste
    serverPackFile = serverPacks[0];
  }

  const targetFile = serverPackFile || clientFile;
  const isUsingServerPack = !!serverPackFile;
  console.log(`[Installer] Utilisation du ${isUsingServerPack ? 'SERVER PACK' : 'client pack'} : ${targetFile.displayName || targetFile.id}`);

  // CurseForge peut retourner downloadUrl: null — fallback CDN
  const packUrl = targetFile.downloadUrl || buildCurseForgeUrl(targetFile.id, targetFile.fileName);
  // Déduire mc_version et loader depuis le client pack (plus fiable car le server pack peut ne pas les lister)
  const refFile = clientFile;
  const loaderType = detectLoader(refFile.gameVersions);
  const resolvedMcVersion = extractMcVer(refFile.gameVersions) || mcVersion;

  db.prepare('UPDATE servers SET mc_version = ?, loader_type = ? WHERE id = ?')
    .run(resolvedMcVersion, loaderType, server.id);

  const packLabel = isUsingServerPack ? 'server pack' : 'pack client (manifest)';
  progress(server.id, 'download', `Téléchargement du ${packLabel}`, 25);
  const zipPath = path.join(DATA_PATH, 'servers', server.id, 'pack.zip');
  await downloadFile(packUrl, zipPath, pct =>
    progress(server.id, 'download', `Téléchargement ${packLabel} : ${pct}%`, 25 + Math.floor(pct * 0.1))
  );

  // Server pack : extraction directe (contient déjà les JARs prêts pour le serveur)
  if (isUsingServerPack) {
    progress(server.id, 'extract', 'Extraction du server pack', 60);
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(serverDir, true);
    fs.unlinkSync(zipPath);

    // Vérifier si le server pack est "fat" (contient des mods) ou "thin" (délègue à ServerStarter)
    const jarCount = fs.existsSync(modsDir)
      ? fs.readdirSync(modsDir).filter(f => f.endsWith('.jar')).length
      : 0;

    if (jarCount > 0) {
      progress(server.id, 'mods_done', `Server pack extrait (${jarCount} mods)`, 80);
      return;
    }

    // Thin server pack (ex: Craftoria) — aucun mod dans le zip.
    // Le container itzg ne lancera pas ServerStarter car NeoForge est déjà détecté comme installé.
    // On télécharge le client pack pour extraire les mods via notre propre downloader.
    progress(server.id, 'info', 'Thin server pack détecté — téléchargement des mods via le client pack', 62);
    const clientPackUrl = clientFile.downloadUrl || buildCurseForgeUrl(clientFile.id, clientFile.fileName);
    const clientZipPath = path.join(DATA_PATH, 'servers', server.id, 'pack.zip');
    await downloadFile(clientPackUrl, clientZipPath, pct =>
      progress(server.id, 'download', `Client pack : ${pct}%`, 62 + Math.floor(pct * 0.08))
    );
    await downloadModsFromClientPack(server, clientZipPath, serverDir, modsDir, apiKey);
    return;
  }

  // Client pack : parser le manifest et télécharger les mods via l'API
  progress(server.id, 'parse', 'Lecture du manifest', 36);
  await downloadModsFromClientPack(server, zipPath, serverDir, modsDir, apiKey);
}

/**
 * Télécharge les mods depuis un client pack CurseForge (.zip avec manifest.json).
 * Extrait les overrides et télécharge chaque mod JAR depuis l'API CurseForge.
 * Réutilisé par les thin server packs (pas de mods dans le server pack).
 */
async function downloadModsFromClientPack(server, zipPath, serverDir, modsDir, apiKey) {
  const zip = new AdmZip(zipPath);
  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) {
    // Pas un manifest CurseForge standard — extraction brute
    zip.extractAllTo(serverDir, true);
    fs.unlinkSync(zipPath);
    return;
  }

  const manifest = JSON.parse(zip.readAsText('manifest.json'));
  const totalMods = manifest.files?.length || 0;
  console.log(`[Installer] ${totalMods} mods à télécharger pour ${server.modpack_id}`);

  // Extraire les overrides (configs, scripts, etc.)
  const overridesDir = manifest.overrides || 'overrides';
  zip.getEntries().forEach(entry => {
    if (entry.entryName.startsWith(overridesDir + '/') && !entry.isDirectory) {
      const relative = entry.entryName.slice(overridesDir.length + 1);
      const dest = path.join(serverDir, relative);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entry.getData());
    }
  });
  fs.unlinkSync(zipPath);

  if (totalMods === 0) return;

  progress(server.id, 'mods', `Résolution de ${totalMods} mods...`, 38);

  // Batch: récupérer les infos de tous les fichiers en 1 appel (CurseForge bulk endpoint)
  const fileIds = manifest.files.map(f => f.fileID);
  const modFiles = await fetchModFilesBulk(apiKey, fileIds);

  // Lire les projets à ignorer depuis server-setup-config.yaml (mods client-only listés par le modpack)
  const ignoredProjectIds = readIgnoredProjects(serverDir);
  if (ignoredProjectIds.size > 0) {
    console.log(`[Installer] ${ignoredProjectIds.size} projets client-only ignorés (server-setup-config.yaml)`);
  }

  let downloaded = 0;
  let skipped = 0;
  const CONCURRENCY = 5;

  for (let i = 0; i < modFiles.length; i += CONCURRENCY) {
    const batch = modFiles.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (file) => {
      if (!file || !file.fileName) { skipped++; return; }

      // Ignorer les mods client-only listés dans server-setup-config.yaml
      if (file.modId && ignoredProjectIds.has(String(file.modId))) { skipped++; return; }

      const dest = path.join(modsDir, file.fileName);
      if (fs.existsSync(dest)) { downloaded++; return; }

      // CurseForge peut retourner downloadUrl: null (restrictions CDN)
      const url = file.downloadUrl || buildCurseForgeUrl(file.id, file.fileName);
      try {
        await downloadFile(url, dest);
        downloaded++;
      } catch {
        skipped++;
      }
    }));
    const pct = Math.round((i + CONCURRENCY) / modFiles.length * 100);
    progress(server.id, 'mods', `Mods : ${downloaded}/${totalMods} téléchargés`, 38 + Math.floor(pct * 0.42));
  }

  console.log(`[Installer] Mods téléchargés: ${downloaded}, ignorés: ${skipped}`);
  progress(server.id, 'mods_done', `${downloaded} mods installés`, 80);
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
  // CurseForge bulk files endpoint — max 50 par appel
  const results = [];
  for (let i = 0; i < fileIds.length; i += 50) {
    const chunk = fileIds.slice(i, i + 50);
    try {
      const res = await axios.post('https://api.curseforge.com/v1/mods/files', { fileIds: chunk }, {
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        timeout: 30000,
      });
      results.push(...(res.data.data || []));
    } catch (err) {
      console.error(`[Installer] Bulk files error:`, err.response?.status, err.message);
    }
  }
  return results;
}

async function installGenericModpack(server, serverDir) {
  const db = getDb();
  const sourceRow = db.prepare('SELECT * FROM api_sources WHERE id = ?').get(server.modpack_source);
  if (!sourceRow) return;
  const apiKey = getSourceApiKey(sourceRow);

  let mcVersion = server.mc_version;
  let loaderType = server.loader_type;
  let downloadUrl = null;

  if (server.modpack_source === 'modrinth') {
    // Récupère la version sélectionnée (ou la plus récente)
    const versions = await modrinth.getVersions(apiKey, server.modpack_id);
    let selectedVersion = versions[0];
    if (server.modpack_version_id) {
      selectedVersion = versions.find(v => v.id === server.modpack_version_id) || versions[0];
    }
    if (!selectedVersion) throw new Error('Aucune version Modrinth trouvée pour ' + server.modpack_id);

    mcVersion = selectedVersion.mcVersions?.[0] || mcVersion;
    loaderType = selectedVersion.loaders?.[0] || loaderType;

    // Fichier principal (.mrpack)
    const primaryFile = selectedVersion.files.find(f => f.primary) || selectedVersion.files[0];
    if (!primaryFile?.url) throw new Error('Aucun fichier .mrpack trouvé pour la version ' + selectedVersion.id);
    downloadUrl = primaryFile.url;

    progress(server.id, 'download', `Téléchargement du modpack Modrinth`, 30);
    const mrpackPath = path.join(DATA_PATH, 'servers', server.id, 'modpack.mrpack');
    await downloadFile(downloadUrl, mrpackPath, pct =>
      progress(server.id, 'download', `Téléchargement : ${pct}%`, 30 + Math.floor(pct * 0.2))
    );

    progress(server.id, 'extract', 'Extraction et installation des mods serveur', 50);
    await installMrpack(server, mrpackPath, serverDir, apiKey);
    fs.unlinkSync(mrpackPath);
  }

  db.prepare('UPDATE servers SET mc_version = ?, loader_type = ?, modpack_download_url = ? WHERE id = ?')
    .run(mcVersion, loaderType, downloadUrl, server.id);
}

/**
 * Installe un modpack au format .mrpack (Modrinth).
 * Parse modrinth.index.json, filtre les mods côté serveur,
 * télécharge les JARs et extrait overrides/ + server-overrides/.
 */
async function installMrpack(server, mrpackPath, serverDir, apiKey) {
  const modsDir = path.join(serverDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });

  const zip = new AdmZip(mrpackPath);
  const indexEntry = zip.getEntry('modrinth.index.json');
  if (!indexEntry) {
    // Pas un .mrpack standard — extraction brute
    zip.extractAllTo(serverDir, true);
    return;
  }

  const index = JSON.parse(zip.readAsText('modrinth.index.json'));
  console.log(`[Installer] Modrinth index v${index.formatVersion}, ${index.files?.length || 0} fichiers`);

  // Extraire overrides/ (client + serveur) et server-overrides/ (serveur uniquement)
  zip.getEntries().forEach(entry => {
    for (const prefix of ['overrides/', 'server-overrides/']) {
      if (entry.entryName.startsWith(prefix) && !entry.isDirectory) {
        const relative = entry.entryName.slice(prefix.length);
        const dest = path.join(serverDir, relative);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, entry.getData());
        return;
      }
    }
  });

  // Filtrer les fichiers compatibles serveur
  const serverFiles = (index.files || []).filter(f => {
    const env = f.env || {};
    // Garder si env.server est "required" ou "optional" (exclure "unsupported")
    if (env.server === 'unsupported') return false;
    // Si pas de contrainte env, on garde (comportement par défaut)
    return true;
  });

  const clientOnlySkipped = (index.files?.length || 0) - serverFiles.length;
  if (clientOnlySkipped > 0) {
    console.log(`[Installer] ${clientOnlySkipped} mods client-only ignorés`);
  }
  progress(server.id, 'mods', `Téléchargement de ${serverFiles.length} mods serveur...`, 55);

  let downloaded = 0;
  let failed = 0;
  const CONCURRENCY = 5;

  for (let i = 0; i < serverFiles.length; i += CONCURRENCY) {
    const batch = serverFiles.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (file) => {
      // Le chemin dans l'index est relatif à la racine du serveur (ex: "mods/mod.jar")
      const dest = path.join(serverDir, file.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (fs.existsSync(dest)) { downloaded++; return; }

      // Essayer chaque URL de téléchargement dans l'ordre
      const urls = file.downloads || [];
      for (const url of urls) {
        try {
          await downloadFile(url, dest);
          downloaded++;
          return;
        } catch {
          // Essayer l'URL suivante
        }
      }
      console.warn(`[Installer] Impossible de télécharger: ${file.path}`);
      failed++;
    }));
    const pct = Math.round((i + CONCURRENCY) / serverFiles.length * 100);
    progress(server.id, 'mods', `Mods : ${downloaded}/${serverFiles.length}`, 55 + Math.floor(pct * 0.25));
  }

  console.log(`[Installer] Modrinth mods: ${downloaded} téléchargés, ${failed} échoués, ${clientOnlySkipped} client-only ignorés`);
  progress(server.id, 'mods_done', `${downloaded} mods installés`, 80);
}

async function resolveModpackMeta(server) {
  const db = getDb();
  const sourceRow = db.prepare('SELECT * FROM api_sources WHERE id = ?').get(server.modpack_source);
  const apiKey = sourceRow ? getSourceApiKey(sourceRow) : null;
  return { mcVersion: server.mc_version, loaderType: server.loader_type, apiKey };
}

async function downloadFile(url, dest, onProgress) {
  const res = await axios.get(url, { responseType: 'stream', timeout: 120000 });
  const total = parseInt(res.headers['content-length'] || '0', 10);
  let downloaded = 0;

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(dest);
    res.data.on('data', chunk => {
      downloaded += chunk.length;
      if (total > 0 && onProgress) onProgress(Math.round((downloaded / total) * 100));
    });
    res.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
    res.data.on('error', reject);
  });
}

function extractModpack(zipPath, targetDir) {
  try {
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(targetDir, true);
  } catch {
    const { execSync } = require('child_process');
    execSync(`tar -xf "${zipPath}" -C "${targetDir}"`, { timeout: 60000 });
  }
}

/**
 * Construit l'URL CDN CurseForge quand downloadUrl est null.
 * Format : https://mediafilez.forgecdn.net/files/{id/1000}/{id%1000}/{fileName}
 */
function buildCurseForgeUrl(fileId, fileName) {
  const part1 = Math.floor(fileId / 1000);
  const part2 = fileId % 1000;
  return `https://mediafilez.forgecdn.net/files/${part1}/${part2}/${encodeURIComponent(fileName)}`;
}

function extractMcVer(versions = []) {
  // Minecraft versions always start with "1." — ignore NeoForge versions (26.x etc.)
  return versions.find(v => /^1\.\d+/.test(v)) || null;
}

function detectLoader(versions = []) {
  const v = versions.map(s => s.toLowerCase());
  if (v.some(s => s.includes('neoforge'))) return 'neoforge';
  if (v.some(s => s.includes('forge'))) return 'forge';
  if (v.some(s => s.includes('fabric'))) return 'fabric';
  if (v.some(s => s.includes('quilt'))) return 'quilt';
  return 'forge';
}

/**
 * Télécharge uniquement les mods pour un serveur déjà créé.
 * Utilisé pour réparer un serveur sans mods sans le recréer entièrement.
 */
async function installModsOnly(server, serverDir, modsDir) {
  const db = getDb();
  const sourceRow = db.prepare('SELECT * FROM api_sources WHERE id = ?').get(server.modpack_source);
  if (!sourceRow) throw new Error('Source introuvable: ' + server.modpack_source);
  const apiKey = getSourceApiKey(sourceRow);
  if (!apiKey) throw new Error('Clé API manquante pour ' + server.modpack_source);

  if (server.modpack_source === 'curseforge') {
    await installCurseForgeModpack(server, serverDir, modsDir, apiKey, server.mc_version);
  }
}

module.exports = { installServer, installModsOnly, setIo };
