const { getDb } = require('../config/database');
const dockerService = require('../services/docker');
const metrics = require('../services/metrics');

// ─── Player log parsing ───────────────────────────────────────────────────────
// Cache UUID: serverId -> { playerName -> uuid }
const uuidCache = {};

let _io = null;
function setIo(io) { _io = io; }

function parsePlayerEvent(serverId, line) {
  try {
    const db = getDb();

    // UUID mapping: "UUID of player Steve is 069a79f4-..."
    const uuidMatch = line.match(/UUID of player (\S+) is ([0-9a-f-]{36})/i);
    if (uuidMatch) {
      if (!uuidCache[serverId]) uuidCache[serverId] = {};
      uuidCache[serverId][uuidMatch[1]] = uuidMatch[2];
      return;
    }

    // Join event
    const joinMatch = line.match(/\]: (\S+) joined the game/);
    if (joinMatch) {
      const username = joinMatch[1];
      const uuid = uuidCache[serverId]?.[username] || null;
      db.prepare(`
        INSERT INTO players (server_id, username, uuid, first_seen, last_seen, is_online)
        VALUES (?, ?, ?, datetime('now'), datetime('now'), 1)
        ON CONFLICT(server_id, username) DO UPDATE SET last_seen = datetime('now'), is_online = 1, uuid = COALESCE(excluded.uuid, uuid)
      `).run(serverId, username, uuid);
      db.prepare(`INSERT INTO player_events (server_id, player_name, type, detail) VALUES (?, ?, 'join', NULL)`).run(serverId, username);
      _io?.emit('player:status', { serverId, username, is_online: 1 });
      return;
    }

    // Leave event
    const leaveMatch = line.match(/\]: (\S+) left the game/);
    if (leaveMatch) {
      const username = leaveMatch[1];
      db.prepare(`UPDATE players SET is_online = 0 WHERE server_id = ? AND username = ?`).run(serverId, username);
      db.prepare(`INSERT INTO player_events (server_id, player_name, type, detail) VALUES (?, ?, 'leave', NULL)`).run(serverId, username);
      _io?.emit('player:status', { serverId, username, is_online: 0 });
      return;
    }

    // Chat message: [Server thread/INFO]: <PlayerName> message
    const chatMatch = line.match(/\]: <(\S+)> (.+)/);
    if (chatMatch) {
      db.prepare(`INSERT INTO player_events (server_id, player_name, type, detail) VALUES (?, ?, 'chat', ?)`).run(serverId, chatMatch[1], chatMatch[2]);
      return;
    }

    // Command: "PlayerName issued server command: /cmd"
    const cmdMatch = line.match(/\]: (\S+) issued server command: (.+)/);
    if (cmdMatch) {
      db.prepare(`INSERT INTO player_events (server_id, player_name, type, detail) VALUES (?, ?, 'command', ?)`).run(serverId, cmdMatch[1], cmdMatch[2]);
      return;
    }

    // Death events (many patterns — catch generic "PlayerName <verb>")
    const deathPatterns = [
      /\]: (\S+) was (.+)/,
      /\]: (\S+) died (.+)?/,
      /\]: (\S+) fell (.+)/,
      /\]: (\S+) drowned/,
      /\]: (\S+) burned/,
      /\]: (\S+) blew up/,
      /\]: (\S+) hit the ground/,
      /\]: (\S+) suffocated/,
      /\]: (\S+) went up in flames/,
      /\]: (\S+) starved/,
    ];
    for (const pat of deathPatterns) {
      const m = line.match(pat);
      if (m) {
        // Only treat as death if player exists in our DB
        const player = db.prepare('SELECT id FROM players WHERE server_id = ? AND username = ?').get(serverId, m[1]);
        if (player) {
          const detail = line.replace(/.*\]: /, '');
          db.prepare(`INSERT INTO player_events (server_id, player_name, type, detail) VALUES (?, ?, 'death', ?)`).run(serverId, m[1], detail);
          return;
        }
      }
    }
  } catch {
    // Never crash the log stream due to parsing errors
  }
}

// serverId -> cleanup fn (peut être un timer ou un vrai stream)
const activeStreams = new Map();

function setupLogsSocket(io) {
  io.on('connection', socket => {
    socket.on('logs:subscribe', async ({ serverId }) => {
      if (!serverId) return;
      socket.join(`server:${serverId}`);

      // Envoie les 200 dernières lignes à ce seul client (catch-up historique)
      const db = getDb();
      const srv = db.prepare('SELECT container_id FROM servers WHERE id = ?').get(serverId);
      if (srv?.container_id) {
        dockerService.getRecentLogs(srv.container_id, 200).then(lines => {
          lines.forEach(line => socket.emit('log', { serverId, line, timestamp: Date.now() }));
        }).catch(() => {});
      }

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
  if (attempt === 0 && activeStreams.has(serverId)) return; // already streaming
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

  // since: maintenant → pas de relecture des anciens logs (évite les doublons d'events joueurs)
  const since = Math.floor(Date.now() / 1000);
  const stopStream = dockerService.streamContainerLogs(
    server.container_id,
    line => {
      io.to(`server:${serverId}`).emit('log', { serverId, line, timestamp: Date.now() });
      parsePlayerEvent(serverId, line);
      if (line.includes(']: Done (') || line.includes(': Done (')) {
        const changed = db.prepare('UPDATE servers SET status = ? WHERE id = ? AND status = ?')
          .run('running', serverId, 'starting');
        if (changed.changes > 0) {
          io.emit('server:status', { serverId, status: 'running' });
        }
      }
    },
    err => {
      console.error(`[Logs] Erreur stream ${serverId.slice(0, 8)}:`, err.message);
      activeStreams.delete(serverId);
      if (err.message && err.message.includes('no such container')) {
        const db = getDb();
        db.prepare("UPDATE servers SET status = 'error' WHERE id = ? AND status IN ('starting', 'running')")
          .run(serverId);
        io.emit('server:status', { serverId, status: 'error' });
      }
    },
    () => {
      const db = getDb();
      const changed = db.prepare("UPDATE servers SET status = 'stopped' WHERE id = ? AND status = 'running'")
        .run(serverId);
      if (changed.changes > 0) {
        io.emit('server:status', { serverId, status: 'stopped' });
      }
      // Tous les joueurs sont offline quand le serveur s'arrête
      db.prepare('UPDATE players SET is_online = 0 WHERE server_id = ?').run(serverId);
      activeStreams.delete(serverId);
    },
    { since }
  );

  activeStreams.set(serverId, () => {
    stopStream();
    activeStreams.delete(serverId);
  });
}

function stopLogStream(serverId) {
  const cleanup = activeStreams.get(serverId);
  if (cleanup) cleanup();
}

module.exports = { setupLogsSocket, startLogStream, setIo };
