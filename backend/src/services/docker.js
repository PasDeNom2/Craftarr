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
 * Lit NEOFORGE_VERSION= depuis startserver.sh/bat du server pack.
 * ATM11 : startserver.sh contient `NEOFORGE_VERSION=26.1.2.12-beta`
 */
function detectNeoForgeVersionFromStartScript(serverDir) {
  const scripts = ['startserver.sh', 'startserver.bat', 'start.sh', 'start.bat'];
  const dirs = [serverDir];
  try {
    for (const entry of fs.readdirSync(serverDir, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(path.join(serverDir, entry.name));
    }
  } catch {}
  for (const dir of dirs) {
    for (const script of scripts) {
      try {
        const content = fs.readFileSync(path.join(dir, script), 'utf8');
        const m = content.match(/NEOFORGE_VERSION\s*=\s*["']?([0-9][^\s"']+)["']?/);
        if (m) return m[1].trim();
      } catch {}
    }
  }
  return null;
}

/**
 * Détecte le JAR d'installation NeoForge bundlé dans le server pack.
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
 * Dérive la version MC depuis une version NeoForge.
 * Schéma NeoForge :
 *   21.x.y    → MC 1.21.x   (ancien schéma)
 *   20.x.y    → MC 1.20.x
 *   26.1.x.y  → MC 1.21.1   (nouveau schéma post-26)
 */
function deriveMcVersionFromNeoForge(nfVersion) {
  const parts = nfVersion.replace(/-.*/, '').split('.').map(Number);
  const major = parts[0];
  if (major >= 20 && major <= 25 && parts.length >= 2) {
    return `1.${major}.${parts[1]}`;
  }
  if (major === 26 && parts.length >= 2) {
    return `1.21.${parts[1]}`;
  }
  return null;
}

function buildEnvVars(server) {
  const serverDir = path.join(DATA_PATH, 'servers', server.id, 'server');

  const neoForgeVersionFromScript = server.loader_type === 'neoforge'
    ? detectNeoForgeVersionFromStartScript(serverDir)
    : null;

  const neoForgeInstallerPath = server.loader_type === 'neoforge'
    ? detectNeoForgeInstallerFromPack(serverDir)
    : null;
  const neoForgeInstallerInContainer = neoForgeInstallerPath
    ? neoForgeInstallerPath.replace(serverDir, '/data')
    : null;

  const env = [
    'EULA=TRUE',
    `TYPE=${server.loader_type?.toUpperCase() || 'FORGE'}`,
    `MAX_MEMORY=${server.ram_mb}M`,
    `INIT_MEMORY=${Math.min(1024, Math.floor(server.ram_mb / 2))}M`,
    `MAX_PLAYERS=${server.max_players}`,
    `ONLINE_MODE=${server.online_mode !== 0 ? 'TRUE' : 'FALSE'}`,
    `ENABLE_RCON=true`,
    `RCON_PORT=25575`,
    `RCON_PASSWORD=${server.rcon_password}`,
    `MOTD=${server.motd || `${server.name} — Powered by Craftarr`}`,
  ];

  if (neoForgeVersionFromScript) {
    // startserver.sh fournit la version exacte → méthode la plus fiable
    console.log(`[Docker] NeoForge version (startserver) : ${neoForgeVersionFromScript}`);
    env.push(`NEOFORGE_VERSION=${neoForgeVersionFromScript}`);
    const derivedMc = deriveMcVersionFromNeoForge(neoForgeVersionFromScript);
    if (derivedMc) {
      console.log(`[Docker] MC version déduite : ${derivedMc}`);
      env.push(`VERSION=${derivedMc}`);
    }
  } else if (neoForgeInstallerInContainer) {
    console.log(`[Docker] NeoForge installer bundlé : ${neoForgeInstallerInContainer}`);
    env.push(`NEOFORGE_INSTALLER=${neoForgeInstallerInContainer}`);
  } else if (server.mc_version && /^1\.\d{1,2}(\.\d{1,2})?$/.test(server.mc_version)) {
    // Uniquement une vraie version MC (1.x.y), jamais une version loader (26.1.2)
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

  // Détection du type de pack :
  // - server-setup-config.yaml → ServerStarter (itzg le gère via SERVER_SETUP_CONFIG)
  //   NE PAS utiliser MODPACK dans ce cas (itzg extrairait dans /data/mods/ au lieu de /data/)
  // - Sinon → MODPACK direct si URL disponible
  const setupConfigPath = path.join(serverDir, 'server-setup-config.yaml');
  if (fs.existsSync(setupConfigPath)) {
    env.push('SERVER_SETUP_CONFIG=/data/server-setup-config.yaml');
  } else if (server.modpack_download_url) {
    env.push(`MODPACK=${server.modpack_download_url}`);
  }

  return env;
}

/**
 * Choisit le bon tag d'image itzg/minecraft-server selon la version MC.
 *
 * Java requis par version Minecraft :
 *  < 1.17          → Java 8   (Forge legacy, LaunchwWrapper, etc.)
 *  1.17            → Java 16
 *  1.18 – 1.20.4   → Java 17
 *  ≥ 1.20.5        → Java 21
 *
 * Utiliser la mauvaise version Java provoque des ClassCastException (URLClassLoader)
 * ou des erreurs de bytecode sur les vieux packs (RLCraft, FTB Legacy, etc.).
 */
function resolveMinecraftImage(mcVersion, neoforgeVersion) {
  // NeoForge 26.x (MC 1.21.1+) nécessite Java 25 (class file version 69)
  if (neoforgeVersion) {
    const nfMajor = parseInt(neoforgeVersion.split('.')[0], 10);
    if (nfMajor >= 26) return 'itzg/minecraft-server:java25';
    return 'itzg/minecraft-server:java21'; // NeoForge < 26 → Java 21
  }
  if (!mcVersion) return 'itzg/minecraft-server:java21'; // NeoForge sans version connue → Java 21 safe

  // Extraire les deux premiers segments : "1.12.2" → [1, 12]
  const parts = mcVersion.replace(/[^0-9.]/g, '').split('.').map(Number);
  const major = parts[0] ?? 1;
  const minor = parts[1] ?? 0;

  if (major === 1) {
    if (minor < 17) return 'itzg/minecraft-server:java8';
    if (minor === 17) return 'itzg/minecraft-server:java16';
    if (minor <= 20) {
      // 1.20.5+ nécessite Java 21
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

async function createServerContainer(server, onProgress) {
  await ensureNetwork();

  const serverDir = path.join(DATA_PATH, 'servers', server.id, 'server');
  // Pour le bind mount, on utilise HOST_DATA_PATH (chemin hôte) car Docker daemon
  // interprète les chemins depuis l'hôte, pas depuis l'intérieur du backend container
  const hostServerDir = path.join(HOST_DATA_PATH, 'servers', server.id, 'server');
  const containerName = `mc-${server.id.slice(0, 8)}`;

  const nfVersionForImage = server.loader_type === 'neoforge'
    ? detectNeoForgeVersionFromStartScript(path.join(DATA_PATH, 'servers', server.id, 'server'))
    : null;
  const image = resolveMinecraftImage(server.mc_version, nfVersionForImage);
  console.log(`[Docker] Image sélectionnée pour MC ${server.mc_version || '?'} NeoForge ${nfVersionForImage || 'n/a'} : ${image}`);
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

function streamContainerLogs(containerId, onData, onError, useTail = false) {
  const { PassThrough } = require('stream');
  const container = docker.getContainer(containerId);
  container.logs(
    { follow: true, stdout: true, stderr: true, tail: useTail ? 200 : 0 },
    (err, stream) => {
      if (err) return onError?.(err);

      // Docker renvoie un stream multiplexé : 8 octets de header + payload par chunk.
      // demuxStream sépare stdout/stderr correctement avant de passer les données.
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      docker.modem.demuxStream(stream, stdout, stderr);

      let lineBuffer = '';
      const processChunk = chunk => {
        lineBuffer += chunk.toString('utf8');
        const parts = lineBuffer.split('\n');
        lineBuffer = parts.pop(); // fragment incomplet, attendre la suite
        parts
          .map(l => l.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim())
          .filter(Boolean)
          .forEach(onData);
      };

      stdout.on('data', processChunk);
      stderr.on('data', processChunk);
      stream.on('error', onError || console.error);
    }
  );
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

module.exports = {
  createServerContainer,
  startContainer,
  stopContainer,
  restartContainer,
  removeContainer,
  getContainerStats,
  getContainerStatus,
  streamContainerLogs,
  pullImage,
  listMcContainers,
};
