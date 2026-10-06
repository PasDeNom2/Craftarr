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
const cfExcludes = require('./cfExcludes');
const serverLock = require('./serverLock');
const { readModInfo, analyze: analyzeMods, unmetRequirements, describeProblems, listJars } = require('./modJar');
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
  const release = serverLock.acquire(server.id, 'installation');
  try {
    return await doInstallServer(server);
  } finally {
    release();
  }
}

async function doInstallServer(server) {
  const db = getDb();
  const serverDir = path.join(DATA_PATH, 'servers', server.id, 'server');
  const modsDir = path.join(serverDir, 'mods');
  fs.mkdirSync(serverDir, { recursive: true });
  fs.mkdirSync(modsDir, { recursive: true });

  try {
    progress(server.id, 'prepare', 'Préparation du répertoire serveur', 5);

    const { mcVersion, loaderType, apiKey } = await resolveModpackMeta(server);

    // L'image itzg utilisée est la variante javaXX choisie à la création du container :
    // plus de pull de :latest ici (des centaines de Mo téléchargés pour rien à chaque installation).

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

    // RAM réglée au-delà de ce que la machine peut fournir : swap → lag permanent
    const hostWarn = await dockerService.hostRamWarning(updatedServer.ram_mb);
    if (hostWarn) {
      progress(server.id, 'warn', `⚠ ${hostWarn}`, 81);
      emit(server.id, 'log', { line: `[Craftarr] ⚠ ${hostWarn}`, timestamp: Date.now() });
    }

    // Pré-génération demandée : Chunky adapté au loader et à la version, installé avant le 1er démarrage
    if (updatedServer.pregen_enabled) {
      progress(server.id, 'pregen', 'Installation de Chunky (pré-génération du monde)', 81);
      try {
        await require('./pregen').ensureChunky(updatedServer);
        db.prepare("UPDATE servers SET pregen_status = 'pending' WHERE id = ?").run(server.id);
      } catch (err) {
        db.prepare("UPDATE servers SET pregen_status = 'error', pregen_message = ? WHERE id = ?").run(err.message, server.id);
        emit(server.id, 'log', { line: `[Craftarr] ⚠ Pré-génération indisponible : ${err.message}`, timestamp: Date.now() });
      }
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
async function installCurseForgeModpack(server, serverDir, modsDir, apiKey, mcVersion) {
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

/** Loader déclaré par le pack (.craftarr-pack.json), ou null. */
function packLoader(serverDir) {
  try { return JSON.parse(fs.readFileSync(path.join(serverDir, '.craftarr-pack.json'), 'utf8')).loader || null; } catch { return null; }
}

/**
 * Vérifie le dossier mods/ avant le premier démarrage (dépendances manquantes, doublons,
 * incompatibilités déclarées) et l'affiche dans la console. Jamais bloquant : l'analyse
 * des métadonnées n'est pas infaillible, mais elle évite de chercher dans une stacktrace.
 */
function reportModProblems(server, serverDir) {
  try {
    const prefer = packLoader(serverDir) || server.loader_type || null;
    const lines = describeProblems(analyzeMods(listJars(path.join(serverDir, 'mods')), f => readModInfo(f, { prefer })));
    if (!lines.length) return;
    progress(server.id, 'warn', `${lines.length} problème(s) potentiel(s) détecté(s) dans les mods — voir la console`, 80);
    for (const l of lines.slice(0, 30)) emit(server.id, 'log', { line: `[Craftarr] ⚠ ${l}`, timestamp: Date.now() });
    if (lines.length > 30) emit(server.id, 'log', { line: `[Craftarr] ⚠ … et ${lines.length - 30} autre(s)`, timestamp: Date.now() });
    console.warn(`[Installer][${server.id.slice(0, 8)}] ${lines.length} problème(s) de mods :\n  ${lines.join('\n  ')}`);
  } catch (err) {
    console.warn('[Installer] Analyse des mods impossible :', err.message);
  }
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


async function installGenericModpack(server, serverDir) {
  if (server.modpack_source !== 'modrinth') return;
  const db = getDb();
  const sourceRow = db.prepare('SELECT * FROM api_sources WHERE id = ?').get(server.modpack_source);
  if (!sourceRow) return;
  await installModrinthModpack(server, serverDir, getSourceApiKey(sourceRow));
}

/**
 * Télécharge et installe la version Modrinth choisie (ou la plus récente), puis enregistre
 * en base la version MC / le loader réellement installés (lus dans l'index du pack).
 */
async function installModrinthModpack(server, serverDir, apiKey) {
  const db = getDb();
  let selectedVersion;
  if (server.modpack_version_id) {
    // Par id : jamais de repli silencieux sur une autre version que celle choisie
    try {
      selectedVersion = await modrinth.getVersion(apiKey, server.modpack_version_id);
    } catch (err) {
      throw new Error(`Version Modrinth ${server.modpack_version_id} introuvable (${err.response?.status || err.message})`);
    }
  } else {
    selectedVersion = (await modrinth.getVersions(apiKey, server.modpack_id))[0];
  }
  if (!selectedVersion) throw new Error('Aucune version Modrinth trouvée pour ' + server.modpack_id);

  const primaryFile = selectedVersion.files.find(f => f.primary) || selectedVersion.files[0];
  if (!primaryFile?.url) throw new Error('Aucun fichier .mrpack trouvé pour la version ' + selectedVersion.id);

  progress(server.id, 'download', 'Téléchargement du modpack Modrinth', 30);
  const mrpackPath = path.join(DATA_PATH, 'servers', server.id, 'modpack.mrpack');
  await downloadFile(primaryFile.url, mrpackPath, pct =>
    progress(server.id, 'download', `Téléchargement : ${pct}%`, 30 + Math.floor(pct * 0.2))
  );

  progress(server.id, 'extract', 'Extraction et installation des mods serveur', 50);
  const packMeta = await installMrpack(server, mrpackPath, serverDir, apiKey);
  fs.unlinkSync(mrpackPath);
  reportModProblems(server, serverDir);

  // L'index du pack fait foi (la liste mcVersions de la version Modrinth peut en contenir plusieurs)
  const mcVersion = packMeta?.mcVersion || selectedVersion.mcVersions?.find(isMcVersion) || server.mc_version;
  const loaderType = packMeta?.loader || selectedVersion.loaders?.[0] || server.loader_type;
  db.prepare('UPDATE servers SET mc_version = ?, loader_type = ?, modpack_download_url = ?, modpack_version = ?, modpack_version_id = ? WHERE id = ?')
    .run(mcVersion, loaderType, primaryFile.url, selectedVersion.versionNumber, selectedVersion.id, server.id);
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

/** Essaie chaque URL dans l'ordre (API puis CDN de secours) ; échoue avec la dernière erreur. */
async function downloadAny(urls, dest, onProgress, expected = {}) {
  let lastErr = new Error('aucune URL de téléchargement');
  for (const url of urls) {
    try {
      await downloadFile(url, dest, onProgress, expected);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
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
  return serverLock.withLock(server.id, 'téléchargement des mods', () => doInstallModsOnly(server, serverDir, modsDir));
}

async function doInstallModsOnly(server, serverDir, modsDir) {
  const db = getDb();
  const sourceRow = db.prepare('SELECT * FROM api_sources WHERE id = ?').get(server.modpack_source);
  if (!sourceRow) throw new Error('Source introuvable: ' + server.modpack_source);
  const apiKey = getSourceApiKey(sourceRow);
  if (!apiKey && server.modpack_source === 'curseforge') throw new Error('Clé API manquante pour ' + server.modpack_source);

  if (server.modpack_source === 'curseforge') {
    await installCurseForgeModpack(server, serverDir, modsDir, apiKey, server.mc_version);
  } else if (server.modpack_source === 'modrinth') {
    await installModrinthModpack(server, serverDir, apiKey);
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
    await installModrinthModpack(server, serverDir, apiKey);
  } else {
    throw new Error('Source non supportée: ' + server.modpack_source);
  }
}

/**
 * Avant une réinstallation (serveur en erreur) : vide le dossier serveur en gardant le monde
 * et les fichiers de l'utilisateur. Sinon les mods/loader d'une tentative précédente restaient
 * à côté des nouveaux → mods en double, mauvaise version du loader.
 */
function cleanForReinstall(serverDir) {
  if (!fs.existsSync(serverDir)) return;
  const backupService = require('./backup');
  const keep = new Set([
    ...backupService.getWorldDirs(serverDir),
    'server.properties', 'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json', 'usercache.json',
  ]);
  for (const name of fs.readdirSync(serverDir)) {
    if (!keep.has(name)) fs.rmSync(path.join(serverDir, name), { recursive: true, force: true });
  }
}

module.exports = {
  installServer, installModsOnly, cleanForReinstall, freshInstallModpack, confirmClientPack, cancelClientPack, setIo,
  // Exposé pour les tests uniquement
  _internals: {
    downloadFile, downloadAny, safeJoin, installMrpack, ramAdvice, manifestMeta, clientOnlyReason,
    hoistNestedServerPack, restoreRequiredClientMods, downloadModsFromClientPack, cleanForReinstall,
  },
};
