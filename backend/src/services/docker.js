const Docker = require('dockerode');
const path = require('path');
const fs = require('fs');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const DATA_PATH = process.env.DATA_PATH || '/data';
// HOST_DATA_PATH = chemin hôte correspondant à DATA_PATH, utilisé pour les bind mounts des containers MC
// (Docker daemon interprète les chemins de bind mounts depuis le point de vue de l'hôte)
const HOST_DATA_PATH = process.env.HOST_DATA_PATH || DATA_PATH;
const MC_NETWORK = 'craftarr';

async function ensureNetwork() {
  const networks = await docker.listNetworks({ filters: { name: [MC_NETWORK] } });
  if (!networks.find(n => n.Name === MC_NETWORK)) {
    await docker.createNetwork({ Name: MC_NETWORK, Driver: 'bridge' });
    console.log(`[Docker] Réseau ${MC_NETWORK} créé`);
  }
}

/**
 * Extrait la version Minecraft depuis server-setup-config.yaml (ServerStarter).
 * Source de vérité fiable — évite d'utiliser une mc_version erronée stockée en DB.
 * Supporte plusieurs formats YAML rencontrés dans les server packs modernes.
 */
function extractMcVersionFromSetupConfig(setupConfigPath) {
  try {
    const content = fs.readFileSync(setupConfigPath, 'utf8');
    const isMcVer = v => /^1\.\d{1,2}(\.\d)?$/.test(v);

    // Format 1 : mcVersion: "1.21.1"  (ServerStarter classique)
    const m1 = content.match(/mcVersion:\s*["']?(1\.\d[\d.]{0,8})["']?/i);
    if (m1 && isMcVer(m1[1])) return m1[1];

    // Format 2 :  minecraft:\n    version: "1.21.1"
    const m2 = content.match(/^minecraft:\s*\n\s+version:\s*["']?(1\.\d[\d.]{0,8})["']?/im);
    if (m2 && isMcVer(m2[1])) return m2[1];

    // Format 3 : version: "1.21.1"  (uniquement si valeur correspond à MC)
    for (const m of content.matchAll(/^\s*version:\s*["']?(1\.\d[\d.]{0,8})["']?/gm)) {
      if (isMcVer(m[1])) return m[1];
    }
  } catch {}
  return null;
}

/**
 * Extrait la version NeoForge depuis startserver.sh / startserver.bat fournis par le server pack.
 * ATM11 et d'autres packs modernes définissent NEOFORGE_VERSION=26.1.2.12-beta dans ce script.
 * Retourne la version (ex: "26.1.2.12-beta") ou null.
 */
function detectNeoForgeVersionFromStartScript(serverDir) {
  const scripts = ['startserver.sh', 'startserver.bat', 'start.sh', 'start.bat'];
  // Cherche dans le répertoire racine et un sous-dossier (ATM11 place les fichiers dans ServerFiles-x.y.z/)
  const dirsToSearch = [serverDir];
  try {
    for (const entry of fs.readdirSync(serverDir, { withFileTypes: true })) {
      if (entry.isDirectory()) dirsToSearch.push(path.join(serverDir, entry.name));
    }
  } catch {}

  const found = [];
  for (const dir of dirsToSearch) {
    for (const script of scripts) {
      try {
        const content = fs.readFileSync(path.join(dir, script), 'utf8');
        const m = content.match(/NEOFORGE_VERSION\s*=\s*["']?([0-9][^\s"']+)["']?/);
        if (m) found.push(m[1].trim());
      } catch {}
    }
  }
  if (!found.length) return null;
  // Pick highest version (semver-like numeric sort, handles "26.1.2.12-beta" style)
  found.sort((a, b) => {
    const nums = v => v.replace(/-.*$/, '').split('.').map(n => parseInt(n, 10) || 0);
    const av = nums(a), bv = nums(b);
    for (let i = 0; i < Math.max(av.length, bv.length); i++) {
      const diff = (av[i] || 0) - (bv[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });
  return found[found.length - 1];
}

/**
 * Détecte la version NeoForge déjà installée dans libraries/net/neoforged/neoforge/.
 * Utilisé après un setup thin pack (ServerStarter) pour passer la version exacte à itzg
 * et éviter une réinstallation inutile du loader.
 */
function detectInstalledNeoForgeVersion(serverDir) {
  try {
    const nfDir = path.join(serverDir, 'libraries', 'net', 'neoforged', 'neoforge');
    if (!fs.existsSync(nfDir)) return null;
    const versions = fs.readdirSync(nfDir).filter(v => {
      return fs.statSync(path.join(nfDir, v)).isDirectory();
    });
    if (!versions.length) return null;
    versions.sort((a, b) => {
      const an = a.replace(/-.*/, '').split('.').map(Number);
      const bn = b.replace(/-.*/, '').split('.').map(Number);
      for (let i = 0; i < Math.max(an.length, bn.length); i++) {
        const d = (an[i] || 0) - (bn[i] || 0);
        if (d !== 0) return d;
      }
      return 0;
    });
    return versions[versions.length - 1];
  } catch { return null; }
}

/**
 * Détecte le JAR d'installation NeoForge bundlé dans le server pack.
 * ATM11 et d'autres packs incluent leur propre installer (ex: neoforge-26.1.2.10-beta-installer.jar).
 * Retourne le chemin absolu du JAR dans DATA_PATH (pour le bind-mount /data) ou null.
 */
function detectNeoForgeInstallerFromPack(serverDir) {
  try {
    const scan = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const found = scan(path.join(dir, entry.name));
          if (found) return found;
        } else if (/^neoforge-.+-installer\.jar$/.test(entry.name)) {
          return path.join(dir, entry.name);
        }
      }
      return null;
    };
    return scan(serverDir);
  } catch {
    return null;
  }
}

/**
 * Détecte un thin server pack (ServerStarter) à deux endroits :
 *  1. server-setup-config.yaml à la racine + startserver.sh → Craftoria / packs modernes
 *  2. ServerFiles-*\/startserver.sh → ATM et packs plus anciens
 * Retourne le chemin /data-relatif du startserver.sh, ou null si ce n'est pas un thin pack.
 */
function detectThinPackStartScript(serverDir) {
  try {
    // Cas 1 : startserver.sh ET server-setup-config.yaml à la racine
    const rootSh = path.join(serverDir, 'startserver.sh');
    const rootCfg = path.join(serverDir, 'server-setup-config.yaml');
    if (fs.existsSync(rootSh) && fs.existsSync(rootCfg)) {
      return '/data/startserver.sh';
    }

    // Cas 2 : ServerFiles-*/startserver.sh (ATM, etc.) — prendre le dossier le plus récent
    let latest = null;
    for (const entry of fs.readdirSync(serverDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('ServerFiles-')) continue;
      const sh = path.join(serverDir, entry.name, 'startserver.sh');
      if (fs.existsSync(sh)) {
        if (!latest || entry.name > latest.name) latest = entry;
      }
    }
    if (latest) return `/data/${latest.name}/startserver.sh`;

    return null;
  } catch {
    return null;
  }
}

function buildEnvVars(server) {
  const serverDir = path.join(DATA_PATH, 'servers', server.id, 'server');

  // Détecte server-setup-config.yaml en premier — ServerStarter gère tout (NeoForge inclus)
  const setupConfigPath = path.join(serverDir, 'server-setup-config.yaml');
  const hasSetupConfig = fs.existsSync(setupConfigPath);

  // Si NeoForge est déjà installé (thin pack setup via ServerStarter), utiliser cette version
  // pour éviter qu'itzg réinstalle un loader différent.
  const runShExists = fs.existsSync(path.join(serverDir, 'run.sh'));
  const installedNeoForgeVersion = (server.loader_type === 'neoforge' && runShExists)
    ? detectInstalledNeoForgeVersion(serverDir)
    : null;

  // Détecte la version NeoForge depuis startserver.sh/bat (ATM11 et packs similaires)
  const neoForgeVersionFromScript = (!installedNeoForgeVersion && server.loader_type === 'neoforge')
    ? detectNeoForgeVersionFromStartScript(serverDir)
    : null;

  // Détecte si un JAR d'installation NeoForge est bundlé dans le server pack
  const neoForgeInstallerPath = server.loader_type === 'neoforge'
    ? detectNeoForgeInstallerFromPack(serverDir)
    : null;
  // Converti le chemin absolu (DATA_PATH) en chemin /data vu depuis le container MC
  const neoForgeInstallerInContainer = neoForgeInstallerPath
    ? neoForgeInstallerPath.replace(serverDir, '/data')
    : null;

  const loaderType = server.loader_type?.toLowerCase() || 'forge';

  const env = [
    'EULA=TRUE',
    `TYPE=${loaderType === 'vanilla' ? 'VANILLA' : loaderType.toUpperCase()}`,
    `MAX_MEMORY=${server.ram_mb}M`,
    `INIT_MEMORY=${Math.min(1024, Math.floor(server.ram_mb / 2))}M`,
    `MAX_PLAYERS=${server.max_players}`,
    `ONLINE_MODE=${server.online_mode !== 0 ? 'TRUE' : 'FALSE'}`,
    `ENABLE_RCON=true`,
    `RCON_PORT=25575`,
    `RCON_PASSWORD=${server.rcon_password}`,
    `MOTD=${server.motd || `${server.name} — Powered by Craftarr`}`,
  ];

  if (installedNeoForgeVersion) {
    // NeoForge déjà installé par ServerStarter — passer la version exacte pour qu'itzg ne réinstalle pas
    console.log(`[Docker] NeoForge déjà installé (libraries/) : ${installedNeoForgeVersion}`);
    env.push(`NEOFORGE_VERSION=${installedNeoForgeVersion}`);
    if (server.mc_version && /^1\.\d{1,2}(\.\d)?$/.test(server.mc_version)) {
      env.push(`VERSION=${server.mc_version}`);
    }
  } else if (neoForgeVersionFromScript) {
    // Le server pack fournit son propre startserver.sh avec la version NeoForge exacte
    // (ex: ATM11 → NEOFORGE_VERSION=26.1.2.12-beta)
    console.log(`[Docker] NeoForge version (startserver script) : ${neoForgeVersionFromScript}`);
    env.push(`NEOFORGE_VERSION=${neoForgeVersionFromScript}`);
    // Dériver la version MC depuis la version NeoForge pour que itzg sélectionne la bonne image Java
    // Schéma : 21.x.y = MC 1.21.x  |  26.1.x.y (nouveau schéma) = MC 1.21.1
    const nfParts = neoForgeVersionFromScript.replace(/-.*/, '').split('.').map(Number);
    let derivedMc = null;
    if (nfParts[0] === 21 && nfParts.length >= 2) {
      // Ancien schéma : 21.1.226 → MC 1.21.1
      derivedMc = `1.${nfParts[0]}.${nfParts[1]}`;
    } else if (nfParts[0] >= 20 && nfParts[0] <= 25 && nfParts.length >= 2) {
      // 20.x.y → MC 1.20.x  /  21.x.y → MC 1.21.x
      derivedMc = `1.${nfParts[0]}.${nfParts[1]}`;
    } else if (nfParts[0] === 26 && nfParts.length >= 2) {
      // Nouveau schéma : 26.1.x.y → MC 1.21.1  (26 = NeoForge pour 1.21.x série)
      derivedMc = `1.21.${nfParts[1]}`;
    }
    if (derivedMc && /^1\.\d{1,2}(\.\d)?$/.test(derivedMc)) {
      console.log(`[Docker] MC version déduite de NeoForge ${neoForgeVersionFromScript} : ${derivedMc}`);
      env.push(`VERSION=${derivedMc}`);
    }
  } else if (neoForgeInstallerInContainer) {
    // Utilise le JAR d'installation bundlé par le server pack
    console.log(`[Docker] NeoForge installer bundlé : ${neoForgeInstallerInContainer}`);
    env.push(`NEOFORGE_INSTALLER=${neoForgeInstallerInContainer}`);
    // Ne pas passer VERSION — le jar bundlé installe la bonne version
  } else if (hasSetupConfig) {
    // Extraire la version MC depuis server-setup-config.yaml pour que itzg installe le bon NeoForge
    const mcFromConfig = extractMcVersionFromSetupConfig(setupConfigPath);
    if (mcFromConfig) {
      console.log(`[Docker] MC version (server-setup-config.yaml) : ${mcFromConfig}`);
      env.push(`VERSION=${mcFromConfig}`);
    } else if (server.mc_version && /^1\.\d{1,2}(\.\d)?$/.test(server.mc_version)) {
      env.push(`VERSION=${server.mc_version}`);
    }
  } else if (server.mc_version && /^1\.\d{1,2}(\.\d)?$/.test(server.mc_version)) {
    // VERSION uniquement si c'est une vraie version Minecraft (ex: 1.21.1, 1.20.1)
    // Jamais les versions NeoForge/Forge (ex: 26.1.2, 47.2.0) qui cassent mc-image-helper
    env.push(`VERSION=${server.mc_version}`);
  }

  if (server.seed) env.push(`SEED=${server.seed}`);
  if (server.whitelist_enabled) env.push('WHITELIST=true');
  env.push(`DIFFICULTY=${server.difficulty || 'normal'}`);
  env.push(`VIEW_DISTANCE=${server.view_distance || 10}`);
  env.push(`SPAWN_PROTECTION=${server.spawn_protection ?? 16}`);
  // CurseForge API key pour ServerStarter et mc-image-helper
  const cfKey = process.env.CURSEFORGE_API_KEY;
  if (cfKey) env.push(`CF_API_KEY=${cfKey}`);

  // server-setup-config.yaml → ServerStarter (NE PAS combiner avec MODPACK)
  if (hasSetupConfig) {
    env.push('SERVER_SETUP_CONFIG=/data/server-setup-config.yaml');
  } else if (server.modpack_download_url) {
    env.push(`MODPACK=${server.modpack_download_url}`);
  }

  return env;
}

/**
 * Choisit le bon tag d'image itzg/minecraft-server selon la version MC et NeoForge.
 *
 * Java requis par version Minecraft :
 *  < 1.17          → Java 8   (Forge legacy, LaunchwWrapper, etc.)
 *  1.17            → Java 16
 *  1.18 – 1.20.4   → Java 17
 *  1.20.5 – 1.21.x → Java 21
 *
 * Java requis par version NeoForge (nouveau schéma 26.x) :
 *  NeoForge 26.x.y  → Java 25  (class file 69.0, ex: ATM11 avec 26.1.2.12-beta)
 *
 * Utiliser la mauvaise version Java provoque ClassCastException ou UnsupportedClassVersionError.
 */
function resolveMinecraftImage(mcVersion, neoforgeVersion) {
  // NeoForge nouveau schéma (26.x.y) nécessite Java 25 (class file version 69)
  if (neoforgeVersion) {
    const nfMajor = parseInt(neoforgeVersion.split('.')[0], 10);
    if (nfMajor >= 26) return 'itzg/minecraft-server:java25';
  }

  if (!mcVersion) return 'itzg/minecraft-server:java21'; // safe default

  // Extraire les deux premiers segments : "1.12.2" → [1, 12]
  const parts = mcVersion.replace(/[^0-9.]/g, '').split('.').map(Number);
  const major = parts[0] ?? 1;
  const minor = parts[1] ?? 0;

  if (major === 1) {
    if (minor < 17) return 'itzg/minecraft-server:java8';
    if (minor === 17) return 'itzg/minecraft-server:java16';
    if (minor <= 20) {
      const patch = parts[2] ?? 0;
      if (minor === 20 && patch >= 5) return 'itzg/minecraft-server:java21';
      return 'itzg/minecraft-server:java17';
    }
    return 'itzg/minecraft-server:java21';
  }

  return 'itzg/minecraft-server:java21';
}

/**
 * Vérifie que l'image Docker est disponible localement.
 * Si elle est absente, la télécharge depuis Docker Hub avec progression dans les logs.
 */
async function ensureImage(imageName, onProgress) {
  const images = await docker.listImages({ filters: { reference: [imageName] } });
  if (images.length > 0) {
    console.log(`[Docker] Image ${imageName} déjà présente localement`);
    return;
  }
  console.log(`[Docker] Image ${imageName} absente — téléchargement en cours...`);
  await pullImage(imageName, onProgress);
  console.log(`[Docker] Image ${imageName} téléchargée avec succès`);
}

/**
 * Supprime les marqueurs d'installation itzg pour forcer la réinstallation du loader.
 * Nécessaire quand le conteneur est recréé avec une version différente :
 * itzg détecte "already installed" et réutilise l'ancienne version sinon.
 */
function clearLoaderInstallMarkers(serverDir) {
  const markers = [
    '.neoforge-manifest.json',
    '.forge-manifest.json',
    '.fabric-manifest.json',
    '.quilt-manifest.json',
    '.paper-manifest.json',
    '.run-neoforge.env',
    '.run-forge.env',
    '.install-fabric.env',
  ];
  for (const m of markers) {
    try {
      const p = path.join(serverDir, m);
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        console.log(`[Docker] Marqueur supprimé : ${m}`);
      }
    } catch {}
  }
}

async function createServerContainer(server, onProgress) {
  await ensureNetwork();

  const serverDir = path.join(DATA_PATH, 'servers', server.id, 'server');
  // Pour le bind mount, on utilise HOST_DATA_PATH (chemin hôte) car Docker daemon
  // interprète les chemins depuis l'hôte, pas depuis l'intérieur du backend container
  const hostServerDir = path.join(HOST_DATA_PATH, 'servers', server.id, 'server');
  const containerName = `mc-${server.id.slice(0, 8)}`;

  // Supprime les marqueurs d'installation pour forcer itzg à réinstaller le bon loader
  clearLoaderInstallMarkers(serverDir);

  // Détecter la version NeoForge depuis startserver.sh pour choisir la bonne image Java
  const neoforgeVersionFromScript = server.loader_type === 'neoforge'
    ? detectNeoForgeVersionFromStartScript(serverDir)
    : null;

  const image = resolveMinecraftImage(server.mc_version, neoforgeVersionFromScript);
  console.log(`[Docker] Image sélectionnée pour MC ${server.mc_version || '?'}${neoforgeVersionFromScript ? ` / NeoForge ${neoforgeVersionFromScript}` : ''} : ${image}`);
  await ensureImage(image, onProgress);

  const container = await docker.createContainer({
    name: containerName,
    Image: image,
    Env: buildEnvVars(server),
    ExposedPorts: {
      '25565/tcp': {},
      '25575/tcp': {},
    },
    HostConfig: {
      Binds: [`${hostServerDir}:/data`],
      PortBindings: {
        '25565/tcp': [{ HostPort: String(server.port) }],
        '25575/tcp': [{ HostPort: String(server.rcon_port) }],
      },
      RestartPolicy: { Name: 'unless-stopped' },
      Memory: server.ram_mb * 1024 * 1024 * 2,
    },
    NetworkingConfig: {
      EndpointsConfig: { [MC_NETWORK]: {} },
    },
  });

  return { containerId: container.id, containerName };
}

async function startContainer(containerId) {
  const container = docker.getContainer(containerId);
  await container.start();
}

async function stopContainer(containerId, timeout = 30) {
  const container = docker.getContainer(containerId);
  await container.stop({ t: timeout });
}

async function restartContainer(containerId) {
  const container = docker.getContainer(containerId);
  await container.restart({ t: 30 });
}

async function removeContainer(containerId) {
  const container = docker.getContainer(containerId);
  try { await container.stop({ t: 10 }); } catch {}
  await container.remove({ force: true });
}

async function getContainerStats(containerId) {
  const container = docker.getContainer(containerId);
  return new Promise((resolve, reject) => {
    container.stats({ stream: false }, (err, data) => {
      if (err) return reject(err);
      if (!data) return resolve(null);

      const cpuDelta = data.cpu_stats.cpu_usage.total_usage - data.precpu_stats.cpu_usage.total_usage;
      const systemDelta = data.cpu_stats.system_cpu_usage - data.precpu_stats.system_cpu_usage;
      const numCpus = data.cpu_stats.online_cpus || 1;
      const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;

      const memUsed = data.memory_stats.usage - (data.memory_stats.stats?.cache || 0);
      const memLimit = data.memory_stats.limit;

      resolve({
        cpu: Math.round(cpuPercent * 10) / 10,
        memUsed: Math.round(memUsed / 1024 / 1024),
        memLimit: Math.round(memLimit / 1024 / 1024),
        memPercent: memLimit > 0 ? Math.round((memUsed / memLimit) * 100) : 0,
      });
    });
  });
}

async function getContainerStatus(containerId) {
  try {
    const container = docker.getContainer(containerId);
    const info = await container.inspect();
    return info.State.Status;
  } catch {
    return 'removed';
  }
}

// Retourne une fonction stop() qui détruit le stream Docker.
// since: timestamp Unix (secondes) — si fourni, ne rejoue pas les anciennes lignes.
function streamContainerLogs(containerId, onData, onError, onEnd, { since = null } = {}) {
  const { PassThrough } = require('stream');
  const container = docker.getContainer(containerId);
  const opts = { follow: true, stdout: true, stderr: true };
  if (since != null) {
    opts.since = since;
    opts.tail = 0;
  } else {
    opts.tail = 200;
  }

  let streamRef = null;
  let intentionallyStopped = false;
  const stop = () => {
    intentionallyStopped = true;
    try { streamRef?.destroy(); } catch {}
  };

  container.logs(opts, (err, stream) => {
    if (err) { if (!intentionallyStopped) onError?.(err); return; }
    streamRef = stream;

    // Docker renvoie un stream multiplexé : 8 octets de header + payload par chunk.
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    docker.modem.demuxStream(stream, stdout, stderr);

    let lineBuffer = '';
    const processChunk = chunk => {
      lineBuffer += chunk.toString('utf8');
      const parts = lineBuffer.split('\n');
      lineBuffer = parts.pop();
      parts
        .map(l => l.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim())
        .filter(Boolean)
        .forEach(onData);
    };

    stdout.on('data', processChunk);
    stderr.on('data', processChunk);
    stream.on('error', err => { if (!intentionallyStopped) (onError || console.error)(err); });
    stream.on('end', () => { if (!intentionallyStopped) onEnd?.(); });
  });

  return stop;
}

// Récupère les N dernières lignes de logs sans suivre (pour historique UI).
// Avec follow:false, dockerode retourne un Buffer (format multiplexé Docker), pas un stream.
function getRecentLogs(containerId, lines = 200) {
  return new Promise((resolve) => {
    const container = docker.getContainer(containerId);
    container.logs({ follow: false, stdout: true, stderr: true, tail: lines }, (err, data) => {
      if (err || !data) return resolve([]);
      try {
        // Parse du format multiplexé Docker : header 8 octets + payload
        // Header[0] = type (1=stdout, 2=stderr), Header[4..7] = taille payload (big-endian)
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        const result = [];
        let offset = 0;
        while (offset + 8 <= buf.length) {
          const size = buf.readUInt32BE(offset + 4);
          offset += 8;
          if (size === 0) continue;
          if (offset + size > buf.length) break;
          const payload = buf.slice(offset, offset + size).toString('utf8');
          offset += size;
          payload.split('\n').forEach(l => {
            const clean = l.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
            if (clean) result.push(clean);
          });
        }
        resolve(result);
      } catch {
        resolve([]);
      }
    });
  });
}

async function pullImage(imageName, onProgress) {
  return new Promise((resolve, reject) => {
    docker.pull(imageName, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err, output) => {
        if (err) return reject(err);
        resolve(output);
      }, event => {
        if (event.status && onProgress) onProgress(event);
      });
    });
  });
}

async function listMcContainers() {
  const containers = await docker.listContainers({ all: true });
  return containers.filter(c => c.Names.some(n => n.startsWith('/mc-')));
}

async function removeContainerAndImage(containerId) {
  let imageToRemove = null;
  try {
    const info = await docker.getContainer(containerId).inspect();
    imageToRemove = info.Image; // sha256 digest
  } catch {}

  await removeContainer(containerId);

  if (imageToRemove) {
    try {
      const remaining = await docker.listContainers({ all: true });
      const stillUsed = remaining.some(c => c.ImageID === imageToRemove || c.Image === imageToRemove);
      if (!stillUsed) {
        await docker.getImage(imageToRemove).remove({ force: false });
        console.log(`[Docker] Image supprimée : ${imageToRemove.slice(0, 20)}…`);
      }
    } catch (e) {
      console.warn(`[Docker] Impossible de supprimer l'image : ${e.message}`);
    }
  }
}

module.exports = {
  docker,
  detectThinPackStartScript,
  createServerContainer,
  startContainer,
  stopContainer,
  restartContainer,
  removeContainer,
  removeContainerAndImage,
  getContainerStats,
  getContainerStatus,
  streamContainerLogs,
  getRecentLogs,
  pullImage,
  listMcContainers,
};
