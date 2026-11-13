// @ts-check
/**
 * Routes de vérification et d'application des mises à jour de mods (Modrinth SHA-1).
 * Montées sur /api/servers via routes/features/mod-updates.js.
 */
const express = require('express');
const { getDb } = require('../../config/database');
const authMiddleware = require('../../middleware/auth');
const serverLock = require('../../services/serverLock');
const modUpdates = require('../../services/modUpdates');

const router = express.Router();

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  next(err);
});

function serverOf(req) {
  const server = getDb().prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) throw Object.assign(new Error('Serveur introuvable'), { status: 404 });
  return server;
}

// GET /api/servers/:id/mods/updates?refresh=1
router.get('/:id/mods/updates', authMiddleware, wrap(async (req, res) => {
  const server = serverOf(req);
  const force = req.query.refresh === '1' || req.query.refresh === 'true' || req.query.force === '1' || req.query.force === 'true';
  const result = await modUpdates.checkUpdates(server, { force });
  res.json(result);
}));

// POST /api/servers/:id/mods/updates — { files: [nom.jar] | 'all' }
router.post('/:id/mods/updates', authMiddleware, serverLock.requireIdle, wrap(async (req, res) => {
  const server = serverOf(req);
  const files = req.body?.files;
  if (files !== 'all' && (!Array.isArray(files) || files.length === 0)) {
    return res.status(400).json({ error: 'Champ files requis ([nom.jar] ou "all")' });
  }
  const result = await modUpdates.updateMods(server, files);
  res.json({ ok: true, ...result });
}));

module.exports = { mount: '/api/servers', router };
