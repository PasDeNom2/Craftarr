const express = require('express');
const path = require('path');
const fs = require('fs');
const { randomUUID: uuidv4 } = require('crypto');
const { getDb } = require('../config/database');
const authMiddleware = require('../middleware/auth');
const backupService = require('../services/backup');
const serverLock = require('../services/serverLock');

const router = express.Router();
const orphansRouter = express.Router();
const usedDownloadTokens = new Map(); // jti → expiration (ms)

const backupsRoot = () => path.dirname(backupService.backupsDirFor('_'));
const isValidServerId = id => /^[A-Za-z0-9-]+$/.test(id);
const isValidZipFilename = name => /^[\w.-]+\.zip$/.test(name) && !name.includes('..');

// GET /api/servers/:serverId/backups
router.get('/:serverId/backups', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT id FROM servers WHERE id = ?').get(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });

    const backups = db.prepare(
      'SELECT * FROM backups WHERE server_id = ? ORDER BY created_at DESC'
    ).all(req.params.serverId);
    res.json(backups);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/servers/:serverId/backups/:backupId
router.delete('/:serverId/backups/:backupId', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const backup = db.prepare('SELECT * FROM backups WHERE id = ? AND server_id = ?')
      .get(req.params.backupId, req.params.serverId);
    if (!backup) return res.status(404).json({ error: 'Backup introuvable' });

    try { fs.unlinkSync(backup.path); } catch {}
    db.prepare('DELETE FROM backups WHERE id = ?').run(backup.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/servers/:serverId/backups/:backupId/restore
router.post('/:serverId/backups/:backupId/restore', authMiddleware, serverLock.requireIdle, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });

    const backup = db.prepare('SELECT * FROM backups WHERE id = ? AND server_id = ?')
      .get(req.params.backupId, req.params.serverId);
    if (!backup) return res.status(404).json({ error: 'Backup introuvable' });

    await serverLock.withLock(server.id, 'restauration', () => backupService.restoreBackup(server, backup));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

// ─── Sauvegardes orphelines (montées sur /api/backups) ────────

// GET /api/backups/orphans
orphansRouter.get('/orphans', authMiddleware, (req, res, next) => {
  try {
    const root = backupsRoot();
    if (!fs.existsSync(root)) return res.json([]);
    const db = getDb();
    const existingIds = new Set(db.prepare('SELECT id FROM servers').all().map(r => r.id));

    const result = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isValidServerId(entry.name) || existingIds.has(entry.name)) continue;
      const dir = path.join(root, entry.name);
      const files = [];
      let totalBytes = 0;
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!f.isFile()) continue;
        const st = fs.statSync(path.join(dir, f.name));
        files.push({ filename: f.name, size: st.size, mtime: st.mtimeMs });
        totalBytes += st.size;
      }
      result.push({ serverId: entry.name, files, totalBytes });
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/backups/orphans/:serverId
orphansRouter.delete('/orphans/:serverId', authMiddleware, (req, res, next) => {
  try {
    const { serverId } = req.params;
    if (!isValidServerId(serverId)) return res.status(400).json({ error: 'Identifiant de serveur invalide' });
    const db = getDb();
    if (db.prepare('SELECT id FROM servers WHERE id = ?').get(serverId)) {
      return res.status(409).json({ error: 'Ce serveur existe encore' });
    }
    const dir = path.join(backupsRoot(), serverId);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Dossier de sauvegardes introuvable' });
    fs.rmSync(dir, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/backups/orphans/:serverId/:filename/download-token
orphansRouter.get('/orphans/:serverId/:filename/download-token', authMiddleware, (req, res, next) => {
  try {
    const { serverId, filename } = req.params;
    if (!isValidServerId(serverId)) return res.status(400).json({ error: 'Identifiant de serveur invalide' });
    if (!isValidZipFilename(filename)) return res.status(400).json({ error: 'Nom de fichier invalide' });
    const db = getDb();
    if (db.prepare('SELECT id FROM servers WHERE id = ?').get(serverId)) {
      return res.status(409).json({ error: 'Ce serveur existe encore' });
    }
    const filePath = path.join(backupsRoot(), serverId, filename);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return res.status(404).json({ error: 'Sauvegarde introuvable' });
    }
    const jwt = require('jsonwebtoken');
    const { getJwtSecret } = require('../config/secrets');
    const token = jwt.sign(
      { purpose: 'orphan-backup-download', serverId, filename, jti: uuidv4() },
      getJwtSecret(),
      { expiresIn: '5m' }
    );
    res.json({ url: `/api/backups/orphans/${serverId}/${encodeURIComponent(filename)}/download?token=${encodeURIComponent(token)}` });
  } catch (err) {
    next(err);
  }
});

// GET /api/backups/orphans/:serverId/:filename/download?token=
orphansRouter.get('/orphans/:serverId/:filename/download', (req, res, next) => {
  try {
    const { serverId, filename } = req.params;
    if (!isValidServerId(serverId)) return res.status(400).json({ error: 'Identifiant de serveur invalide' });
    if (!isValidZipFilename(filename)) return res.status(400).json({ error: 'Nom de fichier invalide' });

    const jwt = require('jsonwebtoken');
    const { getJwtSecret } = require('../config/secrets');
    let claims;
    try { claims = jwt.verify(String(req.query.token || ''), getJwtSecret()); } catch { claims = null; }
    const now = Date.now();
    for (const [jti, exp] of usedDownloadTokens) if (exp < now) usedDownloadTokens.delete(jti);
    if (!claims || claims.purpose !== 'orphan-backup-download' || claims.serverId !== serverId || claims.filename !== filename || usedDownloadTokens.has(claims.jti)) {
      return res.status(401).json({ error: 'Lien de téléchargement invalide ou expiré' });
    }
    usedDownloadTokens.set(claims.jti, claims.exp * 1000);

    const db = getDb();
    if (db.prepare('SELECT id FROM servers WHERE id = ?').get(serverId)) {
      return res.status(409).json({ error: 'Ce serveur existe encore' });
    }
    const filePath = path.join(backupsRoot(), serverId, filename);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return res.status(404).json({ error: 'Sauvegarde introuvable' });
    }

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    const stream = fs.createReadStream(filePath);
    stream.on('error', err => {
      if (res.headersSent) res.destroy();
      else next(err);
    });
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

module.exports.orphans = orphansRouter;
