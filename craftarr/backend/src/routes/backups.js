const express = require('express');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../config/database');
const authMiddleware = require('../middleware/auth');
const backupService = require('../services/backup');

const router = express.Router();

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
router.post('/:serverId/backups/:backupId/restore', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });

    const backup = db.prepare('SELECT * FROM backups WHERE id = ? AND server_id = ?')
      .get(req.params.backupId, req.params.serverId);
    if (!backup) return res.status(404).json({ error: 'Backup introuvable' });

    await backupService.restoreBackup(server, backup);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
