const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { getDb } = require('../config/database');
const dockerService = require('./docker');
const { getSourceApiKey, getCurseForgeKey } = require('./sourceAggregator');
const curseforge = require('./curseforge');
const modrinth = require('./modrinth');
const { startLogStream } = require('../websocket/logs');
const { isMcVersion, mcVersionFromNeoForge, requiredJava, loaderVersionFromSetupConfig } = require('./mcVersion');

const DATA_PATH = process.env.DATA_PATH || '/data';
const HOST_DATA_PATH = process.env.HOST_DATA_PATH || DATA_PATH;

let io;
function setIo(ioInstance) { io = ioInstance; }

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

function emit(serverId, event, data) {
  if (io) io.to(`server:${serverId}`).emit(event, { serverId, ...data });
}

function progress(serverId, step, message, percent) {
  emit(serverId, 'install:progress', { step, message, percent });
  console.log(`[Installer][${serverId.slice(0, 8)}] ${step}: ${message}`);
}

/**
 * Callback de progression d'un docker pull : n'émet qu'une ligne par couche,
 * au lieu d'une par événement "Downloading" (des centaines de lignes identiques).
 */
function pullProgress(serverId, step, label, percent) {
  const seen = new Set();
  return (evt) => {
    if (evt.status !== 'Downloading' || !evt.id || seen.has(evt.id)) return;
    seen.add(evt.id);
    progress(serverId, step, `${label}: ${evt.id}`, percent);
  };
}

/**
 * Lance le startserver.sh du thin pack dans un container temporaire eclipse-temurin:21-jdk.
 * Utilise dockerode (socket Docker) — pas besoin du binaire docker dans le container backend.
 * Le script (ServerStarter) installe NeoForge + mods, puis démarre le serveur.
 * On stoppe le container dès que le serveur affiche "Done" — tout est installé à ce stade.
 * Renomme ensuite server-setup-config.yaml pour qu'itzg ne relance pas ServerStarter.
 */
async function runThinPackSetup(server, serverDir, thinScriptDataPath) {
  progress(server.id, 'thin_setup', 'Thin pack détecté — lancement de ServerStarter (installe NeoForge + mods)...', 30);

  fs.writeFileSync(path.join(serverDir, 'eula.txt'), 'eula=true\n');

  const hostServerDir = serverDir.replace(DATA_PATH, HOST_DATA_PATH);
  const scriptRelPath = thinScriptDataPath.replace('/data/', '');
  const scriptDir = path.dirname(scriptRelPath);
  const workDir = scriptDir === '.' ? '/data' : `/data/${scriptDir}`;

  const cfKey = getCurseForgeKey(); // clé de l'UI, sinon env
  const env = ['EULA=TRUE'];
  if (cfKey) env.push(`CF_API_KEY=${cfKey}`);

  const { docker } = dockerService;

  // Le JDK doit correspondre au loader : NeoForge 26.x (MC 26.x) exige Java 25,
  // un JDK 21 fait planter l'installeur/le serveur (UnsupportedClassVersionError).
  const javaVersion = Math.max(17, requiredJava(server.mc_version, loaderVersionFromSetupConfig(serverDir)));
  const jdkImage = `eclipse-temurin:${javaVersion}-jdk`;

  // Pull image si absente (silencieux si déjà présente)
  progress(server.id, 'thin_setup', `Vérification image ${jdkImage}...`, 31);
  await new Promise((res) => {
    docker.pull(jdkImage, (err, stream) => {
      if (err || !stream) return res();
      docker.modem.followProgress(stream, () => res(), pullProgress(server.id, 'thin_setup', 'Pull JDK', 32));
    });
  });

  const container = await docker.createContainer({
    Image: jdkImage,
    Cmd: ['bash', thinScriptDataPath],
    WorkingDir: workDir,
    Env: env,
    AttachStdout: true,
    AttachStderr: true,
    HostConfig: {
      Binds: [`${hostServerDir}:/data`],
      AutoRemove: true,
      NetworkMode: 'bridge',
    },
  });

  const logStream = await container.attach({ stream: true, stdout: true, stderr: true });
  let done = false;
  let setupContainer = container;
  const tail = []; // dernières lignes, pour un message d'erreur utile si le setup échoue
  const remember = (line) => { tail.push(line); if (tail.length > 15) tail.shift(); };

  container.modem = docker.modem;
  docker.modem.demuxStream(logStream, {
    write: (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        remember(line);
        emit(server.id, 'log', { line, timestamp: Date.now() });
        if (!done && (line.includes(']: Done (') || line.includes(': Done ('))) {
          done = true;
          progress(server.id, 'thin_setup', 'Serveur démarré — arrêt du container de setup...', 73);
          setupContainer.stop({ t: 5 }).catch(() => {});
        }
      }
    }
  }, {
    write: (chunk) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        remember(line);
        emit(server.id, 'log', { line, timestamp: Date.now() });
      }
    }
  });

  await container.start();

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      setupContainer.stop({ t: 5 }).catch(() => {});
      reject(new Error('Timeout: setup ServerStarter > 30 min'));
    }, 30 * 60 * 1000);

    container.wait((err) => {
      clearTimeout(timeout);
      if (err && !done) return reject(err);
      resolve();
    });
  });

  // Le container s'arrête aussi quand ServerStarter plante : vérifier que le loader et les mods sont bien là
  // avant de continuer, sinon on démarrerait un serveur cassé qui crashe en boucle.
  const modsDir = path.join(serverDir, 'mods');
  const jarCount = fs.existsSync(modsDir) ? fs.readdirSync(modsDir).filter(f => f.endsWith('.jar')).length : 0;
  const librariesDir = path.join(serverDir, 'libraries');
  if (!done && (jarCount === 0 || !fs.existsSync(librariesDir))) {
    throw new Error(`ServerStarter a échoué (${jarCount} mods, loader ${fs.existsSync(librariesDir) ? 'présent' : 'absent'}). `
      + `Dernières lignes :\n${tail.join('\n')}`);
  }

  const yamlSrc = path.join(serverDir, 'server-setup-config.yaml');
  if (fs.existsSync(yamlSrc)) fs.renameSync(yamlSrc, yamlSrc + '.done');
  progress(server.id, 'thin_setup_done', `Installation ServerStarter terminée — loader + ${jarCount} mods prêts`, 75);
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
      pullProgress(server.id, 'pull', 'Docker pull', 15)
    );

    // Téléchargement et installation des mods selon la source
    if (server.modpack_source === 'curseforge' && apiKey) {
      await installCurseForgeModpack(server, serverDir, modsDir, apiKey, mcVersion);
    } else {
      await installGenericModpack(server, serverDir);
    }

    const updatedServer = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);

    // Alerte RAM : un gros pack avec trop peu de mémoire = lag, GC en boucle ou crash OutOfMemory
    const advice = ramAdvice(modsDir, updatedServer.ram_mb);
    if (advice) {
      progress(server.id, 'warn', advice, 81);
      emit(server.id, 'log', { line: `[Craftarr] ${advice}`, timestamp: Date.now() }); // reste visible dans la console
    }

    progress(server.id, 'container', 'Téléchargement de l\'image Java (première fois uniquement)...', 82);
    const { containerId, containerName } = await dockerService.createServerContainer(updatedServer,
      pullProgress(server.id, 'container', 'Image Java', 82));

    progress(server.id, 'start', 'Démarrage du serveur Minecraft', 92);
    await dockerService.startContainer(containerId, updatedServer);

    db.prepare('UPDATE servers SET status = ?, container_id = ?, container_name = ? WHERE id = ?')
      .run('starting', containerId, containerName, server.id);
    progress(server.id, 'done', 'Container démarré — initialisation Minecraft en cours...', 100);
    emit(server.id, 'install:done', { status: 'starting' });

    // Flux de logs standard (statut running sur "Done", joueurs, diagnostics) — le même que pour un start normal
    if (io) startLogStream(io, server.id);
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

  // Si aucun server pack disponible, demander confirmation à l'utilisateur avant de continuer avec le client pack
  if (!serverPackFile) {
    progress(server.id, 'warn', 'Aucun server pack disponible pour cette version', 22);
    if (io) io.to(`server:${server.id}`).emit('install:no-server-pack', {
      serverId: server.id,
      modpackName: clientFile.displayName || clientFile.fileName,
    });
    // Attendre la confirmation (max 5 minutes)
    await new Promise((resolve, reject) => {
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
    progress(server.id, 'info', 'Installation avec le pack client confirmée', 24);
  }

  const targetFile = serverPackFile || clientFile;
  const isUsingServerPack = !!serverPackFile;
  console.log(`[Installer] Utilisation du ${isUsingServerPack ? 'SERVER PACK' : 'client pack'} : ${targetFile.displayName || targetFile.id}`);

  // Déduire mc_version et loader depuis le client pack (plus fiable car le server pack peut ne pas les lister)
  const loaderType = detectLoader(clientFile.gameVersions);
  const resolvedMcVersion = extractMcVer(clientFile.gameVersions) || mcVersion;

  db.prepare('UPDATE servers SET mc_version = ?, loader_type = ?, modpack_version = ?, modpack_version_id = ? WHERE id = ?')
    .run(resolvedMcVersion, loaderType,
      clientFile.displayName || clientFile.fileName,
      String(clientFile.id),
      server.id);

  // CurseForge peut retourner downloadUrl: null — fallback CDN
  const packUrl = targetFile.downloadUrl || buildCurseForgeUrl(targetFile.id, targetFile.fileName);

  progress(server.id, 'download', `Téléchargement du server pack`, 25);
  const zipPath = path.join(DATA_PATH, 'servers', server.id, 'pack.zip');

  if (isUsingServerPack) {
    await downloadFile(packUrl, zipPath, pct =>
      progress(server.id, 'download', `Server pack : ${pct}%`, 25 + Math.floor(pct * 0.1))
    );

    progress(server.id, 'extract', 'Extraction du server pack', 60);
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(serverDir, true);
    fs.unlinkSync(zipPath);

    // Vérifier si le server pack est "fat" (contient des mods) ou "thin" (structure ServerStarter sans JARs)
    const jarCount = fs.existsSync(modsDir)
      ? fs.readdirSync(modsDir).filter(f => f.endsWith('.jar')).length
      : 0;

    if (jarCount > 0) {
      progress(server.id, 'mods_done', `Server pack extrait (${jarCount} mods)`, 80);
      return;
    }

    // Thin server pack (ex: Craftoria, ATM) — on lance startserver.sh dans un container temporaire
    // pour installer NeoForge + mods. itzg démarrera ensuite normalement avec run.sh déjà créé.
    const thinScript = dockerService.detectThinPackStartScript(serverDir);
    if (thinScript) {
      await runThinPackSetup(server, serverDir, thinScript);
      // CurseForge ne liste pas toujours la version MC (schéma 26.x) → la déduire du NeoForge installé
      if (!isMcVersion(resolvedMcVersion)) {
        const mc = mcVersionFromNeoForge(loaderVersionFromSetupConfig(serverDir));
        if (mc) db.prepare('UPDATE servers SET mc_version = ? WHERE id = ?').run(mc, server.id);
      }
    }
    return;
  }

  // Pas de server pack (confirmé par l'utilisateur) : client pack uniquement
  progress(server.id, 'download', `Téléchargement du pack client`, 25);
  await downloadFile(packUrl, zipPath, pct =>
    progress(server.id, 'download', `Pack client : ${pct}%`, 25 + Math.floor(pct * 0.1))
  );
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

  // Version MC + loader exacts déclarés par le pack (ex: modLoaders[0].id = "neoforge-21.1.77")
  const primaryLoader = (manifest.minecraft?.modLoaders || []).find(l => l.primary) || manifest.minecraft?.modLoaders?.[0];
  const loaderMatch = primaryLoader?.id?.match(/^(neoforge|forge|fabric|quilt)-(.+)$/i);
  writePackMeta(serverDir, {
    mcVersion: isMcVersion(manifest.minecraft?.version) ? manifest.minecraft.version : null,
    loader: loaderMatch ? loaderMatch[1].toLowerCase() : null,
    loaderVersion: loaderMatch ? loaderMatch[2] : null,
  });

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

  if (totalMods === 0) return;

  progress(server.id, 'mods', `Résolution de ${totalMods} mods...`, 38);

  // Batch: récupérer les infos de tous les fichiers (CurseForge bulk endpoint)
  const fileIds = manifest.files.map(f => f.fileID);
  const modFiles = await fetchModFilesBulk(apiKey, fileIds);

  // Un fichier absent de la réponse API = un mod qu'on ne pourra pas installer → le serveur crasherait
  const returnedIds = new Set(modFiles.map(f => String(f.id)));
  const unresolved = fileIds.filter(id => !returnedIds.has(String(id)));
  if (unresolved.length) {
    throw new Error(`${unresolved.length} mod(s) introuvable(s) sur l'API CurseForge (fileID : ${formatFailures(unresolved)})`);
  }

  // Lire les projets à ignorer depuis server-setup-config.yaml (mods client-only listés par le modpack)
  const ignoredProjectIds = readIgnoredProjects(serverDir);
  if (ignoredProjectIds.size > 0) {
    console.log(`[Installer] ${ignoredProjectIds.size} projets client-only ignorés (server-setup-config.yaml)`);
  }

  let downloaded = 0;
  let skipped = 0;
  const failures = [];
  const CONCURRENCY = 5;

  for (let i = 0; i < modFiles.length; i += CONCURRENCY) {
    const batch = modFiles.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (file) => {
      if (!file.fileName) { failures.push(`fileID ${file.id}`); return; }

      // Ignorer les mods client-only listés dans server-setup-config.yaml
      if (file.modId && ignoredProjectIds.has(String(file.modId))) { skipped++; return; }

      // Ignorer les mods explicitement marqués "Client" uniquement par CurseForge
      if (isClientOnlyMod(file)) { skipped++; return; }

      const dest = safeJoin(modsDir, file.fileName);
      if (fs.existsSync(dest)) { downloaded++; return; }

      // CurseForge peut retourner downloadUrl: null (restrictions CDN)
      const url = file.downloadUrl || buildCurseForgeUrl(file.id, file.fileName);
      const sha1 = (file.hashes || []).find(h => h.algo === 1)?.value;
      try {
        await downloadFile(url, dest, null, sha1 ? { sha1 } : {});
        downloaded++;
      } catch (err) {
        console.warn(`[Installer] ${err.message}`);
        failures.push(file.fileName);
      }
    }));
    const pct = Math.min(100, Math.round((i + CONCURRENCY) / modFiles.length * 100));
    progress(server.id, 'mods', `Mods : ${downloaded}/${totalMods} téléchargés`, 38 + Math.floor(pct * 0.42));
  }

  console.log(`[Installer] Mods téléchargés: ${downloaded}, client-only ignorés: ${skipped}, échecs: ${failures.length}`);
  if (failures.length) {
    // Mieux vaut échouer clairement que démarrer un serveur qui crashera en boucle (mods manquants)
    throw new Error(`${failures.length} mod(s) n'ont pas pu être téléchargés : ${formatFailures(failures)}. Relancez l'installation.`);
  }
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

/**
 * Retourne true si un fichier CurseForge est client-only (ne doit pas être installé sur un serveur).
 * Critères :
 *   1. gameVersions contient "Client" mais pas "Server" (tag explicite CurseForge)
 *   2. Slug ou fileName correspond à une liste connue de mods client-only
 */
const CLIENT_ONLY_SLUGS = new Set([
  'drippyloadingscreen', 'fancymenu', 'optifine', 'betterfps-render-distance',
  'blur-fabric', 'betterf3', 'dynamic-fps', 'fps-reducer',
  'entityculling', 'smoothboot-fabric', 'replaymod',
  'itemphysic', 'controlling-for-create',
]);

function isClientOnlyMod(file) {
  // Vérification via les gameVersions de l'API CurseForge
  const versions = file.gameVersions || [];
  if (versions.includes('Client') && !versions.includes('Server')) return true;

  // Fallback sur le slug (modId string) ou le nom de fichier
  const slug = (file.slug || '').toLowerCase();
  const fileName = (file.fileName || '').toLowerCase();
  if (slug && CLIENT_ONLY_SLUGS.has(slug)) return true;
  for (const s of CLIENT_ONLY_SLUGS) {
    if (fileName.startsWith(s)) return true;
  }
  return false;
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

async function installGenericModpack(server, serverDir) {
  const db = getDb();
  const sourceRow = db.prepare('SELECT * FROM api_sources WHERE id = ?').get(server.modpack_source);
  if (!sourceRow) return;
  const apiKey = getSourceApiKey(sourceRow);

  let mcVersion = server.mc_version;
  let loaderType = server.loader_type;
  let downloadUrl = null;
  let modpackVersion = server.modpack_version;
  let modpackVersionId = server.modpack_version_id;

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
    modpackVersion = selectedVersion.versionNumber;
    modpackVersionId = selectedVersion.id;

    progress(server.id, 'download', `Téléchargement du modpack Modrinth`, 30);
    const mrpackPath = path.join(DATA_PATH, 'servers', server.id, 'modpack.mrpack');
    await downloadFile(downloadUrl, mrpackPath, pct =>
      progress(server.id, 'download', `Téléchargement : ${pct}%`, 30 + Math.floor(pct * 0.2))
    );

    progress(server.id, 'extract', 'Extraction et installation des mods serveur', 50);
    const packMeta = await installMrpack(server, mrpackPath, serverDir, apiKey);
    fs.unlinkSync(mrpackPath);
    // L'index du pack fait foi (la liste mcVersions de la version Modrinth peut en contenir plusieurs)
    if (packMeta?.mcVersion) mcVersion = packMeta.mcVersion;
    if (packMeta?.loader) loaderType = packMeta.loader;
  }

  db.prepare('UPDATE servers SET mc_version = ?, loader_type = ?, modpack_download_url = ?, modpack_version = ?, modpack_version_id = ? WHERE id = ?')
    .run(mcVersion, loaderType, downloadUrl, modpackVersion, modpackVersionId, server.id);
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

  // Version MC + loader exacts déclarés par le pack (dependencies: minecraft, fabric-loader, neoforge…)
  const deps = index.dependencies || {};
  const loaderKey = ['neoforge', 'forge', 'fabric-loader', 'quilt-loader'].find(k => deps[k]);
  const packMeta = {
    mcVersion: isMcVersion(deps.minecraft) ? deps.minecraft : null,
    loader: loaderKey ? loaderKey.replace('-loader', '') : null,
    loaderVersion: loaderKey ? deps[loaderKey] : null,
  };
  writePackMeta(serverDir, packMeta);

  // Extraire overrides/ puis server-overrides/ (le second écrase le premier, comme le fait Modrinth)
  for (const prefix of ['overrides/', 'server-overrides/']) {
    for (const entry of zip.getEntries()) {
      if (!entry.entryName.startsWith(prefix) || entry.isDirectory) continue;
      const dest = safeJoin(serverDir, entry.entryName.slice(prefix.length));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entry.getData());
    }
  }

  // Spécification Modrinth : env.server = "unsupported" → le fichier ne doit PAS être installé côté serveur
  // (mods de rendu, shaders… qui font crasher un serveur dédié). "optional" et "required" sont gardés.
  const serverFiles = (index.files || []).filter(f => f.env?.server !== 'unsupported');

  const clientOnlySkipped = (index.files?.length || 0) - serverFiles.length;
  if (clientOnlySkipped > 0) {
    console.log(`[Installer] ${clientOnlySkipped} mods client-only ignorés`);
  }
  progress(server.id, 'mods', `Téléchargement de ${serverFiles.length} mods serveur...`, 55);

  let downloaded = 0;
  const failures = [];
  const CONCURRENCY = 5;

  for (let i = 0; i < serverFiles.length; i += CONCURRENCY) {
    const batch = serverFiles.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (file) => {
      // Le chemin dans l'index est relatif à la racine du serveur (ex: "mods/mod.jar")
      const dest = safeJoin(serverDir, file.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (fs.existsSync(dest)) { downloaded++; return; }

      // Hash fourni par l'index (sha512 prioritaire) → détecte les fichiers corrompus
      const expected = file.hashes?.sha512 ? { sha512: file.hashes.sha512 }
        : file.hashes?.sha1 ? { sha1: file.hashes.sha1 } : {};

      // Essayer chaque URL de téléchargement dans l'ordre
      for (const url of file.downloads || []) {
        try {
          await downloadFile(url, dest, null, expected);
          downloaded++;
          return;
        } catch (err) {
          console.warn(`[Installer] ${err.message} (${url})`);
        }
      }
      failures.push(file.path);
    }));
    const pct = Math.min(100, Math.round((i + CONCURRENCY) / serverFiles.length * 100));
    progress(server.id, 'mods', `Mods : ${downloaded}/${serverFiles.length}`, 55 + Math.floor(pct * 0.25));
  }

  console.log(`[Installer] Modrinth mods: ${downloaded} téléchargés, ${failures.length} échoués, ${clientOnlySkipped} client-only ignorés`);
  if (failures.length) {
    throw new Error(`${failures.length} fichier(s) du modpack n'ont pas pu être téléchargés : ${formatFailures(failures)}. Relancez l'installation.`);
  }
  progress(server.id, 'mods_done', `${downloaded} mods installés`, 80);
  return packMeta;
}

async function resolveModpackMeta(server) {
  const db = getDb();
  const sourceRow = db.prepare('SELECT * FROM api_sources WHERE id = ?').get(server.modpack_source);
  const apiKey = sourceRow ? getSourceApiKey(sourceRow) : null;
  return { mcVersion: server.mc_version, loaderType: server.loader_type, apiKey };
}

const DOWNLOAD_RETRIES = 3;
const DOWNLOAD_STALL_MS = 60000;

/**
 * Télécharge url → dest de façon sûre :
 *  - écrit dans dest.part puis renomme (jamais de fichier tronqué à la place du vrai),
 *  - abandonne si aucun octet reçu pendant 60 s (stream bloqué),
 *  - vérifie la taille (content-length) et le hash si fourni ({ sha1 } ou { sha512 }),
 *  - réessaie 3 fois avec backoff.
 */
async function downloadFile(url, dest, onProgress, expected = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt++) {
    try {
      await downloadOnce(url, dest, onProgress, expected);
      return;
    } catch (err) {
      lastErr = err;
      if (err.response?.status === 404 || err.response?.status === 403) break; // inutile de réessayer
      if (attempt < DOWNLOAD_RETRIES) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  throw new Error(`Téléchargement échoué (${path.basename(dest)}) : ${lastErr?.message}`);
}

async function downloadOnce(url, dest, onProgress, expected) {
  const tmp = `${dest}.part`;
  const res = await axios.get(url, { responseType: 'stream', timeout: 120000 });
  const total = parseInt(res.headers['content-length'] || '0', 10);
  const algo = expected.sha512 ? 'sha512' : expected.sha1 ? 'sha1' : null;
  const hash = algo ? crypto.createHash(algo) : null;
  let downloaded = 0;

  try {
    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(tmp);
      let stall = setTimeout(() => res.data.destroy(new Error('téléchargement bloqué (aucune donnée depuis 60 s)')), DOWNLOAD_STALL_MS);
      res.data.on('data', chunk => {
        clearTimeout(stall);
        stall = setTimeout(() => res.data.destroy(new Error('téléchargement bloqué (aucune donnée depuis 60 s)')), DOWNLOAD_STALL_MS);
        downloaded += chunk.length;
        if (hash) hash.update(chunk);
        if (total > 0 && onProgress) onProgress(Math.round((downloaded / total) * 100));
      });
      res.data.on('end', () => clearTimeout(stall));
      res.data.on('error', err => { clearTimeout(stall); writer.destroy(); reject(err); });
      writer.on('error', err => { clearTimeout(stall); reject(err); });
      writer.on('finish', resolve);
      res.data.pipe(writer);
    });

    if (total > 0 && downloaded !== total) throw new Error(`taille incorrecte (${downloaded}/${total} octets)`);
    if (hash) {
      const digest = hash.digest('hex');
      if (digest.toLowerCase() !== String(expected[algo]).toLowerCase()) throw new Error(`hash ${algo} invalide`);
    }
    fs.renameSync(tmp, dest);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

/** Joint un chemin d'archive à baseDir en refusant toute sortie du dossier (zip-slip). */
function safeJoin(baseDir, relative) {
  const dest = path.resolve(baseDir, relative);
  const base = path.resolve(baseDir);
  if (dest !== base && !dest.startsWith(base + path.sep)) {
    throw new Error(`Chemin d'archive refusé (sort du dossier serveur) : ${relative}`);
  }
  return dest;
}

/**
 * Métadonnées du pack (version MC + loader exact) écrites dans serverDir/.craftarr-pack.json.
 * Lues par docker.js pour épingler la version du loader (FORGE_VERSION, FABRIC_LOADER_VERSION…)
 * au lieu de laisser itzg prendre la dernière — cause classique de crash au démarrage.
 */
function writePackMeta(serverDir, meta) {
  try {
    fs.writeFileSync(path.join(serverDir, '.craftarr-pack.json'), JSON.stringify(meta, null, 2));
  } catch (err) {
    console.warn('[Installer] Impossible d\'écrire .craftarr-pack.json :', err.message);
  }
}

/**
 * RAM conseillée selon le nombre de mods (ordre de grandeur usuel des modpacks) :
 * < 50 mods → 4 Go, < 150 → 6 Go, < 250 → 8 Go, au-delà → 10 Go.
 * Retourne un message d'avertissement si le serveur en a moins, sinon null.
 */
function ramAdvice(modsDir, ramMb) {
  let mods = 0;
  try { mods = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar')).length; } catch {}
  const recommendedGb = mods < 50 ? 4 : mods < 150 ? 6 : mods < 250 ? 8 : 10;
  if (!ramMb || ramMb >= recommendedGb * 1024) return null;
  return `⚠ ${mods} mods pour ${Math.round(ramMb / 1024 * 10) / 10} Go de RAM : ${recommendedGb} Go recommandés `
    + '(Paramètres du serveur → RAM, puis recréer le container). Risque de lag ou de crash.';
}

/** Formate une liste d'échecs pour un message d'erreur lisible. */
function formatFailures(failures) {
  const shown = failures.slice(0, 10).join(', ');
  return failures.length > 10 ? `${shown} … (+${failures.length - 10})` : shown;
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
  // Minecraft : 1.x.y ou schéma annuel 26.x.y (voir mcVersion.js).
  // Ignore les versions Forge (47.2.0) et les tags de loader ("NeoForge", "Server"…).
  return versions.find(isMcVersion) || null;
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

/**
 * Installe un modpack à partir de zéro dans serverDir (wipe complet puis réinstallation fraîche).
 * N'écrit pas les données monde/joueur — elles sont gérées par l'appelant (applyUpdate).
 * Ne crée pas de container Docker.
 */
async function freshInstallModpack(server, serverDir) {
  const db = getDb();
  const sourceRow = db.prepare('SELECT * FROM api_sources WHERE id = ?').get(server.modpack_source);
  if (!sourceRow) throw new Error('Source introuvable: ' + server.modpack_source);
  const apiKey = getSourceApiKey(sourceRow);

  // Wipe complet du répertoire serveur (mods, configs, ServerFiles-*, libraries, markers)
  if (fs.existsSync(serverDir)) fs.rmSync(serverDir, { recursive: true });
  fs.mkdirSync(serverDir, { recursive: true });
  const modsDir = path.join(serverDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });

  if (server.modpack_source === 'curseforge') {
    if (!apiKey) throw new Error('Clé API CurseForge manquante');
    await installCurseForgeModpack(server, serverDir, modsDir, apiKey, server.mc_version);
  } else if (server.modpack_source === 'modrinth') {
    const versions = await modrinth.getVersions(apiKey, server.modpack_id);
    let selectedVersion = versions[0];
    if (server.modpack_version_id) {
      selectedVersion = versions.find(v => v.id === server.modpack_version_id) || versions[0];
    }
    if (!selectedVersion) throw new Error('Version Modrinth introuvable');
    const primaryFile = selectedVersion.files.find(f => f.primary) || selectedVersion.files[0];
    if (!primaryFile?.url) throw new Error('Aucun fichier .mrpack trouvé');
    const mrpackPath = path.join(DATA_PATH, 'servers', server.id, 'update.mrpack');
    await downloadFile(primaryFile.url, mrpackPath);
    await installMrpack(server, mrpackPath, serverDir, apiKey);
    fs.unlinkSync(mrpackPath);
  } else {
    throw new Error('Source non supportée: ' + server.modpack_source);
  }
}

/** @deprecated Use freshInstallModpack via applyUpdate instead */
async function updateModpackMods(server) {
  const serverDir = path.join(DATA_PATH, 'servers', server.id, 'server');
  await freshInstallModpack(server, serverDir);
}

module.exports = { installServer, installModsOnly, updateModpackMods, freshInstallModpack, confirmClientPack, cancelClientPack, setIo };
