const { getDb } = require('../config/database');
const dockerService = require('./docker');
const rcon = require('./rcon');

let io;
function setIo(ioInstance) { io = ioInstance; }

// Intervalles par défaut : stats Docker toutes les 2 s, RCON toutes les 15 s
const DOCKER_INTERVAL = 2000;
const RCON_INTERVAL = 15000;
const RCON_INITIAL_DELAY = 5000;
const ACTIVE_DOCKER_STATUSES = new Set(['running', 'starting']);

let polling = false;
let pollEpoch = 0;
let dockerTimer = null;
let rconTimer = null;
let dockerInFlight = false;
let rconInFlight = false;

// Cache en mémoire des derniers résultats RCON par serveur
const rconCache = {}; // { [serverId]: { players, tps } }

/**
 * Construit l'objet métriques d'un serveur.
 * Les stats Docker ne sont demandées que pour les serveurs running ou starting.
 */
async function collectServerMetrics(server) {
  const cached = rconCache[server.id];
  const metrics = {
    serverId: server.id,
    timestamp: Date.now(),
    cpu: 0,
    memUsed: 0,
    memLimit: 0,
    memPercent: 0,
    players: cached?.players || { online: 0, max: server.max_players },
    tps: cached?.tps || null,
    uptime: null,
  };

  if (server.container_id && ACTIVE_DOCKER_STATUSES.has(server.status)) {
    try {
      const stats = await dockerService.getContainerStats(server.container_id);
      if (stats) Object.assign(metrics, stats);
    } catch {}
  }

  // Restaure les valeurs RCON en cache (potentiellement mises à jour pendant l'appel Docker)
  metrics.players = rconCache[server.id]?.players || metrics.players;
  metrics.tps = rconCache[server.id]?.tps || metrics.tps;

  return metrics;
}

async function pollDockerStats() {
  if (!io || dockerInFlight) return;
  dockerInFlight = true;
  try {
    const db = getDb();
    const servers = db.prepare('SELECT * FROM servers WHERE status IN (?, ?, ?)').all('running', 'stopped', 'starting');

    await Promise.allSettled(servers.map(async (server) => {
      const room = `server:${server.id}`;
      const sockets = await io.in(room).fetchSockets();
      if (sockets.length === 0) return;

      try {
        const metrics = await collectServerMetrics(server);
        io.to(room).emit('metrics', metrics);

        if (server.status === 'running') {
          db.prepare('UPDATE servers SET last_seen = ? WHERE id = ?')
            .run(new Date().toISOString(), server.id);
        }
      } catch (err) {
        console.error(`[Metrics] Erreur Docker serveur ${server.id}:`, err.message);
      }
    }));
  } finally {
    dockerInFlight = false;
  }
}

async function pollRconStats() {
  if (!io || rconInFlight) return;
  rconInFlight = true;
  try {
    const db = getDb();
    const servers = db.prepare('SELECT * FROM servers WHERE status IN (?, ?)').all('running', 'starting');

    await Promise.allSettled(servers.map(async (server) => {
      const room = `server:${server.id}`;
      const sockets = await io.in(room).fetchSockets();
      if (sockets.length === 0) {
        // Nettoie le cache des serveurs que personne ne regarde
        delete rconCache[server.id];
        return;
      }

      try {
        const { players, tps } = await rcon.getServerStats(server);
        rconCache[server.id] = { players, tps };
      } catch {
        // RCON indisponible — garde les dernières valeurs connues, sans log (le serveur démarre peut-être)
      }
    }));
  } finally {
    rconInFlight = false;
  }
}

/**
 * Push immédiat des métriques pour un serveur donné vers un socket spécifique.
 * Appelé dès qu'un client souscrit à un serveur pour éviter d'attendre le prochain tick.
 */
async function pushImmediate(socket, serverId) {
  const db = getDb();
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  if (!server) return;
  try {
    const metrics = await collectServerMetrics(server);
    socket.emit('metrics', metrics);
  } catch {}
}

/**
 * Planifie une boucle auto-réarmée : attend la fin de chaque tour avant de programmer le suivant.
 */
function scheduleLoop(pollFn, intervalMs, setTimer, epoch, initialDelayMs = intervalMs) {
  const scheduleNext = (delayMs) => {
    if (!polling || epoch !== pollEpoch) return;
    const timer = setTimeout(async () => {
      setTimer(null);
      if (!polling || epoch !== pollEpoch) return;
      try {
        await pollFn();
      } catch (err) {
        console.error('[Metrics] Erreur boucle de polling :', err.message);
      }
      scheduleNext(intervalMs);
    }, delayMs);
    setTimer(timer);
  };
  scheduleNext(initialDelayMs);
}

function startPolling(opts = {}) {
  if (polling) return;
  const dockerMs = opts?.dockerMs ?? DOCKER_INTERVAL;
  const rconMs = opts?.rconMs ?? RCON_INTERVAL;
  const rconFirstDelay = Math.min(RCON_INITIAL_DELAY, rconMs);

  polling = true;
  const epoch = ++pollEpoch;

  scheduleLoop(pollDockerStats, dockerMs, t => { dockerTimer = t; }, epoch);
  // Premier tour RCON plus tôt au démarrage pour alimenter le cache rapidement
  scheduleLoop(pollRconStats, rconMs, t => { rconTimer = t; }, epoch, rconFirstDelay);

  console.log(`[Metrics] Polling démarré (Docker: ${dockerMs}ms, RCON: ${rconMs}ms)`);
}

function stopPolling() {
  polling = false;
  pollEpoch++;
  if (dockerTimer) { clearTimeout(dockerTimer); dockerTimer = null; }
  if (rconTimer) { clearTimeout(rconTimer); rconTimer = null; }
}

module.exports = {
  setIo,
  startPolling,
  stopPolling,
  pushImmediate,
  // Exposé pour les tests uniquement
  _internals: { pollDockerStats, pollRconStats },
};
