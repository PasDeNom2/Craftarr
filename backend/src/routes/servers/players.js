// Joueurs (historique, kick/ban/op) et whitelist.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../../config/database');
const authMiddleware = require('../../middleware/auth');
const { DATA_PATH } = require('./common');
const playerData = require('../../services/playerData');

// Durée d'une session en secondes (session ouverte = jusqu'à maintenant)
const DURATION_SQL = "(strftime('%s', COALESCE(left_at, datetime('now'))) - strftime('%s', joined_at))";

const router = express.Router();

// ─── Players ──────────────────────────────────────────────────────────────────

// Sync is_op depuis ops.json pour un serveur donné
function syncOpsFromFile(serverId) {
  try {
    const db = getDb();
    const opsPath = path.join(DATA_PATH, 'servers', serverId, 'server', 'ops.json');
    if (!fs.existsSync(opsPath)) return;
    const ops = JSON.parse(fs.readFileSync(opsPath, 'utf8'));
    const opNames = new Set(ops.map(o => (o.name || '').toLowerCase()));
    // Reset all then set ops
    db.prepare('UPDATE players SET is_op = 0 WHERE server_id = ?').run(serverId);
    for (const name of opNames) {
      if (name) db.prepare('UPDATE players SET is_op = 1 WHERE server_id = ? AND LOWER(username) = ?').run(serverId, name);
    }
  } catch {}
}

// GET /api/servers/:id/players
router.get('/:id/players', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT id FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });
    syncOpsFromFile(req.params.id);
    const players = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM player_events WHERE server_id = p.server_id AND player_name = p.username) AS event_count,
        (SELECT COUNT(*) FROM player_events WHERE server_id = p.server_id AND player_name = p.username AND type = 'join') AS join_count,
        (SELECT COUNT(*) FROM player_events WHERE server_id = p.server_id AND player_name = p.username AND type = 'death') AS death_count,
        (SELECT COALESCE(SUM(${DURATION_SQL}), 0) FROM player_sessions WHERE server_id = p.server_id AND username = p.username) AS playtime_seconds,
        (SELECT COUNT(*) FROM player_sessions WHERE server_id = p.server_id AND username = p.username) AS session_count,
        (SELECT joined_at FROM player_sessions WHERE server_id = p.server_id AND username = p.username AND left_at IS NULL ORDER BY id DESC LIMIT 1) AS online_since
      FROM players p WHERE p.server_id = ? ORDER BY p.is_online DESC, p.last_seen DESC
    `).all(req.params.id);
    res.json(players);
  } catch (err) { next(err); }
});

// GET /api/servers/:id/players/overview?days=30 — vue d'ensemble : totaux + sessions de la période
// (les graphiques par jour / heure sont calculés côté navigateur, dans le fuseau de l'utilisateur)
router.get('/:id/players/overview', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const id = req.params.id;
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
    const since = `-${days} days`;
    const totals = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM players WHERE server_id = ?) AS players,
        (SELECT COUNT(*) FROM players WHERE server_id = ? AND is_online = 1) AS online,
        (SELECT COUNT(*) FROM players WHERE server_id = ? AND first_seen >= datetime('now', ?)) AS new_players,
        (SELECT COALESCE(SUM(${DURATION_SQL}), 0) FROM player_sessions WHERE server_id = ?) AS playtime_all,
        (SELECT COUNT(*) FROM player_sessions WHERE server_id = ?) AS sessions_all,
        (SELECT COUNT(*) FROM player_events WHERE server_id = ? AND type = 'death' AND timestamp >= datetime('now', ?)) AS deaths,
        (SELECT COUNT(*) FROM player_events WHERE server_id = ? AND type = 'chat' AND timestamp >= datetime('now', ?)) AS messages,
        (SELECT COUNT(*) FROM player_events WHERE server_id = ? AND type = 'advancement' AND timestamp >= datetime('now', ?)) AS advancements
    `).get(id, id, id, since, id, id, id, since, id, since, id, since);
    const sessions = db.prepare(`
      SELECT username, joined_at, left_at, reason FROM player_sessions
      WHERE server_id = ? AND (left_at IS NULL OR left_at >= datetime('now', ?))
      ORDER BY joined_at LIMIT 20000
    `).all(id, since);
    const newPlayers = db.prepare(`SELECT username, first_seen FROM players WHERE server_id = ? AND first_seen >= datetime('now', ?)`).all(id, since);

    // Pic de joueurs simultanés (toutes périodes confondues)
    const edges = [];
    for (const r of db.prepare('SELECT joined_at, left_at FROM player_sessions WHERE server_id = ?').all(id)) {
      edges.push([r.joined_at, 1], [r.left_at || '9999', -1]);
    }
    edges.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
    let cur = 0, peak = 0, peakAt = null;
    for (const [t, d] of edges) { cur += d; if (cur > peak) { peak = cur; peakAt = t; } }

    res.json({ days, totals: { ...totals, peak, peak_at: peakAt }, sessions, newPlayers });
  } catch (err) { next(err); }
});

// GET /api/servers/:id/players/:username/profile — fiche complète d'un joueur
router.get('/:id/players/:username/profile', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const { id, username } = req.params;
    const player = db.prepare('SELECT * FROM players WHERE server_id = ? AND username = ?').get(id, username);
    if (!player) return res.status(404).json({ error: 'Joueur introuvable' });
    syncOpsFromFile(id);
    const summary = db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(${DURATION_SQL}), 0) AS total, COALESCE(MAX(${DURATION_SQL}), 0) AS longest,
             MIN(joined_at) AS first, MAX(joined_at) AS last
      FROM player_sessions WHERE server_id = ? AND username = ?
    `).get(id, username);
    const sessions = db.prepare(`
      SELECT id, joined_at, left_at, reason, ${DURATION_SQL} AS duration FROM player_sessions
      WHERE server_id = ? AND username = ? ORDER BY id DESC LIMIT 500
    `).all(id, username);
    const eventCounts = Object.fromEntries(db.prepare(`
      SELECT type, COUNT(*) AS n FROM player_events WHERE server_id = ? AND player_name = ? GROUP BY type
    `).all(id, username).map(r => [r.type, r.n]));
    const world = playerData.readPlayerWorldData(id, username, player.uuid);
    if (!player.uuid && world.uuid) db.prepare('UPDATE players SET uuid = ? WHERE id = ?').run(world.uuid, player.id);
    res.json({
      player: { ...player, is_op: db.prepare('SELECT is_op FROM players WHERE id = ?').get(player.id).is_op, uuid: player.uuid || world.uuid },
      sessions: { ...summary, list: sessions },
      eventCounts,
      world,
    });
  } catch (err) { next(err); }
});

// GET /api/servers/:id/players/:username/events?type=chat&q=&before=<id>&limit=100
router.get('/:id/players/:username/events', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const where = ['server_id = ?', 'player_name = ?'];
    const args = [req.params.id, req.params.username];
    if (req.query.type) {
      const types = String(req.query.type).split(',').filter(Boolean).slice(0, 12);
      where.push(`type IN (${types.map(() => '?').join(',')})`);
      args.push(...types);
    }
    if (req.query.q) { where.push('detail LIKE ?'); args.push(`%${String(req.query.q).slice(0, 100)}%`); }
    if (req.query.before) { where.push('id < ?'); args.push(parseInt(req.query.before) || 0); }
    const offset = parseInt(req.query.offset) || 0;
    const events = db.prepare(`
      SELECT * FROM player_events WHERE ${where.join(' AND ')}
      ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(...args, limit, offset);
    res.json(events);
  } catch (err) { next(err); }
});

// POST /api/servers/:id/players/:username/kick
router.post('/:id/players/:username/kick', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });
    const { reason = 'Kicked by admin' } = req.body;
    const rcon = require('../../services/rcon');
    await rcon.sendCommand(server, `kick ${req.params.username} ${reason}`);
    db.prepare(`INSERT INTO player_events (server_id, player_name, type, detail) VALUES (?, ?, 'kick', ?)`).run(req.params.id, req.params.username, reason);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/servers/:id/players/:username/warn
router.post('/:id/players/:username/warn', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });
    const { reason = 'Warning from admin' } = req.body;
    const rcon = require('../../services/rcon');
    // Send warning message in-game if server is running
    if (server.status === 'running') {
      await rcon.sendCommand(server, `tell ${req.params.username} [WARNING] ${reason}`).catch(() => {});
    }
    db.prepare(`INSERT INTO player_events (server_id, player_name, type, detail) VALUES (?, ?, 'warn', ?)`).run(req.params.id, req.params.username, reason);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/servers/:id/players/:username/ban
router.post('/:id/players/:username/ban', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });
    const { reason = 'Banned by admin' } = req.body;
    const rcon = require('../../services/rcon');
    if (server.status === 'running') {
      await rcon.sendCommand(server, `ban ${req.params.username} ${reason}`).catch(() => {});
    }
    db.prepare('UPDATE players SET is_banned = 1, ban_reason = ? WHERE server_id = ? AND username = ?').run(reason, req.params.id, req.params.username);
    db.prepare(`INSERT INTO player_events (server_id, player_name, type, detail) VALUES (?, ?, 'ban', ?)`).run(req.params.id, req.params.username, reason);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

function writeOpsFile(serverId, ops) {
  try {
    const opsPath = path.join(DATA_PATH, 'servers', serverId, 'server', 'ops.json');
    fs.writeFileSync(opsPath, JSON.stringify(ops, null, 2));
  } catch {}
}

function readOpsFile(serverId) {
  try {
    const opsPath = path.join(DATA_PATH, 'servers', serverId, 'server', 'ops.json');
    if (!fs.existsSync(opsPath)) return [];
    return JSON.parse(fs.readFileSync(opsPath, 'utf8'));
  } catch { return []; }
}

// POST /api/servers/:id/players/:username/op
router.post('/:id/players/:username/op', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });
    const username = req.params.username;
    const rcon = require('../../services/rcon');
    if (server.status === 'running') {
      await rcon.sendCommand(server, `op ${username}`).catch(() => {});
    }
    // Mettre à jour ops.json directement pour rester cohérent avec syncOpsFromFile
    const ops = readOpsFile(req.params.id);
    if (!ops.some(o => o.name?.toLowerCase() === username.toLowerCase())) {
      ops.push({ uuid: '', name: username, level: 4, bypassesPlayerLimit: false });
      writeOpsFile(req.params.id, ops);
    }
    db.prepare('UPDATE players SET is_op = 1 WHERE server_id = ? AND username = ?').run(req.params.id, username);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/servers/:id/players/:username/op
router.delete('/:id/players/:username/op', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });
    const username = req.params.username;
    const rcon = require('../../services/rcon');
    if (server.status === 'running') {
      await rcon.sendCommand(server, `deop ${username}`).catch(() => {});
    }
    // Retirer du ops.json immédiatement pour que syncOpsFromFile ne remette pas is_op=1
    const ops = readOpsFile(req.params.id).filter(o => o.name?.toLowerCase() !== username.toLowerCase());
    writeOpsFile(req.params.id, ops);
    db.prepare('UPDATE players SET is_op = 0 WHERE server_id = ? AND username = ?').run(req.params.id, username);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/servers/:id/players/:username/ban
router.delete('/:id/players/:username/ban', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });
    const rcon = require('../../services/rcon');
    if (server.status === 'running') {
      await rcon.sendCommand(server, `pardon ${req.params.username}`).catch(() => {});
    }
    db.prepare('UPDATE players SET is_banned = 0, ban_reason = NULL WHERE server_id = ? AND username = ?').run(req.params.id, req.params.username);
    db.prepare(`INSERT INTO player_events (server_id, player_name, type, detail) VALUES (?, ?, 'unban', NULL)`).run(req.params.id, req.params.username);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /api/servers/:id/whitelist
router.get('/:id/whitelist', authMiddleware, (req, res) => {
  const db = getDb();
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Not found' });
  const whitelistPath = path.join(DATA_PATH, 'servers', server.id, 'server', 'whitelist.json');
  try {
    const data = fs.existsSync(whitelistPath) ? JSON.parse(fs.readFileSync(whitelistPath, 'utf8')) : [];
    res.json(data);
  } catch {
    res.json([]);
  }
});

// POST /api/servers/:id/whitelist
router.post('/:id/whitelist', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Not found' });
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });

    // Fetch UUID from Mojang
    let uuid = '00000000-0000-0000-0000-000000000000';
    try {
      const mojang = await fetch(`https://api.mojang.com/users/profiles/minecraft/${username}`);
      if (mojang.ok) {
        const data = await mojang.json();
        const raw = data.id;
        uuid = `${raw.slice(0,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}-${raw.slice(16,20)}-${raw.slice(20)}`;
      }
    } catch { /* offline mode — keep zeroed UUID */ }

    const whitelistPath = path.join(DATA_PATH, 'servers', server.id, 'server', 'whitelist.json');
    let list = [];
    try { list = fs.existsSync(whitelistPath) ? JSON.parse(fs.readFileSync(whitelistPath, 'utf8')) : []; } catch { list = []; }
    if (!list.find(p => p.name.toLowerCase() === username.toLowerCase())) {
      list.push({ uuid, name: username });
      fs.mkdirSync(path.dirname(whitelistPath), { recursive: true });
      fs.writeFileSync(whitelistPath, JSON.stringify(list, null, 2));
    }

    if (server.status === 'running') {
      const rcon = require('../../services/rcon');
      await rcon.sendCommand(server, `whitelist add ${username}`).catch(() => {});
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/servers/:id/whitelist/:username
router.delete('/:id/whitelist/:username', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Not found' });
    const { username } = req.params;

    const whitelistPath = path.join(DATA_PATH, 'servers', server.id, 'server', 'whitelist.json');
    let list = [];
    try { list = fs.existsSync(whitelistPath) ? JSON.parse(fs.readFileSync(whitelistPath, 'utf8')) : []; } catch { list = []; }
    list = list.filter(p => p.name.toLowerCase() !== username.toLowerCase());
    fs.writeFileSync(whitelistPath, JSON.stringify(list, null, 2));

    if (server.status === 'running') {
      const rcon = require('../../services/rcon');
      await rcon.sendCommand(server, `whitelist remove ${username}`).catch(() => {});
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
