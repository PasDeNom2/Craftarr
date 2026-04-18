const { getDb } = require('../config/database');
const dockerService = require('./docker');
const rcon = require('./rcon');

let io;
function setIo(ioInstance) { io = ioInstance; }

// Docker stats polled every 5s, RCON polled every 30s to avoid spamming MC logs
const DOCKER_INTERVAL = 5000;
const RCON_INTERVAL = 30000;

let dockerTimer = null;
let rconTimer = null;

// In-memory cache of last RCON results per server
const rconCache = {}; // { [serverId]: { players, tps } }

async function pollDockerStats() {
  if (!io) return;
  const db = getDb();
  const servers = db.prepare('SELECT * FROM servers WHERE status IN (?, ?, ?)').all('running', 'stopped', 'starting');

  for (const server of servers) {
    const room = `server:${server.id}`;
    const sockets = await io.in(room).fetchSockets();
    if (sockets.length === 0) continue;

    try {
      const metrics = {
        serverId: server.id,
        timestamp: Date.now(),
        cpu: 0,
        memUsed: 0,
        memLimit: 0,
        memPercent: 0,
        players: rconCache[server.id]?.players || { online: 0, max: server.max_players },
        tps: rconCache[server.id]?.tps || null,
        uptime: null,
      };

      if (server.container_id) {
        try {
          const stats = await dockerService.getContainerStats(server.container_id);
          if (stats) Object.assign(metrics, stats);
        } catch {}
      }

      // Restore cached RCON values that may have been overwritten by docker stats
      metrics.players = rconCache[server.id]?.players || metrics.players;
      metrics.tps = rconCache[server.id]?.tps || metrics.tps;

      io.to(room).emit('metrics', metrics);

      if (server.status === 'running') {
        db.prepare('UPDATE servers SET last_seen = ? WHERE id = ?')
          .run(new Date().toISOString(), server.id);
      }
    } catch (err) {
      console.error(`[Metrics] Erreur Docker serveur ${server.id}:`, err.message);
    }
  }
}

async function pollRconStats() {
  if (!io) return;
  const db = getDb();
  const servers = db.prepare('SELECT * FROM servers WHERE status IN (?, ?)').all('running', 'starting');

  for (const server of servers) {
    const room = `server:${server.id}`;
    const sockets = await io.in(room).fetchSockets();
    if (sockets.length === 0) {
      // Clean cache for servers nobody is watching
      delete rconCache[server.id];
      continue;
    }

    try {
      const { players, tps } = await rcon.getServerStats(server);
      rconCache[server.id] = { players, tps };
    } catch {
      // RCON unavailable — keep last known values, don't log (server may be starting)
    }
  }
}

function startPolling() {
  if (dockerTimer) return;
  dockerTimer = setInterval(pollDockerStats, DOCKER_INTERVAL);
  rconTimer = setInterval(pollRconStats, RCON_INTERVAL);
  // Run RCON once after 10s to populate cache quickly on startup
  setTimeout(pollRconStats, 10000);
  console.log('[Metrics] Polling démarré (Docker: 5s, RCON: 30s)');
}

function stopPolling() {
  if (dockerTimer) { clearInterval(dockerTimer); dockerTimer = null; }
  if (rconTimer) { clearInterval(rconTimer); rconTimer = null; }
}

async function collectServerMetrics(server) {
  const metrics = {
    serverId: server.id,
    timestamp: Date.now(),
    cpu: 0, memUsed: 0, memLimit: 0, memPercent: 0,
    players: { online: 0, max: server.max_players },
    tps: null, uptime: null,
  };
  if (server.container_id) {
    try {
      const stats = await dockerService.getContainerStats(server.container_id);
      if (stats) Object.assign(metrics, stats);
    } catch {}
  }
  if (server.status === 'running') {
    const { players, tps } = await rcon.getServerStats(server);
    metrics.players = players;
    metrics.tps = tps;
  }
  return metrics;
}

module.exports = { setIo, startPolling, stopPolling, collectServerMetrics };
