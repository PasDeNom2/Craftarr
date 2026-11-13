// Échantillonnage périodique des métriques (CPU, RAM, joueurs, TPS) et rétention (48 h minute / 30 j horaire).
const { getDb } = require('../config/database');
const dockerService = require('./docker');
const rcon = require('./rcon');

const SAMPLE_INTERVAL_MS = 60 * 1000;
const RAW_RETENTION_SECONDS = 48 * 3600;
const HOURLY_RETENTION_SECONDS = 30 * 86400;

let running = false;
let epoch = 0;
let timer = null;
let inFlight = false;

/**
 * Collecte les métriques Docker et RCON d'un serveur running puis insère son échantillon.
 * Retourne true si une ligne a été enregistrée.
 */
async function sampleServer(server, ts, insertStmt) {
  const [dockerRes, rconRes] = await Promise.allSettled([
    Promise.resolve().then(() => dockerService.getContainerStats(server.container_id)),
    Promise.resolve().then(() => rcon.getServerStats(server)),
  ]);

  if (dockerRes.status !== 'fulfilled' || !dockerRes.value) {
    return false;
  }

  const stats = dockerRes.value;
  const cpu = typeof stats.cpu === 'number' && Number.isFinite(stats.cpu) ? stats.cpu : null;
  const memMb = typeof stats.memUsed === 'number' && Number.isFinite(stats.memUsed) ? Math.round(stats.memUsed) : null;

  const rconData = rconRes.status === 'fulfilled' ? rconRes.value : null;
  const players = typeof rconData?.players?.online === 'number' && Number.isFinite(rconData.players.online)
    ? Math.round(rconData.players.online)
    : null;
  const tps = typeof rconData?.tps?.tps1 === 'number' && Number.isFinite(rconData.tps.tps1)
    ? rconData.tps.tps1
    : null;

  insertStmt.run(server.id, ts, cpu, memMb, players, tps);
  return true;
}

/**
 * Exécute un tour d'échantillonnage sur tous les serveurs running en parallèle.
 * @param {number} [nowMs]
 * @returns {Promise<number>} Nombre d'échantillons enregistrés
 */
async function sampleOnce(nowMs = Date.now()) {
  const db = getDb();
  const ts = Math.floor(nowMs / 1000);
  const servers = db.prepare(
    "SELECT * FROM servers WHERE status = 'running' AND container_id IS NOT NULL AND container_id != ''"
  ).all();

  if (servers.length === 0) return 0;

  const insertStmt = db.prepare(
    'INSERT OR REPLACE INTO metrics_samples (server_id, ts, cpu, mem_mb, players, tps) VALUES (?, ?, ?, ?, ?, ?)'
  );

  const results = await Promise.allSettled(
    servers.map(server => sampleServer(server, ts, insertStmt))
  );

  return results.filter(r => r.status === 'fulfilled' && r.value === true).length;
}

/**
 * Agrège les heures terminées dans `metrics_hourly` (moyenne et max) et purge les données expirées
 * (> 48 h pour `metrics_samples`, > 30 j pour `metrics_hourly`).
 * @param {number} [nowMs]
 */
function aggregateAndPurge(nowMs = Date.now()) {
  const db = getDb();
  const nowSec = Math.floor(nowMs / 1000);
  const currentHourStart = Math.floor(nowSec / 3600) * 3600;
  const cutoff48h = nowSec - RAW_RETENTION_SECONDS;
  const cutoff30d = nowSec - HOURLY_RETENTION_SECONDS;
  // Heures dont aucun échantillon n'a encore été purgé : recalculables sans risque d'écraser une heure complète
  const safeRecomputeFromHour = (Math.floor(cutoff48h / 3600) + 1) * 3600;

  const selectCols = `
    server_id,
    CAST(ts / 3600 AS INTEGER) * 3600 AS hour_ts,
    ROUND(AVG(cpu), 2) AS cpu,
    CAST(ROUND(AVG(mem_mb)) AS INTEGER) AS mem_mb,
    CAST(ROUND(AVG(players)) AS INTEGER) AS players,
    ROUND(AVG(tps), 2) AS tps,
    MAX(cpu) AS cpu_max,
    MAX(mem_mb) AS mem_max,
    MAX(players) AS players_max
  `;

  const upsertRecent = db.prepare(`
    INSERT INTO metrics_hourly (server_id, ts, cpu, mem_mb, players, tps, cpu_max, mem_max, players_max)
    SELECT ${selectCols}
    FROM metrics_samples
    WHERE ts < ? AND CAST(ts / 3600 AS INTEGER) * 3600 >= ?
    GROUP BY server_id, CAST(ts / 3600 AS INTEGER) * 3600
    ON CONFLICT(server_id, ts) DO UPDATE SET
      cpu = excluded.cpu,
      mem_mb = excluded.mem_mb,
      players = excluded.players,
      tps = excluded.tps,
      cpu_max = excluded.cpu_max,
      mem_max = excluded.mem_max,
      players_max = excluded.players_max
  `);

  const insertOlder = db.prepare(`
    INSERT OR IGNORE INTO metrics_hourly (server_id, ts, cpu, mem_mb, players, tps, cpu_max, mem_max, players_max)
    SELECT ${selectCols}
    FROM metrics_samples
    WHERE ts < ? AND CAST(ts / 3600 AS INTEGER) * 3600 < ?
    GROUP BY server_id, CAST(ts / 3600 AS INTEGER) * 3600
  `);

  const purgeRaw = db.prepare('DELETE FROM metrics_samples WHERE ts < ?');
  const purgeHourly = db.prepare('DELETE FROM metrics_hourly WHERE ts < ?');

  db.transaction(() => {
    upsertRecent.run(currentHourStart, safeRecomputeFromHour);
    insertOlder.run(currentHourStart, safeRecomputeFromHour);
    purgeRaw.run(cutoff48h);
    purgeHourly.run(cutoff30d);
  })();
}

/**
 * Un tour complet protégé contre la réentrance.
 */
async function tick() {
  if (inFlight) return;
  inFlight = true;
  try {
    await sampleOnce();
    aggregateAndPurge();
  } finally {
    inFlight = false;
  }
}

/**
 * Démarre la boucle d'échantillonnage auto-planifiée (sans chevauchement).
 * @param {{ intervalMs?: number, initialDelayMs?: number }} [opts]
 */
function start(opts = {}) {
  if (running) return;
  const intervalMs = opts?.intervalMs ?? SAMPLE_INTERVAL_MS;
  const initialDelayMs = opts?.initialDelayMs ?? intervalMs;

  running = true;
  const curEpoch = ++epoch;

  const scheduleNext = (delayMs) => {
    if (!running || curEpoch !== epoch) return;
    timer = setTimeout(async () => {
      timer = null;
      if (!running || curEpoch !== epoch) return;
      try {
        await tick();
      } catch (err) {
        console.error('[MetricsHistory] Erreur boucle d\'échantillonnage :', err.message);
      }
      scheduleNext(intervalMs);
    }, delayMs);
    timer.unref?.();
  };

  scheduleNext(initialDelayMs);
}

/**
 * Arrête proprement la boucle d'échantillonnage.
 */
function stop() {
  running = false;
  epoch++;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/**
 * Supprime tout l'historique d'un serveur (ex. à sa suppression).
 * @param {string} serverId
 */
function deleteServerMetrics(serverId) {
  if (!serverId) return;
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM metrics_samples WHERE server_id = ?').run(serverId);
    db.prepare('DELETE FROM metrics_hourly WHERE server_id = ?').run(serverId);
  })();
}

module.exports = {
  start,
  stop,
  sampleOnce,
  aggregateAndPurge,
  deleteServerMetrics,
  _internals: { tick, RAW_RETENTION_SECONDS, HOURLY_RETENTION_SECONDS },
};
