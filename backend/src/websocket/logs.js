const { getDb } = require('../config/database');
const dockerService = require('../services/docker');
const metrics = require('../services/metrics');

// serverId -> cleanup fn
const activeStreams = new Map();
// serverId -> string[] (ring buffer, dernières 500 lignes)
const logBuffers = new Map();

const BUFFER_SIZE = 500;

function bufferLine(serverId, line) {
  if (!logBuffers.has(serverId)) logBuffers.set(serverId, []);
  const buf = logBuffers.get(serverId);
  buf.push(line);
  if (buf.length > BUFFER_SIZE) buf.shift();
}

// ─── Player event parsing ─────────────────────────────────────────────────────
// Cache UUID: serverId -> { playerName -> uuid }
const uuidCache = {};

function parsePlayerEvent(serverId, line) {
  try {
    const db = getDb();

    // UUID mapping
    const uuidMatch = line.match(/UUID of player (\S+) is ([0-9a-f-]{36})/i);
    if (uuidMatch) {
      if (!uuidCache[serverId]) uuidCache[serverId] = {};
      uuidCache[serverId][uuidMatch[1]] = uuidMatch[2];
      return null;
    }

    // Join
    const joinMatch = line.match(/\]: (\S+) joined the game/) || line.match(/\]: (\S+)\[.*\] logged in/);
    if (joinMatch) {
      const username = joinMatch[1];
      const uuid = uuidCache[serverId]?.[username] || null;
      db.prepare(`
        INSERT INTO players (server_id, username, uuid, online, first_seen, last_seen)
        VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))
        ON CONFLICT(server_id, username) DO UPDATE SET
          online = 1, last_seen = datetime('now'),
          uuid = COALESCE(excluded.uuid, uuid)
      `).run(serverId, username, uuid);
      db.prepare(`INSERT INTO player_events (server_id, player_name, type) VALUES (?, ?, 'join')`).run(serverId, username);
      return { type: 'join', username, uuid };
    }

    // Leave
    const leaveMatch = line.match(/\]: (\S+) left the game/) || line.match(/\]: (\S+) lost connection/);
    if (leaveMatch) {
      const username = leaveMatch[1];
      db.prepare(`UPDATE players SET online = 0, last_seen = datetime('now') WHERE server_id = ? AND username = ?`).run(serverId, username);
      db.prepare(`INSERT INTO player_events (server_id, player_name, type) VALUES (?, ?, 'leave')`).run(serverId, username);
      return { type: 'leave', username };
    }

    // Command
    const cmdMatch = line.match(/\]: (\S+) issued server command: (.+)/);
    if (cmdMatch) {
      db.prepare(`INSERT INTO player_events (server_id, player_name, type, detail) VALUES (?, ?, 'command', ?)`).run(serverId, cmdMatch[1], cmdMatch[2]);
      return { type: 'command', username: cmdMatch[1], detail: cmdMatch[2] };
    }

    // Chat
    const chatMatch = line.match(/\]: <(\S+)> (.+)/);
    if (chatMatch) {
      db.prepare(`INSERT INTO player_events (server_id, player_name, type, detail) VALUES (?, ?, 'chat', ?)`).run(serverId, chatMatch[1], chatMatch[2]);
      return { type: 'chat', username: chatMatch[1], detail: chatMatch[2] };
    }

    // Death (patterns courants NeoForge/Vanilla)
    const deathPatterns = [
      /\]: (\S+) was (slain|killed|blown|shot|fireballed|pummeled|squashed|obliterated|impaled|skewered|struck|burned|drowned|suffocated|starved|hit|pricked|walked|froze|fell|died|crushed|went up in flames|tried to swim in lava).*/i,
      /\]: (\S+) fell (from|off|out|into).*/i,
      /\]: (\S+) drowned.*/i,
      /\]: (\S+) burned to death.*/i,
      /\]: (\S+) blew up.*/i,
      /\]: (\S+) hit the ground too hard.*/i,
      /\]: (\S+) suffocated in a wall.*/i,
      /\]: (\S+) starved to death.*/i,
    ];
    for (const pat of deathPatterns) {
      const m = line.match(pat);
      if (m) {
        const username = m[1];
        const existing = db.prepare('SELECT id FROM players WHERE server_id = ? AND username = ?').get(serverId, username);
        if (existing) {
          const detail = line.replace(/.*\]: /, '');
          db.prepare(`INSERT INTO player_events (server_id, player_name, type, detail) VALUES (?, ?, 'death', ?)`).run(serverId, username, detail);
          return { type: 'death', username, detail };
        }
      }
    }
  } catch {
    // never crash the log stream
  }
  return null;
}

function emitPlayersUpdate(io, serverId) {
  try {
    const db = getDb();
    const players = db.prepare(
      'SELECT username, uuid, online, first_seen, last_seen FROM players WHERE server_id = ? ORDER BY online DESC, last_seen DESC'
    ).all(serverId);
    io.to(`server:${serverId}`).emit('players:update', { serverId, players });
  } catch { /* ignore */ }
}

// ─── Socket setup ─────────────────────────────────────────────────────────────
function setupLogsSocket(io) {
  io.on('connection', socket => {
    socket.on('logs:subscribe', async ({ serverId }) => {
      if (!serverId) return;
      socket.join(`server:${serverId}`);

      // Rejouer le buffer uniquement à CE client (pas à la room entière → évite les doublons)
      const buf = logBuffers.get(serverId) || [];
      for (const line of buf) {
        socket.emit('log', { serverId, line, timestamp: 0 });
      }

      // Démarrer le stream si pas encore actif
      if (!activeStreams.has(serverId)) {
        startLogStream(io, serverId);
      }

      // Push immédiat des métriques et de la liste joueurs
      metrics.pushImmediate(socket, serverId);
      emitPlayersUpdate(io, serverId);
    });

    socket.on('logs:unsubscribe', ({ serverId }) => {
      socket.leave(`server:${serverId}`);
    });

    socket.on('disconnect', async () => {
      for (const [serverId] of activeStreams) {
        const room = `server:${serverId}`;
        const sockets = await io.in(room).fetchSockets();
        if (sockets.length === 0) stopLogStream(serverId);
      }
    });
  });
}

// ─── Stream ───────────────────────────────────────────────────────────────────
function startLogStream(io, serverId, attempt = 0) {
  const db = getDb();
  const server = db.prepare('SELECT container_id FROM servers WHERE id = ?').get(serverId);

  if (!server?.container_id) {
    if (attempt >= 40) {
      console.warn(`[Logs] Abandon stream ${serverId.slice(0, 8)} après ${attempt} tentatives`);
      activeStreams.delete(serverId);
      return;
    }
    const timer = setTimeout(() => startLogStream(io, serverId, attempt + 1), 3000);
    activeStreams.set(serverId, () => { clearTimeout(timer); activeStreams.delete(serverId); });
    return;
  }

  console.log(`[Logs] Démarrage stream pour serveur ${serverId.slice(0, 8)} (tentative ${attempt + 1})`);

  // On démarre le stream SANS tail (les historiques sont dans logBuffers)
  // Si le buffer est vide (premier démarrage), on utilise tail:200 une seule fois
  const useTail = (logBuffers.get(serverId) || []).length === 0;

  dockerService.streamContainerLogs(
    server.container_id,
    line => {
      bufferLine(serverId, line);
      io.to(`server:${serverId}`).emit('log', { serverId, line, timestamp: Date.now() });

      // Transition starting → running
      if (line.includes(']: Done (') || line.includes(': Done (')) {
        db.prepare('UPDATE servers SET status = ? WHERE id = ? AND status = ?').run('running', serverId, 'starting');
      }

      // Parser les événements joueurs
      const event = parsePlayerEvent(serverId, line);
      if (event && ['join', 'leave', 'death', 'command'].includes(event.type)) {
        emitPlayersUpdate(io, serverId);
      }
    },
    err => {
      console.error(`[Logs] Erreur stream ${serverId.slice(0, 8)}:`, err.message);
      activeStreams.delete(serverId);
      if (err.message && err.message.includes('no such container')) {
        db.prepare("UPDATE servers SET status = 'error' WHERE id = ? AND status IN ('starting', 'running')").run(serverId);
        io.to(`server:${serverId}`).emit('server:status', { serverId, status: 'error' });
      }
    },
    useTail
  );

  activeStreams.set(serverId, () => { activeStreams.delete(serverId); });
}

function stopLogStream(serverId) {
  const cleanup = activeStreams.get(serverId);
  if (cleanup) cleanup();
}

module.exports = { setupLogsSocket, emitPlayersUpdate };
