/**
 * Coupe-circuit des crashs en boucle.
 * Les containers Minecraft ont RestartPolicy « unless-stopped » : un modpack qui plante au
 * démarrage redémarre indéfiniment (CPU à fond, logs qui gonflent, monde rechargé en boucle).
 * Toutes les minutes, on compare le compteur de redémarrages Docker : au-delà de MAX_RESTARTS
 * en WINDOW_MS, le container est arrêté (un arrêt manuel désactive la relance automatique) et
 * le serveur passe en erreur avec un message clair dans la console.
 */
const { getDb } = require('../config/database');
const dockerService = require('./docker');
const serverLock = require('./serverLock');

const CHECK_MS = 60 * 1000;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_RESTARTS = 3;

const history = new Map(); // containerId → [{ count, at }]
let timer = null;
let io = null;

function setIo(instance) { io = instance; }

/** true si les relevés montrent MAX_RESTARTS redémarrages ou plus dans la fenêtre. */
function isLooping(samples, now = Date.now()) {
  const recent = samples.filter(s => now - s.at <= WINDOW_MS);
  if (recent.length < 2) return false;
  return recent[recent.length - 1].count - recent[0].count >= MAX_RESTARTS;
}

async function checkServer(server) {
  let info;
  try { info = await dockerService.docker.getContainer(server.container_id).inspect(); }
  catch { history.delete(server.container_id); return; }

  const now = Date.now();
  const samples = (history.get(server.container_id) || []).filter(s => now - s.at <= WINDOW_MS);
  samples.push({ count: info.RestartCount || 0, at: now });
  history.set(server.container_id, samples);
  if (!isLooping(samples, now)) return;

  console.warn(`[CrashGuard] ${server.name} redémarre en boucle (${info.RestartCount} redémarrages) — arrêt du container`);
  history.delete(server.container_id);
  try { await dockerService.stopContainer(server.container_id, 30); } catch {}
  getDb().prepare("UPDATE servers SET status = 'error' WHERE id = ?").run(server.id);
  require('./notify').notify({
    serverName: server.name, level: 'error', title: 'Crash en boucle',
    message: `Le serveur a planté ${MAX_RESTARTS} fois en ${WINDOW_MS / 60000} minutes et a été arrêté. Consultez la console dans Craftarr.`,
  });
  const line = `[Craftarr] ⚠ Le serveur a planté ${MAX_RESTARTS} fois en ${WINDOW_MS / 60000} minutes : arrêté pour éviter une boucle. `
    + 'Le diagnostic au-dessus indique en général la cause (mod manquant, mémoire, Java…).';
  if (io) {
    io.to(`server:${server.id}`).emit('log', { serverId: server.id, line, timestamp: Date.now() });
    io.emit('server:status', { serverId: server.id, status: 'error' });
  }
}

async function tick() {
  const servers = getDb().prepare(
    "SELECT * FROM servers WHERE container_id IS NOT NULL AND status IN ('running', 'starting', 'error')",
  ).all();
  for (const server of servers) {
    if (serverLock.busyReason(server)) continue; // une opération en cours gère elle-même le container
    await checkServer(server).catch(err => console.warn('[CrashGuard]', err.message));
  }
}

function start() {
  if (timer) return;
  timer = setInterval(() => tick().catch(() => {}), CHECK_MS);
}
function stop() { clearInterval(timer); timer = null; }

module.exports = { start, stop, setIo, _internals: { isLooping, history, WINDOW_MS, MAX_RESTARTS } };
