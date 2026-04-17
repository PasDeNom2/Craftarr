const { getDb } = require('../config/database');
const dockerService = require('../services/docker');
const metrics = require('../services/metrics');

// serverId -> cleanup fn (peut être un timer ou un vrai stream)
const activeStreams = new Map();

function setupLogsSocket(io) {
  io.on('connection', socket => {
    socket.on('logs:subscribe', async ({ serverId }) => {
      if (!serverId) return;
      socket.join(`server:${serverId}`);

      // Lance (ou attend) le stream si pas encore actif
      if (!activeStreams.has(serverId)) {
        startLogStream(io, serverId);
      }

      // Push immédiat des métriques sans attendre le prochain tick du polling
      metrics.pushImmediate(socket, serverId);
    });

    socket.on('logs:unsubscribe', ({ serverId }) => {
      socket.leave(`server:${serverId}`);
    });

    socket.on('disconnect', async () => {
      // Arrête les streams dont plus aucun client n'est abonné
      for (const [serverId] of activeStreams) {
        const room = `server:${serverId}`;
        const sockets = await io.in(room).fetchSockets();
        if (sockets.length === 0) {
          stopLogStream(serverId);
        }
      }
    });
  });
}

/**
 * Démarre le stream Docker pour un serveur.
 * Si le container_id n'est pas encore connu (installation en cours),
 * réessaie toutes les 3 secondes jusqu'à 40 fois (~2 min).
 */
function startLogStream(io, serverId, attempt = 0) {
  const db = getDb();
  const server = db.prepare('SELECT container_id FROM servers WHERE id = ?').get(serverId);

  if (!server?.container_id) {
    if (attempt >= 40) {
      // Abandon après ~2 minutes
      console.warn(`[Logs] Abandon stream ${serverId.slice(0, 8)} après ${attempt} tentatives`);
      activeStreams.delete(serverId);
      return;
    }
    // Réessai dans 3 secondes
    const timer = setTimeout(() => startLogStream(io, serverId, attempt + 1), 3000);
    // Stocker la fn de cleanup même pendant l'attente
    activeStreams.set(serverId, () => {
      clearTimeout(timer);
      activeStreams.delete(serverId);
    });
    return;
  }

  console.log(`[Logs] Démarrage stream pour serveur ${serverId.slice(0, 8)} (tentative ${attempt + 1})`);

  dockerService.streamContainerLogs(
    server.container_id,
    line => {
      io.to(`server:${serverId}`).emit('log', { serverId, line, timestamp: Date.now() });
      // Transition starting → running dès que Minecraft affiche "Done"
      if (line.includes(']: Done (') || line.includes(': Done (')) {
        db.prepare('UPDATE servers SET status = ? WHERE id = ? AND status = ?')
          .run('running', serverId, 'starting');
      }
    },
    err => {
      console.error(`[Logs] Erreur stream ${serverId.slice(0, 8)}:`, err.message);
      activeStreams.delete(serverId);
      // Si le container redémarre on peut relancer le stream automatiquement
    }
  );

  activeStreams.set(serverId, () => {
    activeStreams.delete(serverId);
  });
}

function stopLogStream(serverId) {
  const cleanup = activeStreams.get(serverId);
  if (cleanup) cleanup();
}

module.exports = { setupLogsSocket };
