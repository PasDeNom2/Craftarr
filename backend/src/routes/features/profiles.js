// Routes des profils de serveur, montées sur /api/servers.
const express = require('express');
const { getDb } = require('../../config/database');
const authMiddleware = require('../../middleware/auth');
const serverLock = require('../../services/serverLock');
const { formatServer } = require('../servers/common');
const profilesService = require('../../services/profiles');

const router = express.Router();

function loadServer(id) {
  const server = getDb().prepare('SELECT * FROM servers WHERE id = ?').get(id);
  if (!server) {
    throw Object.assign(new Error('Serveur introuvable'), { status: 404 });
  }
  return server;
}

// GET /api/servers/:id/profiles
router.get('/:id/profiles', authMiddleware, async (req, res, next) => {
  try {
    const server = loadServer(req.params.id);
    res.json(await profilesService.listProfiles(server));
  } catch (err) {
    next(err);
  }
});

// POST /api/servers/:id/profiles/new — Nouveau profil depuis un modpack
router.post('/:id/profiles/new', authMiddleware, serverLock.requireIdle, async (req, res, next) => {
  try {
    const server = loadServer(req.params.id);
    const updated = await profilesService.newFromModpack(server, req.body);
    res.status(201).json(formatServer(updated));
  } catch (err) {
    next(err);
  }
});

// POST /api/servers/:id/profiles — Sauvegarder l'installation actuelle comme profil
router.post('/:id/profiles', authMiddleware, serverLock.requireIdle, async (req, res, next) => {
  try {
    const server = loadServer(req.params.id);
    const created = await profilesService.saveCurrentAs(server, req.body.name);
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

// POST /api/servers/:id/profiles/:pid/activate — Basculer sur un profil
router.post('/:id/profiles/:pid/activate', authMiddleware, serverLock.requireIdle, async (req, res, next) => {
  try {
    const server = loadServer(req.params.id);
    const result = await profilesService.switchTo(server, req.params.pid, { io: req.app.get('io') });
    res.json({
      ok: true,
      server: formatServer(result.server),
      archivedProfileId: result.archivedProfileId,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/servers/:id/profiles/:pid — Renommer un profil
router.patch('/:id/profiles/:pid', authMiddleware, serverLock.requireIdle, async (req, res, next) => {
  try {
    const server = loadServer(req.params.id);
    const updated = await profilesService.rename(server, req.params.pid, req.body.name);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/servers/:id/profiles/:pid — Supprimer un profil
router.delete('/:id/profiles/:pid', authMiddleware, serverLock.requireIdle, async (req, res, next) => {
  try {
    const server = loadServer(req.params.id);
    res.json(await profilesService.remove(server, req.params.pid));
  } catch (err) {
    next(err);
  }
});

module.exports = { mount: '/api/servers', router };
