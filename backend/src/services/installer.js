const path = require('path');
const fs = require('fs');
const { getDb } = require('../config/database');
const dockerService = require('./docker');
const { getSourceApiKey, getCurseForgeKey } = require('./sourceAggregator');
const serverLock = require('./serverLock');
const { startLogStream } = require('../websocket/logs');
const { requiredJava, loaderVersionFromSetupConfig } = require('./mcVersion');
const { setIo, getIo, emit, progress, pullProgress } = require('./installer/progress');
const { downloadFile, downloadAny, safeJoin } = require('./installer/download');
const { ramAdvice, cleanForReinstall } = require('./installer/utils');
const {
  installCurseForgeModpack, confirmClientPack, cancelClientPack, manifestMeta, clientOnlyReason,
  hoistNestedServerPack, restoreRequiredClientMods, downloadModsFromClientPack,
} = require('./installer/curseforge');
const { installModrinthModpack, installMrpack } = require('./installer/modrinth');

const DATA_PATH = process.env.DATA_PATH || '/data';
const HOST_DATA_PATH = process.env.HOST_DATA_PATH || DATA_PATH;

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
  const { PLUGIN_LOADERS } = require('./modrinthInstall');
  const isPluginServer = PLUGIN_LOADERS.has((server.loader_type || '').toLowerCase());
  const modsDir = path.join(serverDir, isPluginServer ? 'plugins' : 'mods');
  fs.mkdirSync(serverDir, { recursive: true });
  fs.mkdirSync(modsDir, { recursive: true });

  try {
    progress(server.id, 'prepare', 'Préparation du répertoire serveur', 5);

    const { mcVersion, loaderType, apiKey } = await resolveModpackMeta(server);

    // L'image itzg utilisée est la variante javaXX choisie à la création du container :
    // plus de pull de :latest ici (des centaines de Mo téléchargés pour rien à chaque installation).

    // Téléchargement et installation des mods selon la source
    if (server.modpack_source === 'curseforge' && apiKey) {
      await installCurseForgeModpack(server, serverDir, modsDir, apiKey, mcVersion, runThinPackSetup);
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
    const io = getIo();
    if (io) startLogStream(io, server.id);
  } catch (err) {
    db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('error', server.id);
    emit(server.id, 'install:error', { message: err.message });
    throw err;
  }
}

async function installGenericModpack(server, serverDir) {
  if (server.modpack_source !== 'modrinth') return;
  const db = getDb();
  const sourceRow = db.prepare('SELECT * FROM api_sources WHERE id = ?').get(server.modpack_source);
  if (!sourceRow) return;
  await installModrinthModpack(server, serverDir, getSourceApiKey(sourceRow));
}

async function resolveModpackMeta(server) {
  const db = getDb();
  const sourceRow = db.prepare('SELECT * FROM api_sources WHERE id = ?').get(server.modpack_source);
  const apiKey = sourceRow ? getSourceApiKey(sourceRow) : null;
  return { mcVersion: server.mc_version, loaderType: server.loader_type, apiKey };
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
    await installCurseForgeModpack(server, serverDir, modsDir, apiKey, server.mc_version, runThinPackSetup);
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
    await installCurseForgeModpack(server, serverDir, modsDir, apiKey, server.mc_version, runThinPackSetup);
  } else if (server.modpack_source === 'modrinth') {
    await installModrinthModpack(server, serverDir, apiKey);
  } else {
    throw new Error('Source non supportée: ' + server.modpack_source);
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
