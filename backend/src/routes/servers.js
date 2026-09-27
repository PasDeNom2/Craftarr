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
const { startLogStream } = require('../websocket/logs');
const { isMcVersion } = require('../services/mcVersion');

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
    needs_recreate: !!row.needs_recreate,
  };
}

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

    const installer = require('../services/installer');
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
      const { getModpackVersions } = require('../services/sourceAggregator');
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

// POST /api/servers/:id/world-import — Import d'un dossier world (zip)
router.post('/:id/world-import', authMiddleware, async (req, res, next) => {
  const upload = getUpload();
  if (!upload) return res.status(500).json({ error: 'Module upload non disponible' });

  upload.single('world')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Fichier manquant' });

    const zipPath = req.file.path;
    const cleanupUpload = () => { try { fs.unlinkSync(zipPath); } catch {} };
    try {
      const db = getDb();
      const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
      if (!server) { cleanupUpload(); return res.status(404).json({ error: 'Serveur introuvable' }); }

      const serverDir = path.join(DATA_PATH, 'servers', server.id, 'server');
      const stagingDir = path.join(DATA_PATH, 'servers', server.id, '.import-staging');

      // 1. Validation du zip AVANT de toucher au monde actuel (serveur toujours en marche)
      const AdmZip = require('adm-zip');
      let zip;
      try { zip = new AdmZip(zipPath); } catch {
        cleanupUpload();
        return res.status(400).json({ error: 'Fichier zip invalide ou corrompu' });
      }
      // Le dossier du monde = celui qui contient level.dat le moins profond (zip du dossier ou de son contenu)
      const levelDats = zip.getEntries()
        .map(e => e.entryName.replace(/\\/g, '/'))
        .filter(n => n === 'level.dat' || n.endsWith('/level.dat'))
        .sort((a, b) => a.split('/').length - b.split('/').length);
      if (!levelDats.length) {
        cleanupUpload();
        return res.status(400).json({ error: 'Aucun monde Minecraft dans ce zip (level.dat introuvable)' });
      }
      const worldRootInZip = path.posix.dirname(levelDats[0]); // "." si level.dat est à la racine

      // 2. Extraction à part
      fs.rmSync(stagingDir, { recursive: true, force: true });
      fs.mkdirSync(stagingDir, { recursive: true });
      zip.extractAllTo(stagingDir, true);
      cleanupUpload();
      const extractedWorld = path.join(stagingDir, worldRootInZip);

      // 3. Backup de sécurité du monde actuel, puis arrêt propre
      const levelName = backupService.readLevelName(serverDir);
      if (fs.existsSync(path.join(serverDir, levelName))) {
        await backupService.createBackup(server, 'pre-import');
      }
      const wasRunning = !!server.container_id && ['running', 'starting'].includes(server.status);
      if (wasRunning) {
        await dockerService.stopContainer(server.container_id).catch(() => {});
        db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('stopped', server.id);
      }

      // 4. Bascule : le monde importé devient le monde principal (level-name).
      //    Les dimensions séparées (_nether/_the_end, format Bukkit) sont reprises si présentes à côté.
      try {
        for (const d of backupService.getWorldDirs(serverDir)) fs.rmSync(path.join(serverDir, d), { recursive: true, force: true });
        fs.renameSync(extractedWorld, path.join(serverDir, levelName));
        if (worldRootInZip !== '.') {
          const parent = path.dirname(extractedWorld);
          const base = path.basename(extractedWorld);
          for (const suffix of ['_nether', '_the_end']) {
            const dim = path.join(parent, base + suffix);
            if (fs.existsSync(dim)) fs.renameSync(dim, path.join(serverDir, levelName + suffix));
          }
        }
      } finally {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      }

      // 5. Redémarrage si était actif
      if (wasRunning) {
        await dockerService.startContainer(server.container_id, server);
        db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('starting', server.id);
      }

      res.json({ ok: true, message: 'World importé avec succès' });
    } catch (e) {
      cleanupUpload();
      next(e);
    }
  });
});

// ─── Téléchargement du monde ────────────────────────────────
// Le navigateur télécharge nativement (streaming disque, pas de limite de temps ni de RAM) via
// un lien signé : un navigateur ne peut pas joindre le header Authorization à un simple lien.
// 1) POST /world-download-token (authentifié) → jeton 5 min, usage unique, limité à ce serveur
// 2) GET  /world-download?token=… → zip streamé (jamais chargé entièrement en mémoire)
const usedDownloadTokens = new Map(); // jti → expiration (ms)

router.post('/:id/world-download-token', authMiddleware, (req, res) => {
  const jwt = require('jsonwebtoken');
  const { getJwtSecret } = require('../config/secrets');
  const token = jwt.sign({ purpose: 'world-download', serverId: req.params.id, jti: uuidv4() }, getJwtSecret(), { expiresIn: '5m' });
  res.json({ url: `/api/servers/${req.params.id}/world-download?token=${encodeURIComponent(token)}` });
});

router.get('/:id/world-download', async (req, res, next) => {
  try {
    const jwt = require('jsonwebtoken');
    const { getJwtSecret } = require('../config/secrets');
    let claims;
    try { claims = jwt.verify(String(req.query.token || ''), getJwtSecret()); } catch { claims = null; }
    const now = Date.now();
    for (const [jti, exp] of usedDownloadTokens) if (exp < now) usedDownloadTokens.delete(jti);
    if (!claims || claims.purpose !== 'world-download' || claims.serverId !== req.params.id || usedDownloadTokens.has(claims.jti)) {
      return res.status(401).json({ error: 'Lien de téléchargement invalide ou expiré' });
    }
    usedDownloadTokens.set(claims.jti, claims.exp * 1000);

    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });

    const serverDir = path.join(DATA_PATH, 'servers', server.id, 'server');
    const worldDirs = backupService.getWorldDirs(serverDir).filter(d => fs.existsSync(path.join(serverDir, d)));
    if (!worldDirs.length) return res.status(404).json({ error: 'Aucun dossier world trouvé' });

    const filename = `${server.name.replace(/[^a-z0-9_-]/gi, '_')}_world.zip`;
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);

    // Monde cohérent (save-all + save-off) pendant la copie ; les .mca sont déjà compressés → niveau 1
    await backupService.withWorldFlushed(server, () => new Promise((resolve, reject) => {
      const archiver = require('archiver');
      const archive = archiver('zip', { zlib: { level: 1 } });
      req.on('close', () => { if (!res.writableFinished) archive.abort(); resolve(); });
      archive.on('error', reject);
      res.on('finish', resolve);
      archive.pipe(res);
      for (const dir of worldDirs) archive.directory(path.join(serverDir, dir), dir);
      archive.finalize();
    }));
  } catch (err) {
    if (res.headersSent) { console.error('[world-download]', err.message); res.destroy(); return; }
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
    const rcon = require('../services/rcon');
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
    const rcon = require('../services/rcon');
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
      const rcon = require('../services/rcon');
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
      const rcon = require('../services/rcon');
      await rcon.sendCommand(server, `whitelist remove ${username}`).catch(() => {});
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
});

function findFreePort(db) {
  const rows = db.prepare('SELECT port, rcon_port FROM servers').all();
  const usedPorts = new Set(rows.flatMap(r => [r.port, r.rcon_port]));
  let port = 25565;
  while (usedPorts.has(port) || usedPorts.has(port + 10)) port++;
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
