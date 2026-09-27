// Serveurs : liste, déploiement, installation, cycle de vie du container, paramètres, icône.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID: uuidv4 } = require('crypto');
const { getDb } = require('../../config/database');
const authMiddleware = require('../../middleware/auth');
const dockerService = require('../../services/docker');
const installer = require('../../services/installer');
const backupService = require('../../services/backup');
const updater = require('../../services/updater');
const { startLogStream } = require('../../websocket/logs');
const { isMcVersion } = require('../../services/mcVersion');
const { DATA_PATH, formatServer, findFreePort, mapDockerStatus, portOwner } = require('./common');

const router = express.Router();

// GET /api/servers
router.get('/', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const servers = db.prepare('SELECT * FROM servers ORDER BY created_at DESC').all();

    // Mise à jour statut depuis Docker — toujours retourner les serveurs même si Docker échoue
    const updated = await Promise.allSettled(servers.map(async s => {
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

    res.json(updated.map((r, i) => r.status === 'fulfilled' ? r.value : formatServer(servers[i])));
  } catch (err) {
    // En dernier recours, retourner les serveurs bruts de la DB sans vérification Docker
    try {
      const db = getDb();
      const servers = db.prepare('SELECT * FROM servers ORDER BY created_at DESC').all();
      return res.json(servers.map(formatServer));
    } catch {
      next(err);
    }
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

    const isVanilla = loader_type === 'vanilla';
    if (!name || (!isVanilla && (!modpack_id || !modpack_source))) {
      return res.status(400).json({ error: 'name (et modpack_id/modpack_source pour les modpacks) sont requis' });
    }
    const effectiveModpackId = isVanilla ? `vanilla-${mc_version || 'latest'}` : modpack_id;
    const effectiveModpackSource = isVanilla ? 'vanilla' : modpack_source;

    const db = getDb();
    const assignedPort = port || findFreePort(db);
    // Deux serveurs sur le même port : le second container ne démarrerait jamais
    const clash = portOwner(db, assignedPort);
    if (clash) return res.status(409).json({ error: `Le port ${assignedPort} est déjà utilisé par « ${clash.name} »` });
    const rconPort = assignedPort + 10;
    const rconPassword = uuidv4().replace(/-/g, '').slice(0, 16);
    const id = uuidv4();

    db.prepare(`
      INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, modpack_version,
        modpack_version_id, port, rcon_port, rcon_password, ram_mb, max_players, seed,
        whitelist_enabled, online_mode, status, mc_version, loader_type, auto_update)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'installing', ?, ?, ?)
    `).run(id, name, effectiveModpackId, modpack_name || effectiveModpackId, effectiveModpackSource, modpack_version || null,
      modpack_version_id || null, assignedPort, rconPort, rconPassword, ram_mb, max_players,
      seed || null, whitelist_enabled ? 1 : 0, online_mode ? 1 : 0,
      (isMcVersion(mc_version) ? mc_version : null),
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

// POST /api/servers/:id/install/confirm-client-pack — Confirme l'installation sans server pack
router.post('/:id/install/confirm-client-pack', authMiddleware, (req, res) => {
  installer.confirmClientPack(req.params.id);
  res.json({ ok: true });
});

// POST /api/servers/:id/install/cancel — Annule une installation en attente de confirmation
router.post('/:id/install/cancel', authMiddleware, (req, res) => {
  installer.cancelClientPack(req.params.id);
  res.json({ ok: true });
});

// POST /api/servers/:id/install-mods — Télécharge les mods manquants sans recréer le container
router.post('/:id/install-mods', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });

    res.json({ ok: true, message: 'Téléchargement des mods lancé en arrière-plan' });

    const serverDir = path.join(DATA_PATH, 'servers', server.id, 'server');
    const modsDir = path.join(serverDir, 'mods');
    fs.mkdirSync(modsDir, { recursive: true });

    // Stop server if running
    let wasRunning = false;
    if (server.container_id && ['running', 'starting'].includes(server.status)) {
      wasRunning = true;
      await dockerService.stopContainer(server.container_id).catch(() => {});
      db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('stopped', server.id);
    }

    installer.installModsOnly(server, serverDir, modsDir)
      .then(async () => {
        console.log(`[install-mods] Mods installés pour ${server.id}`);
        if (wasRunning && server.container_id) {
          await dockerService.startContainer(server.container_id, server);
          db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('starting', server.id);
        }
      })
      .catch(err => console.error(`[install-mods] Erreur:`, err.message));
  } catch (err) {
    next(err);
  }
});

// POST /api/servers/:id/reinstall — Relance l'installation depuis zéro (pour les serveurs en erreur sans container)
router.post('/:id/reinstall', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });
    if (server.status !== 'error') return res.status(400).json({ error: 'Le serveur doit être en erreur pour être réinstallé' });

    db.prepare("UPDATE servers SET status = 'installing', container_id = NULL WHERE id = ?").run(server.id);
    const updatedServer = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);
    res.json({ ok: true });

    installer.installServer(updatedServer).catch(err => {
      console.error(`[reinstall] Erreur pour ${server.id}:`, err.message);
      db.prepare("UPDATE servers SET status = 'error' WHERE id = ?").run(server.id);
    });
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
    db.prepare('UPDATE servers SET container_id = ?, container_name = ?, status = ?, needs_recreate = 0 WHERE id = ?')
      .run(containerId, containerName, 'starting', server.id);

    await dockerService.startContainer(containerId, fresh);
    startLogStream(req.app.get('io'), server.id);
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

    if (server.needs_recreate) {
      // Recréer le container pour appliquer les nouveaux paramètres
      await dockerService.removeContainer(server.container_id).catch(() => {});
      const { containerId, containerName } = await dockerService.createServerContainer(server);
      db.prepare('UPDATE servers SET container_id = ?, container_name = ?, status = ?, needs_recreate = 0 WHERE id = ?')
        .run(containerId, containerName, 'starting', server.id);
      await dockerService.startContainer(containerId, server);
    } else {
      await dockerService.startContainer(server.container_id, server);
      db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('starting', server.id);
    }
    startLogStream(req.app.get('io'), server.id);
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
    db.prepare('UPDATE players SET is_online = 0 WHERE server_id = ?').run(server.id);
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

    if (server.needs_recreate) {
      // Arrêter + recréer le container pour appliquer les nouveaux paramètres
      await dockerService.removeContainer(server.container_id).catch(() => {});
      const { containerId, containerName } = await dockerService.createServerContainer(server);
      db.prepare('UPDATE servers SET container_id = ?, container_name = ?, status = ?, needs_recreate = 0 WHERE id = ?')
        .run(containerId, containerName, 'starting', server.id);
      await dockerService.startContainer(containerId, server);
      startLogStream(req.app.get('io'), server.id);
    } else {
      await dockerService.restartContainer(server.container_id, server);
      db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('running', server.id);
    }
    res.json({ ok: true, status: 'starting' });
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

    const rcon = require('../../services/rcon');
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
      await dockerService.removeContainerAndImage(server.container_id).catch(() => {});
    }
    db.prepare('DELETE FROM servers WHERE id = ?').run(server.id);

    // Suppression du dossier de ce serveur uniquement (modpack, fichiers installés, monde).
    // Plus de "nettoyage des dossiers orphelins" : une base réinitialisée ou désynchronisée
    // aurait fait effacer TOUS les serveurs du disque.
    const serverDir = path.join(DATA_PATH, 'servers', server.id);
    try { fs.rmSync(serverDir, { recursive: true, force: true }); } catch (e) {
      console.warn(`[Delete] Impossible de supprimer ${serverDir}:`, e.message);
    }

    // Les backups (data/backups/<id>) sont conservés par défaut : dernier recours si la suppression
    // était une erreur. ?deleteBackups=true pour les effacer aussi.
    const backupsDir = backupService.backupsDirFor(server.id);
    let backupsKeptIn = null;
    if (req.query.deleteBackups === 'true') {
      fs.rmSync(backupsDir, { recursive: true, force: true });
    } else if (fs.existsSync(backupsDir)) {
      backupsKeptIn = backupsDir;
      console.log(`[Delete] Backups de ${server.name} conservés dans ${backupsDir}`);
    }

    res.json({ ok: true, backupsKeptIn });
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
      const { getModpackVersions } = require('../../services/sourceAggregator');
      const versions = await getModpackVersions(server.modpack_source, server.modpack_id);
      const target = versions.find(v => String(v.id) === String(version_id));
      if (!target) return res.status(404).json({ error: 'Version introuvable' });

      let downloadUrl;
      if (server.modpack_source === 'curseforge') {
        downloadUrl = await updater.resolveCurseForgeDownloadUrl(server, target, versions);
      } else {
        downloadUrl = target.downloadUrl || target.files?.find(f => f.primary)?.url || target.files?.[0]?.url;
      }
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

// PATCH /api/servers/:id — Modifier les paramètres du serveur
// Champs qui nécessitent une recréation du container (port bindings, env vars Docker)
const CONTAINER_FIELDS = new Set(['port', 'ram_mb', 'max_players', 'whitelist_enabled', 'motd', 'seed', 'difficulty', 'view_distance', 'spawn_protection']);

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
    if (updates.port !== undefined && updates.port !== server.port) {
      const clash = portOwner(db, updates.port, server.id);
      if (clash) return res.status(409).json({ error: `Le port ${updates.port} est déjà utilisé par « ${clash.name} »` });
    }

    // Lever needs_recreate si un champ impactant le container a changé
    const needsRecreate = Object.keys(updates).some(k => CONTAINER_FIELDS.has(k) && updates[k] !== server[k]);
    if (needsRecreate) updates.needs_recreate = 1;

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

module.exports = router;
