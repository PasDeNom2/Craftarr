// Serveurs : liste, déploiement, installation, cycle de vie du container, paramètres, icône.
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
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
const pregen = require('../../services/pregen');
const serverLock = require('../../services/serverLock');
const validate = require('../../services/validate');
const { requireIdle } = serverLock;
const events = require('../../services/events');

/** Rayon de pré-génération borné (blocs) */
const clampRadius = r => Math.max(500, Math.min(20000, Math.round(+r || 3000)));

/** Exécute un appel Docker en marquant les erreurs comme exposables à l'UI. */
async function dockerCall(fn) {
  try {
    return await fn();
  } catch (err) {
    err.expose = true;
    throw err;
  }
}

const router = express.Router();

const ALL_PERMS = ['view', 'console', 'power', 'files', 'players', 'backups', 'manage'];
const withPerms = (s, req) => ({
  ...formatServer(s),
  my_perms: req.permsFor ? req.permsFor(s.id) : [...ALL_PERMS],
});

// GET /api/servers
router.get('/', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const allServers = db.prepare('SELECT * FROM servers ORDER BY created_at DESC').all();
    const servers = req.allowedServerIds
      ? allServers.filter(s => req.allowedServerIds.has(s.id))
      : allServers;

    // Mise à jour statut depuis Docker — toujours retourner les serveurs même si Docker échoue
    const updated = await Promise.allSettled(servers.map(async s => {
      if (!s.container_id) return withPerms(s, req);
      try {
        const status = await dockerService.getContainerStatus(s.container_id);
        const mappedStatus = mapDockerStatus(status, s.status);
        if (mappedStatus !== s.status && !['installing', 'updating'].includes(s.status)) {
          db.prepare('UPDATE servers SET status = ? WHERE id = ?').run(mappedStatus, s.id);
          return withPerms({ ...s, status: mappedStatus }, req);
        }
      } catch {}
      return withPerms(s, req);
    }));

    res.json(updated.map((r, i) => r.status === 'fulfilled' ? r.value : withPerms(servers[i], req)));
  } catch (err) {
    // En dernier recours, retourner les serveurs bruts de la DB sans vérification Docker
    try {
      const db = getDb();
      const allServers = db.prepare('SELECT * FROM servers ORDER BY created_at DESC').all();
      const servers = req.allowedServerIds
        ? allServers.filter(s => req.allowedServerIds.has(s.id))
        : allServers;
      return res.json(servers.map(s => withPerms(s, req)));
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
    res.json(withPerms(server, req));
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
      pregen_enabled = false, pregen_radius = 3000, pregen_worlds,
    } = req.body;

    const normalizedLoader = typeof loader_type === 'string' ? loader_type.toLowerCase() : 'forge';
    const isStandaloneType = ['vanilla', 'paper', 'purpur'].includes(normalizedLoader)
      && (!modpack_source || modpack_source === 'vanilla');
    const isVanilla = normalizedLoader === 'vanilla' && (!modpack_source || modpack_source === 'vanilla');
    // Vanilla + pré-génération : Chunky a besoin d'un loader. On passe sur Fabric (compatible avec
    // les clients vanilla, aucun mod à installer côté joueurs) si Chunky existe pour cette version.
    // Paper / Purpur : Chunky existe en plugin, on conserve le loader choisi.
    let effectiveLoader = isStandaloneType ? normalizedLoader : loader_type;
    if (isVanilla && pregen_enabled && isMcVersion(mc_version) && await pregen.isAvailable('fabric', mc_version)) {
      effectiveLoader = 'fabric';
    }
    if (!name || (!isStandaloneType && (!modpack_id || !modpack_source))) {
      return res.status(400).json({ error: 'name (et modpack_id/modpack_source pour les modpacks) sont requis' });
    }
    const validName = validate.str(name, { max: 64, field: 'name' });
    const validRam = validate.int(ram_mb, { min: 512, max: 262144, field: 'ram_mb' });
    const validMaxPlayers = validate.int(max_players, { min: 1, max: 1000, field: 'max_players' });
    const validSeed = (seed !== undefined && seed !== null)
      ? (validate.str(seed, { max: 64, field: 'seed', allowEmpty: true }) || null)
      : null;
    const validWhitelist = validate.bool(whitelist_enabled, 'whitelist_enabled') ? 1 : 0;
    const validOnlineMode = validate.bool(online_mode, 'online_mode') ? 1 : 0;
    const validAutoUpdate = validate.bool(auto_update, 'auto_update') ? 1 : 0;
    const validPregen = validate.bool(pregen_enabled, 'pregen_enabled') ? 1 : 0;
    const effectiveModpackId = isStandaloneType ? `${normalizedLoader}-${mc_version || 'latest'}` : modpack_id;
    const effectiveModpackSource = isStandaloneType ? 'vanilla' : modpack_source;

    const db = getDb();
    const assignedPort = (port !== undefined && port !== null && port !== '')
      ? validate.int(port, { min: 1024, max: 65535, field: 'port' })
      : findFreePort(db);
    // Deux serveurs sur le même port : le second container ne démarrerait jamais
    const clash = portOwner(db, assignedPort);
    if (clash) return res.status(409).json({ error: `Le port ${assignedPort} est déjà utilisé par « ${clash.name} »` });
    const rconPort = assignedPort + 10;
    const rconPassword = uuidv4().replace(/-/g, '').slice(0, 16);
    const id = uuidv4();

    db.prepare(`
      INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, modpack_version,
        modpack_version_id, port, rcon_port, rcon_password, ram_mb, max_players, seed,
        whitelist_enabled, online_mode, status, mc_version, loader_type, auto_update, pregen_enabled, pregen_radius, pregen_worlds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'installing', ?, ?, ?, ?, ?, ?)
    `).run(id, validName, effectiveModpackId, modpack_name || effectiveModpackId, effectiveModpackSource, modpack_version || null,
      modpack_version_id || null, assignedPort, rconPort, rconPassword, validRam, validMaxPlayers,
      validSeed, validWhitelist, validOnlineMode,
      (isMcVersion(mc_version) ? mc_version : null),
      effectiveLoader, validAutoUpdate,
      validPregen && effectiveLoader !== 'vanilla' ? 1 : 0, clampRadius(pregen_radius), pregen.normalizeWorlds(pregen_worlds));

    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
    events.emit('server:created', { serverId: server.id });
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
router.post('/:id/install-mods', authMiddleware, requireIdle, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });

    res.json({ ok: true, message: 'Téléchargement des mods lancé en arrière-plan' });

    runInstallModsInBackground(db, server).catch(err => {
      console.error(`[install-mods] Erreur pour ${server.id}:`, err.message);
      try {
        db.prepare("UPDATE servers SET status = 'error' WHERE id = ?").run(server.id);
      } catch {}
    });
  } catch (err) {
    if (!res.headersSent) next(err);
  }
});

async function runInstallModsInBackground(db, server) {
  const serverDir = path.join(DATA_PATH, 'servers', server.id, 'server');
  const modsDir = path.join(serverDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });

  // Arrêter le container s'il tourne avant de toucher aux mods
  let wasRunning = false;
  if (server.container_id && ['running', 'starting'].includes(server.status)) {
    wasRunning = true;
    await dockerService.stopContainer(server.container_id).catch(() => {});
    db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('stopped', server.id);
  }

  await installer.installModsOnly(server, serverDir, modsDir);
  console.log(`[install-mods] Mods installés pour ${server.id}`);
  if (wasRunning && server.container_id) {
    await dockerService.startContainer(server.container_id, server);
    db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('starting', server.id);
  }
}

// POST /api/servers/:id/reinstall — Relance l'installation depuis zéro (pour les serveurs en erreur sans container)
router.post('/:id/reinstall', authMiddleware, requireIdle, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });
    if (server.status !== 'error') return res.status(400).json({ error: 'Le serveur doit être en erreur pour être réinstallé' });

    // Repartir d'un dossier propre (monde et fichiers joueurs conservés) : les restes d'une
    // tentative précédente (autres mods, autre loader) faisaient crasher la nouvelle installation
    if (server.container_id) await dockerService.removeContainer(server.container_id).catch(() => {});
    installer.cleanForReinstall(path.join(DATA_PATH, 'servers', server.id, 'server'));
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
router.post('/:id/recreate', authMiddleware, requireIdle, async (req, res, next) => {
  try {
    await serverLock.withLock(req.params.id, 'recréation du container', () => recreate(req, res));
  } catch (err) {
    next(err);
  }
});

/**
 * Supprime l'ancien container, efface ses identifiants en base puis crée le nouveau.
 * En cas d'échec de création, passe le serveur en erreur avant de relancer l'exception.
 */
async function recreateContainer(db, server) {
  if (server.container_id) {
    await dockerService.removeContainer(server.container_id).catch(() => {});
  }

  db.prepare("UPDATE servers SET container_id = NULL, container_name = NULL, status = 'stopped' WHERE id = ?").run(server.id);
  const fresh = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);

  let created;
  try {
    created = await dockerCall(() => dockerService.createServerContainer(fresh));
  } catch (err) {
    db.prepare("UPDATE servers SET status = 'error' WHERE id = ?").run(server.id);
    throw err;
  }

  db.prepare('UPDATE servers SET container_id = ?, container_name = ?, needs_recreate = 0 WHERE id = ?')
    .run(created.containerId, created.containerName, server.id);
  return { ...created, server: fresh };
}

async function recreate(req, res) {
  const db = getDb();
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) return res.status(404).json({ error: 'Serveur introuvable' });

  // Recréation avec les paramètres actuels (incluant CF_API_KEY, RAM, port)
  const { containerId, server: fresh } = await recreateContainer(db, server);
  await dockerCall(() => dockerService.startContainer(containerId, fresh));
  db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('starting', server.id);
  startLogStream(req.app.get('io'), server.id);
  events.emit('server:power', { serverId: server.id, action: 'recreate', userId: req.user?.id });
  res.json({ ok: true, status: 'starting' });
}

// POST /api/servers/:id/start
router.post('/:id/start', authMiddleware, requireIdle, async (req, res, next) => {
  const release = serverLock.acquire(req.params.id, 'démarrage');
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });
    if (!server.container_id) return res.status(400).json({ error: 'Container non créé' });

    if (server.needs_recreate) {
      // Recréer le container pour appliquer les nouveaux paramètres
      const { containerId, server: fresh } = await recreateContainer(db, server);
      await dockerCall(() => dockerService.startContainer(containerId, fresh));
      db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('starting', server.id);
    } else {
      await dockerCall(() => dockerService.startContainer(server.container_id, server));
      db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('starting', server.id);
    }
    startLogStream(req.app.get('io'), server.id);
    events.emit('server:power', { serverId: server.id, action: 'start', userId: req.user?.id });
    res.json({ ok: true, status: 'starting' });
  } catch (err) {
    next(err);
  } finally {
    release();
  }
});

// POST /api/servers/:id/stop
router.post('/:id/stop', authMiddleware, requireIdle, async (req, res, next) => {
  const release = serverLock.acquire(req.params.id, 'arrêt');
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });
    if (!server.container_id) return res.status(400).json({ error: 'Container non créé' });

    await dockerCall(() => dockerService.stopContainer(server.container_id));
    db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('stopped', server.id);
    db.prepare('UPDATE players SET is_online = 0 WHERE server_id = ?').run(server.id);
    events.emit('server:power', { serverId: server.id, action: 'stop', userId: req.user?.id });
    res.json({ ok: true, status: 'stopped' });
  } catch (err) {
    next(err);
  } finally {
    release();
  }
});

// POST /api/servers/:id/restart
router.post('/:id/restart', authMiddleware, requireIdle, async (req, res, next) => {
  const release = serverLock.acquire(req.params.id, 'redémarrage');
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });
    if (!server.container_id) return res.status(400).json({ error: 'Container non créé' });

    if (server.needs_recreate) {
      // Arrêter + recréer le container pour appliquer les nouveaux paramètres
      const { containerId, server: fresh } = await recreateContainer(db, server);
      await dockerCall(() => dockerService.startContainer(containerId, fresh));
      db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('starting', server.id);
      startLogStream(req.app.get('io'), server.id);
    } else {
      await dockerCall(() => dockerService.restartContainer(server.container_id, server));
      // « starting » : le flux de logs repasse en « running » sur la ligne Done (avant : en ligne trop tôt)
      db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('starting', server.id);
    }
    events.emit('server:power', { serverId: server.id, action: 'restart', userId: req.user?.id });
    res.json({ ok: true, status: 'starting' });
  } catch (err) {
    next(err);
  } finally {
    release();
  }
});

// POST /api/servers/:id/backup
router.post('/:id/backup', authMiddleware, requireIdle, async (req, res, next) => {
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
router.delete('/:id', authMiddleware, requireIdle, async (req, res, next) => {
  try {
    await serverLock.withLock(req.params.id, 'suppression', async () => {
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

      events.emit('server:deleted', { serverId: server.id });
      res.json({ ok: true, backupsKeptIn });
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/servers/:id/update — Mise à jour manuelle vers une version choisie (ou latest)
router.post('/:id/update', authMiddleware, requireIdle, async (req, res, next) => {
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

const PATCH_VALIDATORS = {
  name: v => validate.str(v, { max: 64, field: 'name' }),
  port: v => validate.int(v, { min: 1024, max: 65535, field: 'port' }),
  ram_mb: v => validate.int(v, { min: 512, max: 262144, field: 'ram_mb' }),
  max_players: v => validate.int(v, { min: 1, max: 1000, field: 'max_players' }),
  update_interval_hours: v => validate.int(v, { min: 1, max: 168, field: 'update_interval_hours' }),
  motd: v => (v === null ? null : (validate.str(v, { max: 256, field: 'motd', allowEmpty: true, noNewlines: true }) || null)),
  seed: v => (v === null ? null : (validate.str(v, { max: 64, field: 'seed', allowEmpty: true }) || null)),
  difficulty: v => validate.oneOf(v, ['peaceful', 'easy', 'normal', 'hard'], 'difficulty'),
  view_distance: v => validate.int(v, { min: 2, max: 32, field: 'view_distance' }),
  spawn_protection: v => validate.int(v, { min: 0, max: 1000, field: 'spawn_protection' }),
  whitelist_enabled: v => (validate.bool(v, 'whitelist_enabled') ? 1 : 0),
  auto_update: v => (validate.bool(v, 'auto_update') ? 1 : 0),
  pregen_enabled: v => (validate.bool(v, 'pregen_enabled') ? 1 : 0),
  pregen_pause_players: v => (validate.bool(v, 'pregen_pause_players') ? 1 : 0),
  pregen_radius: v => clampRadius(v),
  pregen_worlds: v => pregen.normalizeWorlds(v),
};

router.patch('/:id', authMiddleware, requireIdle, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });

    const updates = {};
    for (const [key, normalize] of Object.entries(PATCH_VALIDATORS)) {
      if (req.body[key] !== undefined) {
        updates[key] = normalize(req.body[key]);
      }
    }
    // Champs déclarés par les extensions (services/extensions/*.js → fields)
    const extFields = require('../../services/extensions').fields();
    for (const [key, def] of Object.entries(extFields)) {
      if (req.body[key] !== undefined && PATCH_VALIDATORS[key] === undefined) updates[key] = def.parse(req.body[key], server);
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Aucun champ modifiable fourni' });
    const worldsChanged = updates.pregen_worlds !== undefined && updates.pregen_worlds !== pregen.worldsOf(server).join(',');

    // Pré-génération : activation (installation de Chunky), désactivation, changement de rayon
    let pregenError = null;
    const pregenOn = updates.pregen_enabled !== undefined ? !!updates.pregen_enabled : !!server.pregen_enabled;
    if (updates.pregen_enabled === 1 && !server.pregen_enabled) {
      try {
        const { installed } = await pregen.ensureChunky({ ...server, ...updates });
        updates.pregen_status = installed && ['running', 'starting'].includes(server.status) ? 'needs_restart' : 'pending';
        updates.pregen_message = null;
      } catch (err) {
        pregenError = err.message;
        updates.pregen_enabled = 0;
      }
    } else if (updates.pregen_enabled === 0 && server.pregen_enabled) {
      await pregen.cancelTask(server);
      Object.assign(updates, { pregen_status: null, pregen_progress: 0, pregen_eta: null, pregen_message: null, pregen_world_index: 0 });
    } else if (pregenOn && ((updates.pregen_radius !== undefined && updates.pregen_radius !== server.pregen_radius) || worldsChanged) && server.pregen_status) {
      // Rayon ou dimensions modifiés : on repart de zéro (les chunks déjà générés restent, Chunky les saute vite)
      await pregen.cancelTask(server);
      Object.assign(updates, { pregen_status: server.pregen_status === 'needs_restart' ? 'needs_restart' : 'pending', pregen_progress: 0, pregen_eta: null, pregen_world_index: 0 });
    }
    if (updates.port !== undefined && updates.port !== server.port) {
      const clash = portOwner(db, updates.port, server.id);
      if (clash) return res.status(409).json({ error: `Le port ${updates.port} est déjà utilisé par « ${clash.name} »` });
    }

    // Lever needs_recreate si un champ impactant le container a changé
    const needsRecreate = Object.keys(updates).some(k => (CONTAINER_FIELDS.has(k) || extFields[k]?.container) && updates[k] !== server[k]);
    if (needsRecreate) updates.needs_recreate = 1;

    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE servers SET ${setClauses} WHERE id = ?`).run(...Object.values(updates), server.id);

    const updated = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);
    res.json({ ...formatServer(updated), ...(pregenError ? { pregenError } : {}) });
  } catch (err) {
    next(err);
  }
});

// POST /api/servers/:id/pregen/restart — Recommence la pré-génération depuis zéro
router.post('/:id/pregen/restart', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });
    if (!server.pregen_enabled) return res.status(400).json({ error: 'Pré-génération désactivée' });
    await pregen.cancelTask(server);
    db.prepare("UPDATE servers SET pregen_status = 'pending', pregen_progress = 0, pregen_eta = NULL, pregen_message = NULL, pregen_world_index = 0 WHERE id = ?").run(server.id);
    res.json(formatServer(db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id)));
    pregen.tick().catch(() => {});
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
        if (file.mimetype !== 'image/png') {
          return cb(Object.assign(new Error('Format PNG requis (image/png)'), { status: 400 }));
        }
        cb(null, true);
      },
    }).single('icon');

    upload(req, res, err => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE' && !err.status) err.status = 400;
        return next(err);
      }
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
