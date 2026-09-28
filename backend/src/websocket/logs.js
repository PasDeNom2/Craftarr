const { getDb } = require('../config/database');
const dockerService = require('../services/docker');
const metrics = require('../services/metrics');
const { createDiagnoser } = require('../services/logDiagnostics');

// Lignes produites par le relevé RCON de Craftarr (joueurs/TPS toutes les 15 s). Sur un serveur
// calme, elles remplissaient à elles seules les 200 dernières lignes : la console restait vide.
const RCON_NOISE = /Thread RCON (Client|Listener)|\[minecraft\/RconClient\]|RCON Client \/[\d.:]+ (started|shutting down)/;
const RECENT_LINES = 300;

// ─── Player log parsing ───────────────────────────────────────────────────────
// Cache UUID: serverId -> { playerName -> uuid }
const uuidCache = {};

let _io = null;
function setIo(io) { _io = io; }

// Raison de déconnexion (« lost connection: Timed out ») : la ligne arrive juste avant « left the game »
const pendingReason = {};

// ─── Sessions ─────────────────────────────────────────────────
function openSession(db, serverId, username) {
  // Une session restée ouverte (déconnexion manquée) est close maintenant
  db.prepare("UPDATE player_sessions SET left_at = datetime('now'), reason = COALESCE(reason, 'unknown') WHERE server_id = ? AND username = ? AND left_at IS NULL")
    .run(serverId, username);
  db.prepare("INSERT INTO player_sessions (server_id, username, joined_at) VALUES (?, ?, datetime('now'))").run(serverId, username);
}
function closeSession(db, serverId, username, reason) {
  db.prepare("UPDATE player_sessions SET left_at = datetime('now'), reason = ? WHERE server_id = ? AND username = ? AND left_at IS NULL")
    .run(reason || null, serverId, username);
}
/** Ferme toutes les sessions ouvertes d'un serveur (arrêt, crash) ou seulement celles des joueurs absents. */
function closeAllSessions(serverId, reason, keepOnline = null) {
  const db = getDb();
  const open = db.prepare('SELECT username FROM player_sessions WHERE server_id = ? AND left_at IS NULL').all(serverId);
  for (const { username } of open) {
    if (keepOnline && keepOnline.has(username)) continue;
    closeSession(db, serverId, username, reason);
    db.prepare('UPDATE players SET is_online = 0 WHERE server_id = ? AND username = ?').run(serverId, username);
  }
}

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

    // « Steve[/1.2.3.4:5678] logged in with entity id 123 at (x, y, z) »
    const loginMatch = line.match(/\]: (\w{2,16})\[\/([^\]:]+(?::\d+)?)\] logged in with entity id/);
    if (loginMatch) {
      const ip = loginMatch[2].replace(/:\d+$/, '');
      db.prepare('UPDATE players SET last_ip = ? WHERE server_id = ? AND username = ?').run(ip, serverId, loginMatch[1]);
      (pendingReason[serverId] ||= {})['ip:' + loginMatch[1]] = ip;
      return;
    }

    // « Steve lost connection: Timed out »
    const lostMatch = line.match(/\]: (\w{2,16}) lost connection: (.+)$/);
    if (lostMatch) {
      (pendingReason[serverId] ||= {})[lostMatch[1]] = lostMatch[2].trim().slice(0, 200);
      return;
    }

    // Succès : « Steve has made the advancement [Stone Age] »
    const advMatch = line.match(/\]: (\w{2,16}) has (?:made the advancement|completed the challenge|reached the goal) \[(.+)\]/);
    if (advMatch) {
      db.prepare(`INSERT INTO player_events (server_id, player_name, type, detail) VALUES (?, ?, 'advancement', ?)`).run(serverId, advMatch[1], advMatch[2]);
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
      const ip = pendingReason[serverId]?.['ip:' + username];
      if (ip) { db.prepare('UPDATE players SET last_ip = ? WHERE server_id = ? AND username = ?').run(ip, serverId, username); delete pendingReason[serverId]['ip:' + username]; }
      db.prepare(`INSERT INTO player_events (server_id, player_name, type, detail) VALUES (?, ?, 'join', NULL)`).run(serverId, username);
      openSession(db, serverId, username);
      _io?.emit('player:status', { serverId, username, is_online: 1 });
      return;
    }

    // Leave event
    const leaveMatch = line.match(/\]: (\S+) left the game/);
    if (leaveMatch) {
      const username = leaveMatch[1];
      const reason = pendingReason[serverId]?.[username] || null;
      if (pendingReason[serverId]) delete pendingReason[serverId][username];
      db.prepare(`UPDATE players SET is_online = 0, last_seen = datetime('now') WHERE server_id = ? AND username = ?`).run(serverId, username);
      db.prepare(`INSERT INTO player_events (server_id, player_name, type, detail) VALUES (?, ?, 'leave', ?)`).run(serverId, username, reason);
      closeSession(db, serverId, username, reason);
      _io?.emit('player:status', { serverId, username, is_online: 0 });
      return;
    }

    // Chat message: [Server thread/INFO]: <PlayerName> message
    const chatMatch = line.match(/\]: (?:\[Not Secure\] )?<(\S+)> (.+)/);
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
      const alreadySubscribed = socket.rooms.has(`server:${serverId}`);
      socket.join(`server:${serverId}`);

      // Envoie les 200 dernières lignes uniquement au premier abonnement (évite les doublons)
      if (!alreadySubscribed) {
        const db = getDb();
        const srv = db.prepare('SELECT container_id FROM servers WHERE id = ?').get(serverId);
        if (srv?.container_id) {
          // On remonte loin puis on retire le bruit RCON pour envoyer les vraies dernières lignes
          dockerService.getRecentLogs(srv.container_id, 5000).then(lines => {
            lines.filter(l => !RCON_NOISE.test(l)).slice(-RECENT_LINES)
              .forEach(line => socket.emit('log', { serverId, line, timestamp: Date.now() }));
          }).catch(() => {});
        }
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

  });

  // Filet de sécurité : tout serveur en marche doit avoir son flux (événements joueurs, statut),
  // même si le flux a été coupé (erreur Docker, redémarrage automatique du container…)
  setInterval(() => {
    try {
      const running = getDb().prepare("SELECT id FROM servers WHERE status IN ('starting', 'running') AND container_id IS NOT NULL").all();
      for (const { id } of running) if (!activeStreams.has(id)) startLogStream(io, id);
    } catch {}
  }, 60_000).unref();
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
  const diagnose = createDiagnoser();
  const stopStream = dockerService.streamContainerLogs(
    server.container_id,
    line => {
      if (RCON_NOISE.test(line)) return;
      io.to(`server:${serverId}`).emit('log', { serverId, line, timestamp: Date.now() });
      const hint = diagnose(line);
      if (hint) {
        console.warn(`[Logs] ${serverId.slice(0, 8)} ${hint}`);
        io.to(`server:${serverId}`).emit('log', { serverId, line: hint, timestamp: Date.now() });
      }
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
      closeAllSessions(serverId, 'server_stop');
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

module.exports = { setupLogsSocket, startLogStream, setIo, closeAllSessions, parsePlayerEvent };
