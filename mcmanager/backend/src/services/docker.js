const Docker = require('dockerode');
const path = require('path');
const fs = require('fs');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const DATA_PATH = process.env.DATA_PATH || '/data';
// HOST_DATA_PATH = chemin hôte correspondant à DATA_PATH, utilisé pour les bind mounts des containers MC
// (Docker daemon interprète les chemins de bind mounts depuis le point de vue de l'hôte)
const HOST_DATA_PATH = process.env.HOST_DATA_PATH || DATA_PATH;
const MC_NETWORK = 'mcmanager';

async function ensureNetwork() {
  const networks = await docker.listNetworks({ filters: { name: [MC_NETWORK] } });
  if (!networks.find(n => n.Name === MC_NETWORK)) {
    await docker.createNetwork({ Name: MC_NETWORK, Driver: 'bridge' });
    console.log(`[Docker] Réseau ${MC_NETWORK} créé`);
  }
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

function buildEnvVars(server) {
  const serverDir = path.join(DATA_PATH, 'servers', server.id, 'server');

  // Détecte si un JAR d'installation NeoForge est bundlé dans le server pack
  const neoForgeInstallerPath = server.loader_type === 'neoforge'
    ? detectNeoForgeInstallerFromPack(serverDir)
    : null;
  // Converti le chemin absolu (DATA_PATH) en chemin /data vu depuis le container MC
  const neoForgeInstallerInContainer = neoForgeInstallerPath
    ? neoForgeInstallerPath.replace(serverDir, '/data')
    : null;

  const env = [
    'EULA=TRUE',
    `TYPE=${server.loader_type?.toUpperCase() || 'FORGE'}`,
    `MAX_MEMORY=${server.ram_mb}M`,
    `INIT_MEMORY=${Math.min(1024, Math.floor(server.ram_mb / 2))}M`,
    `MAX_PLAYERS=${server.max_players}`,
    `ONLINE_MODE=FALSE`,
    `ENABLE_RCON=true`,
    `RCON_PORT=25575`,
    `RCON_PASSWORD=${server.rcon_password}`,
    `MOTD=${server.motd || `${server.name} — Powered by MCManager`}`,
  ];

  if (neoForgeInstallerInContainer) {
    // Utilise le JAR d'installation bundlé par le server pack (ex: ATM11 = 26.1.2.10-beta)
    console.log(`[Docker] NeoForge installer bundlé : ${neoForgeInstallerInContainer}`);
    env.push(`NEOFORGE_INSTALLER=${neoForgeInstallerInContainer}`);
  } else if (server.mc_version) {
    env.push(`VERSION=${server.mc_version}`);
  }

  if (server.seed) env.push(`SEED=${server.seed}`);
  if (server.whitelist_enabled) env.push('WHITELIST=true');
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

async function createServerContainer(server) {
  await ensureNetwork();

  const serverDir = path.join(DATA_PATH, 'servers', server.id, 'server');
  // Pour le bind mount, on utilise HOST_DATA_PATH (chemin hôte) car Docker daemon
  // interprète les chemins depuis l'hôte, pas depuis l'intérieur du backend container
  const hostServerDir = path.join(HOST_DATA_PATH, 'servers', server.id, 'server');
  const containerName = `mc-${server.id.slice(0, 8)}`;

  const container = await docker.createContainer({
    name: containerName,
    Image: 'itzg/minecraft-server:latest',
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

function streamContainerLogs(containerId, onData, onError) {
  const { PassThrough } = require('stream');
  const container = docker.getContainer(containerId);
  container.logs(
    { follow: true, stdout: true, stderr: true, tail: 200 },
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
