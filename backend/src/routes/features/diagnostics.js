// @ts-check
// Routes de diagnostic : spark (installation & profilage), rapports de crash/logs, partage mclo.gs.
const express = require('express');
const { getDb } = require('../../config/database');
const authMiddleware = require('../../middleware/auth');
const serverLock = require('../../services/serverLock');
const validate = require('../../services/validate');
const diagnostics = require('../../services/diagnostics');

/** @typedef {import('../../types').ServerRow} ServerRow */
/** @typedef {import('../../types').HttpError} HttpError */

/** @type {import('express').Router} */
const router = express.Router();

/**
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => any} fn
 * @returns {import('express').RequestHandler}
 */
const wrap = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(err => {
  if (err?.status) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  next(err);
});

/**
 * @param {string} id
 * @returns {ServerRow}
 */
function serverOf(id) {
  const server = getDb().prepare('SELECT * FROM servers WHERE id = ?').get(id);
  if (!server) {
    /** @type {HttpError} */
    const err = new Error('Serveur introuvable');
    err.status = 404;
    throw err;
  }
  return server;
}

// GET /api/servers/:id/diagnostics — état spark + liste des rapports de crash et logs
router.get('/:id/diagnostics', authMiddleware, wrap((req, res) => {
  const server = serverOf(String(req.params.id));
  const spark = diagnostics.getSparkStatus(server);
  const { crashReports, logs } = diagnostics.listDiagnosticFiles(server.id);
  res.json({ spark, crashReports, logs });
}));

// GET /api/servers/:id/diagnostics/file?name= — lecture d'un rapport de crash ou log listé
router.get('/:id/diagnostics/file', authMiddleware, wrap((req, res) => {
  const server = serverOf(String(req.params.id));
  const name = validate.str(req.query?.name, { max: 500, field: 'name', noNewlines: true });
  res.json(diagnostics.readDiagnosticFile(server.id, name));
}));

// POST /api/servers/:id/diagnostics/spark/install — installe spark via Modrinth
router.post('/:id/diagnostics/spark/install', authMiddleware, serverLock.requireIdle, wrap(async (req, res) => {
  const server = serverOf(String(req.params.id));
  const result = await serverLock.withLock(
    server.id,
    'installation de spark',
    () => diagnostics.installSpark(server)
  );
  res.json({ ok: true, ...result });
}));

// POST /api/servers/:id/diagnostics/spark/profile — { kind: 'profiler' | 'heap' }
router.post('/:id/diagnostics/spark/profile', authMiddleware, wrap(async (req, res) => {
  const server = serverOf(String(req.params.id));
  const kind = validate.oneOf(req.body?.kind, ['profiler', 'heap'], 'kind');
  const io = req.app.get('io') || null;
  const result = await diagnostics.runSparkProfile(server, kind, { io });
  res.json(result);
}));

// POST /api/servers/:id/diagnostics/share — { name } partage sur mclo.gs
router.post('/:id/diagnostics/share', authMiddleware, wrap(async (req, res) => {
  const server = serverOf(String(req.params.id));
  const name = validate.str(req.body?.name, { max: 500, field: 'name', noNewlines: true });
  const result = await diagnostics.shareDiagnosticFile(server.id, name);
  res.json(result);
}));

module.exports = { mount: '/api/servers', router };
