const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../config/database');
const authMiddleware = require('../middleware/auth');
const dockerService = require('../services/docker');
const installer = require('../services/installer');
const backupService = require('../services/backup');
const updater = require('../services/updater');

const DATA_PATH = process.env.DATA_PATH || '/data';

// Multer pour l'upload de fichiers (world zip)
let multer;
try { multer = require('multer'); } catch { multer = null; }

function getUpload() {
  if (!multer) return null;
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(DATA_PATH, 'servers', req.params.id, 'uploads');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, 'world-import.zip'),
  });
  return multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } }); // 2 Go max
}

const router = express.Router();

function formatServer(row) {
  return {
    ...row,
    whitelist_enabled: !!row.whitelist_enabled,
    online_mode: row.online_mode !== 0,
    auto_update: !!row.auto_update,
  };
}

// GET /api/servers
router.get('/', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const servers = db.prepare('SELECT * FROM servers ORDER BY created_at DESC').all();

    // Mise à jour statut depuis Docker
    const updated = await Promise.all(servers.map(async s => {
      if (!s.container_id) return formatServer(s);
      try {
        const status = await dockerService.getContainerStatus(s.container_id);
        const mappedStatus = mapDockerStatus(status, s.status);
        if (mappedStatus !== s.status && !['installing', 'updating'].includes(s.status)) {
          db.prepare('UPDATE servers SET status = ? WHERE id = ?').run(mappedStatus, s.id);
          return formatServer({ ...s, status: mappedStatus });
        }
      } catch {}
      return formatServer(s);
    }));

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// GET /api/servers/:id
router.get('/:id', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });
    res.json(formatServer(server));
  } catch (err) {
    next(err);
  }
});

// POST /api/servers — Déploiement d'un nouveau serveur
router.post('/', authMiddleware, async (req, res, next) => {
  try {
    const {
      name, modpack_id, modpack_name, modpack_source, modpack_version, modpack_version_id,
      port, ram_mb = 4096, max_players = 20, seed, whitelist_enabled = false,
      mc_version, loader_type = 'forge', auto_update = false, online_mode = true,
    } = req.body;

    if (!name || !modpack_id || !modpack_source) {
      return res.status(400).json({ error: 'name, modpack_id et modpack_source sont requis' });
    }

    const db = getDb();
    const assignedPort = port || findFreePort(db);
    const rconPort = assignedPort + 10;
    const rconPassword = uuidv4().replace(/-/g, '').slice(0, 16);
    const id = uuidv4();

    db.prepare(`
      INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, modpack_version,
        modpack_version_id, port, rcon_port, rcon_password, ram_mb, max_players, seed,
        whitelist_enabled, online_mode, status, mc_version, loader_type, auto_update)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'installing', ?, ?, ?)
    `).run(id, name, modpack_id, modpack_name || modpack_id, modpack_source, modpack_version || null,
      modpack_version_id || null, assignedPort, rconPort, rconPassword, ram_mb, max_players,
      seed || null, whitelist_enabled ? 1 : 0, online_mode ? 1 : 0,
      (mc_version && /^1\.\d{1,2}(\.\d{1,2})?$/.test(mc_version) ? mc_version : null),
      loader_type, auto_update ? 1 : 0);

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
    res.status(201).json(formatServer(server));

    // Lancement async de l'installation
    installer.installServer(server).catch(err => {
      console.error(`[Installer] Erreur serveur ${id}:`, err.message);
      db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('error', id);
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/servers/:id/install-mods — Télécharge les mods manquants sans recréer le container
router.post('/:id/install-mods', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });

    res.json({ ok: true, message: 'Téléchargement des mods lancé en arrière-plan' });

    const installer = require('../services/installer');
    const serverDir = path.join(DATA_PATH, 'servers', server.id, 'server');
    const modsDir = path.join(serverDir, 'mods');
    fs.mkdirSync(modsDir, { recursive: true });

    // Stop server if running
    let wasRunning = false;
    if (server.container_id && ['running', 'starting'].includes(server.status)) {
      wasRunning = true;
      await dockerService.stopContainer(server.container_id, 15).catch(() => {});
      db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('stopped', server.id);
    }

    installer.installModsOnly(server, serverDir, modsDir)
      .then(async () => {
        console.log(`[install-mods] Mods installés pour ${server.id}`);
        if (wasRunning && server.container_id) {
          await dockerService.startContainer(server.container_id);
          db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('starting', server.id);
        }
      })
      .catch(err => console.error(`[install-mods] Erreur:`, err.message));
  } catch (err) {
    next(err);
  }
});

// POST /api/servers/:id/recreate — Recrée le container Docker (ex: après changement de RAM/port ou pour forcer le téléchargement des mods)
router.post('/:id/recreate', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });

    // Arrêt et suppression de l'ancien container
    if (server.container_id) {
      await dockerService.removeContainer(server.container_id).catch(() => {});
    }

    db.prepare('UPDATE servers SET container_id = NULL, container_name = NULL, status = ? WHERE id = ?').run('stopped', server.id);
    const fresh = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);

    // Recréation avec les paramètres actuels (incluant CF_API_KEY, RAM, port)
    const { containerId, containerName } = await dockerService.createServerContainer(fresh);
    db.prepare('UPDATE servers SET container_id = ?, container_name = ?, status = ? WHERE id = ?')
      .run(containerId, containerName, 'starting', server.id);

    await dockerService.startContainer(containerId);
    res.json({ ok: true, status: 'starting' });
  } catch (err) {
    next(err);
  }
});

// POST /api/servers/:id/start
router.post('/:id/start', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });
    if (!server.container_id) return res.status(400).json({ error: 'Container non créé' });

    await dockerService.startContainer(server.container_id);
    db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('starting', server.id);
    res.json({ ok: true, status: 'starting' });
  } catch (err) {
    next(err);
  }
});

// POST /api/servers/:id/stop
router.post('/:id/stop', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });
    if (!server.container_id) return res.status(400).json({ error: 'Container non créé' });

    await dockerService.stopContainer(server.container_id);
    db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('stopped', server.id);
    res.json({ ok: true, status: 'stopped' });
  } catch (err) {
    next(err);
  }
});

// POST /api/servers/:id/restart
router.post('/:id/restart', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });
    if (!server.container_id) return res.status(400).json({ error: 'Container non créé' });

    await dockerService.restartContainer(server.container_id);
    db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('running', server.id);
    res.json({ ok: true, status: 'running' });
  } catch (err) {
    next(err);
  }
});

// POST /api/servers/:id/backup
router.post('/:id/backup', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });

    const backup = await backupService.createBackup(server, 'manual');
    res.json(backup);
  } catch (err) {
    next(err);
  }
});

// POST /api/servers/:id/rcon
router.post('/:id/rcon', authMiddleware, async (req, res, next) => {
  try {
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: 'Commande requise' });

    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });

    const rcon = require('../services/rcon');
    const response = await rcon.sendCommand(server, command);
    res.json({ response });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/servers/:id
router.delete('/:id', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });

    if (server.container_id) {
      await dockerService.removeContainer(server.container_id).catch(() => {});
    }
    db.prepare('DELETE FROM servers WHERE id = ?').run(server.id);

    // Suppression du dossier de données du serveur
    const serverDir = path.join(DATA_PATH, 'servers', server.id);
    try { fs.rmSync(serverDir, { recursive: true, force: true }); } catch (e) {
      console.warn(`[Delete] Impossible de supprimer ${serverDir}:`, e.message);
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/servers/:id/update — Mise à jour manuelle vers une version choisie (ou latest)
router.post('/:id/update', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });
    if (['installing', 'updating'].includes(server.status)) {
      return res.status(409).json({ error: 'Opération déjà en cours' });
    }

    const { version_id } = req.body; // optionnel : forcer une version précise

    // Si version_id fourni, on construit l'updateInfo manuellement
    if (version_id) {
      const { getModpackVersions } = require('../services/sourceAggregator');
      const versions = await getModpackVersions(server.modpack_source, server.modpack_id);
      const target = versions.find(v => String(v.id) === String(version_id));
      if (!target) return res.status(404).json({ error: 'Version introuvable' });

      const downloadUrl = target.downloadUrl || target.files?.find(f => f.primary)?.url || target.files?.[0]?.url;
      const updateInfo = {
        latestVersionId: String(target.id),
        latestVersion: target.displayName || target.versionNumber || target.name || String(target.id),
        downloadUrl,
        changelog: target.changelog || null,
      };
      res.json({ ok: true, message: 'Mise à jour lancée', version: updateInfo.latestVersion });
      updater.applyUpdate(server, updateInfo).catch(err =>
        console.error(`[Update manuel] Erreur serveur ${server.id}:`, err.message)
      );
    } else {
      // Vérifie si une version plus récente est disponible
      const updateInfo = await updater.checkServerUpdate(server);
      if (!updateInfo) {
        return res.json({ ok: true, upToDate: true, message: 'Déjà à jour' });
      }
      res.json({ ok: true, message: 'Mise à jour lancée', version: updateInfo.latestVersion });
      updater.applyUpdate(server, updateInfo).catch(err =>
        console.error(`[Update manuel] Erreur serveur ${server.id}:`, err.message)
      );
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/servers/:id/world-import — Import d'un dossier world (zip)
router.post('/:id/world-import', authMiddleware, async (req, res, next) => {
  const upload = getUpload();
  if (!upload) return res.status(500).json({ error: 'Module upload non disponible' });

  upload.single('world')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Fichier manquant' });

    try {
      const db = getDb();
      const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
      if (!server) return res.status(404).json({ error: 'Serveur introuvable' });

      const zipPath = req.file.path;
      const serverDir = path.join(DATA_PATH, 'servers', server.id, 'server');

      // Arrêt du serveur si nécessaire
      let wasRunning = false;
      if (server.container_id && server.status === 'running') {
        wasRunning = true;
        await dockerService.stopContainer(server.container_id, 15).catch(() => {});
        db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('stopped', server.id);
      }

      // Suppression des anciens worlds
      for (const dir of ['world', 'world_nether', 'world_the_end']) {
        const p = path.join(serverDir, dir);
        if (fs.existsSync(p)) fs.rmSync(p, { recursive: true });
      }
      fs.mkdirSync(serverDir, { recursive: true });

      // Extraction
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(serverDir, true);
      fs.unlinkSync(zipPath);

      // Redémarrage si était actif
      if (wasRunning && server.container_id) {
        await dockerService.startContainer(server.container_id);
        db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('running', server.id);
      }

      res.json({ ok: true, message: 'World importé avec succès' });
    } catch (e) {
      next(e);
    }
  });
});

// PATCH /api/servers/:id — Modifier les paramètres du serveur
router.patch('/:id', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });

    const allowed = ['name', 'port', 'ram_mb', 'max_players', 'whitelist_enabled', 'auto_update', 'update_interval_hours', 'motd', 'seed', 'difficulty', 'view_distance', 'spawn_protection'];
    const booleans = new Set(['whitelist_enabled', 'auto_update']);
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates[key] = booleans.has(key) ? (req.body[key] ? 1 : 0) : req.body[key];
      }
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Aucun champ modifiable fourni' });

    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE servers SET ${setClauses} WHERE id = ?`).run(...Object.values(updates), server.id);

    const updated = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);
    res.json(formatServer(updated));
  } catch (err) {
    next(err);
  }
});

// POST /api/servers/:id/icon — Upload de l'icône serveur (PNG 64x64)
router.post('/:id/icon', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });

    if (!multer) return res.status(501).json({ error: 'multer non disponible' });

    const upload = multer({
      storage: multer.diskStorage({
        destination: (req, file, cb) => {
          const dir = path.join(DATA_PATH, 'servers', server.id, 'server');
          fs.mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (req, file, cb) => cb(null, 'server-icon.png'),
      }),
      limits: { fileSize: 2 * 1024 * 1024 },
      fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) return cb(new Error('Fichier image requis'));
        cb(null, true);
      },
    }).single('icon');

    upload(req, res, err => {
      if (err) return next(err);
      if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
      res.json({ ok: true, message: 'Icône mise à jour. Redémarrez le serveur pour l\'appliquer.' });
    });
  } catch (err) {
    next(err);
  }
});

// ─── Players ──────────────────────────────────────────────────────────────────

// GET /api/servers/:id/players
router.get('/:id/players', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT id FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });
    const players = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM player_events WHERE server_id = p.server_id AND player_name = p.username) AS event_count,
        (SELECT COUNT(*) FROM player_events WHERE server_id = p.server_id AND player_name = p.username AND type = 'join') AS join_count
      FROM players p WHERE p.server_id = ? ORDER BY p.last_seen DESC
    `).all(req.params.id);
    res.json(players);
  } catch (err) { next(err); }
});

// GET /api/servers/:id/players/:username/events
router.get('/:id/players/:username/events', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = parseInt(req.query.offset) || 0;
    const events = db.prepare(`
      SELECT * FROM player_events
      WHERE server_id = ? AND player_name = ?
      ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(req.params.id, req.params.username, limit, offset);
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
    const rcon = require('../services/rcon');
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
    const rcon = require('../services/rcon');
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
    const rcon = require('../services/rcon');
    if (server.status === 'running') {
      await rcon.sendCommand(server, `ban ${req.params.username} ${reason}`).catch(() => {});
    }
    db.prepare('UPDATE players SET is_banned = 1, ban_reason = ? WHERE server_id = ? AND username = ?').run(reason, req.params.id, req.params.username);
    db.prepare(`INSERT INTO player_events (server_id, player_name, type, detail) VALUES (?, ?, 'ban', ?)`).run(req.params.id, req.params.username, reason);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/servers/:id/players/:username/ban
router.delete('/:id/players/:username/ban', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });
    const rcon = require('../services/rcon');
    if (server.status === 'running') {
      await rcon.sendCommand(server, `pardon ${req.params.username}`).catch(() => {});
    }
    db.prepare('UPDATE players SET is_banned = 0, ban_reason = NULL WHERE server_id = ? AND username = ?').run(req.params.id, req.params.username);
    db.prepare(`INSERT INTO player_events (server_id, player_name, type, detail) VALUES (?, ?, 'unban', NULL)`).run(req.params.id, req.params.username);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /api/servers/:id/icon — Renvoie l'icône serveur actuelle (pas d'auth : utilisé comme src d'img)
router.get('/:id/icon', (req, res) => {
  const db = getDb();
  const server = db.prepare('SELECT id FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).end();
  const iconPath = path.join(DATA_PATH, 'servers', server.id, 'server', 'server-icon.png');
  if (!fs.existsSync(iconPath)) return res.status(404).end();
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(iconPath).pipe(res);
});

// GET /api/servers/:id/files — Liste un répertoire dans le dossier serveur
router.get('/:id/files', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });

    const serverDir = path.join(DATA_PATH, 'servers', server.id, 'server');
    const reqPath = (req.query.path || '').replace(/\.\./g, ''); // Prevent path traversal
    const targetDir = path.join(serverDir, reqPath);

    if (!targetDir.startsWith(serverDir)) return res.status(403).json({ error: 'Accès refusé' });
    if (!fs.existsSync(targetDir)) return res.status(404).json({ error: 'Chemin introuvable' });

    const stat = fs.statSync(targetDir);
    if (!stat.isDirectory()) return res.status(400).json({ error: 'Ce chemin n\'est pas un dossier' });

    const entries = fs.readdirSync(targetDir, { withFileTypes: true }).map(e => ({
      name: e.name,
      isDir: e.isDirectory(),
      size: e.isFile() ? fs.statSync(path.join(targetDir, e.name)).size : null,
    })).sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    res.json({ path: reqPath, entries });
  } catch (err) {
    next(err);
  }
});

// GET /api/servers/:id/files/content — Lire un fichier texte
router.get('/:id/files/content', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });

    const serverDir = path.join(DATA_PATH, 'servers', server.id, 'server');
    const reqPath = (req.query.path || '').replace(/\.\./g, '');
    const targetFile = path.join(serverDir, reqPath);

    if (!targetFile.startsWith(serverDir)) return res.status(403).json({ error: 'Accès refusé' });
    if (!fs.existsSync(targetFile)) return res.status(404).json({ error: 'Fichier introuvable' });

    const stat = fs.statSync(targetFile);
    if (!stat.isFile()) return res.status(400).json({ error: 'Ce chemin n\'est pas un fichier' });
    if (stat.size > 2 * 1024 * 1024) return res.status(413).json({ error: 'Fichier trop grand (max 2 Mo)' });

    const content = fs.readFileSync(targetFile, 'utf8');
    res.json({ path: reqPath, content });
  } catch (err) {
    next(err);
  }
});

// PUT /api/servers/:id/files/content — Écrire un fichier texte
router.put('/:id/files/content', authMiddleware, (req, res, next) => {
  try {
    const { path: reqPath, content } = req.body;
    if (!reqPath || content === undefined) return res.status(400).json({ error: 'path et content requis' });

    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });

    const serverDir = path.join(DATA_PATH, 'servers', server.id, 'server');
    const safePath = reqPath.replace(/\.\./g, '');
    const targetFile = path.join(serverDir, safePath);

    if (!targetFile.startsWith(serverDir)) return res.status(403).json({ error: 'Accès refusé' });

    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, content, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/servers/:id/metrics
router.get('/:id/metrics', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server || !server.container_id) return res.json(null);

    const stats = await dockerService.getContainerStats(server.container_id);
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

function findFreePort(db) {
  const used = db.prepare('SELECT port FROM servers').all().map(r => r.port);
  let port = 25565;
  while (used.includes(port)) port++;
  return port;
}

function mapDockerStatus(dockerStatus, currentStatus) {
  if (['installing', 'updating', 'starting'].includes(currentStatus)) return currentStatus;
  switch (dockerStatus) {
    case 'running': return 'running';
    case 'exited':
    case 'stopped': return 'stopped';
    case 'removed': return 'stopped';
    default: return currentStatus;
  }
}

module.exports = router;
