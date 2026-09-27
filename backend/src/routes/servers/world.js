// Monde : import (zip) et téléchargement streamé via lien signé.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID: uuidv4 } = require('crypto');
const { getDb } = require('../../config/database');
const authMiddleware = require('../../middleware/auth');
const dockerService = require('../../services/docker');
const backupService = require('../../services/backup');
const { DATA_PATH, getUpload } = require('./common');

const router = express.Router();

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
  const { getJwtSecret } = require('../../config/secrets');
  const token = jwt.sign({ purpose: 'world-download', serverId: req.params.id, jti: uuidv4() }, getJwtSecret(), { expiresIn: '5m' });
  res.json({ url: `/api/servers/${req.params.id}/world-download?token=${encodeURIComponent(token)}` });
});

router.get('/:id/world-download', async (req, res, next) => {
  try {
    const jwt = require('jsonwebtoken');
    const { getJwtSecret } = require('../../config/secrets');
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

module.exports = router;
