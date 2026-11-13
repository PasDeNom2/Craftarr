// Routes /api/servers/:id/geyser* : statut, activation et désactivation du crossplay Bedrock.
const express = require('express');
const { getDb } = require('../../config/database');
const authMiddleware = require('../../middleware/auth');
const serverLock = require('../../services/serverLock');
const validate = require('../../services/validate');
const geyser = require('../../services/extensions/geyser');

const router = express.Router();

function loadServer(id) {
  const server = getDb().prepare('SELECT * FROM servers WHERE id = ?').get(id);
  if (!server) throw Object.assign(new Error('Serveur introuvable'), { status: 404 });
  return server;
}

// GET /api/servers/:id/geyser
router.get('/:id/geyser', authMiddleware, (req, res, next) => {
  try {
    const server = loadServer(req.params.id);
    res.json(geyser.getStatus(server));
  } catch (err) {
    next(err);
  }
});

// POST /api/servers/:id/geyser/enable { floodgate }
router.post('/:id/geyser/enable', authMiddleware, serverLock.requireIdle, async (req, res, next) => {
  try {
    const initial = loadServer(req.params.id);
    const floodgate = req.body?.floodgate === undefined
      ? initial.geyser_floodgate !== 0
      : validate.bool(req.body.floodgate, 'floodgate');

    const updated = await serverLock.withLock(initial.id, 'activation Geyser', async () => {
      const server = loadServer(req.params.id);
      return geyser.enable(server, { floodgate });
    });

    res.json({ ok: true, ...geyser.getStatus(updated), needs_recreate: !!updated.needs_recreate });
  } catch (err) {
    next(err);
  }
});

// POST /api/servers/:id/geyser/disable
router.post('/:id/geyser/disable', authMiddleware, serverLock.requireIdle, async (req, res, next) => {
  try {
    const initial = loadServer(req.params.id);
    const updated = await serverLock.withLock(initial.id, 'désactivation Geyser', () => {
      const server = loadServer(req.params.id);
      return geyser.disable(server);
    });

    res.json({ ok: true, ...geyser.getStatus(updated), needs_recreate: !!updated.needs_recreate });
  } catch (err) {
    next(err);
  }
});

module.exports = { mount: '/api/servers', router };
