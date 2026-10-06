// Mods d'un serveur : liste, activation, corbeille, recherche et installation (Modrinth / CurseForge),
// envoi de .jar à la main avec vérification immédiate.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../../config/database');
const authMiddleware = require('../../middleware/auth');
const modManager = require('../../services/modManager');
const serverLock = require('../../services/serverLock');
const { DATA_PATH } = require('./common');

const router = express.Router();
const MAX_JAR = 512 * 1024 * 1024;

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  next(err);
});

function serverOf(req) {
  const server = getDb().prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) throw Object.assign(new Error('Serveur introuvable'), { status: 404 });
  return server;
}

// Les mods ne sont chargés qu'au démarrage : le serveur en marche doit redémarrer pour les prendre en compte
const restartHint = server => ['running', 'starting'].includes(server.status);

// GET /api/servers/:id/mods
router.get('/:id/mods', authMiddleware, wrap(async (req, res) => {
  const server = serverOf(req);
  res.json(modManager.listMods(server));
}));

// PATCH /api/servers/:id/mods — { file, enabled }
router.patch('/:id/mods', authMiddleware, serverLock.requireIdle, wrap(async (req, res) => {
  const server = serverOf(req);
  const file = modManager.setEnabled(server, req.body?.file, !!req.body?.enabled);
  res.json({ ok: true, file, restartRequired: restartHint(server) });
}));

// POST /api/servers/:id/mods/trash — { files: [] } : déplacés dans .craftarr/trash/mods (jamais effacés)
router.post('/:id/mods/trash', authMiddleware, serverLock.requireIdle, wrap(async (req, res) => {
  const server = serverOf(req);
  const files = Array.isArray(req.body?.files) ? req.body.files : [];
  if (!files.length) return res.status(400).json({ error: 'Aucun mod sélectionné' });
  res.json({ ok: true, moved: modManager.trashMods(server, files), restartRequired: restartHint(server) });
}));

// GET /api/servers/:id/mods/search?q=&source=
router.get('/:id/mods/search', authMiddleware, wrap(async (req, res) => {
  const server = serverOf(req);
  const source = ['modrinth', 'curseforge'].includes(req.query.source) ? req.query.source : undefined;
  res.json(await modManager.search(server, String(req.query.q || '').slice(0, 100), source));
}));

// POST /api/servers/:id/mods/install — { source, projectId }
router.post('/:id/mods/install', authMiddleware, serverLock.requireIdle, wrap(async (req, res) => {
  const server = serverOf(req);
  const { source, projectId } = req.body || {};
  if (!['modrinth', 'curseforge'].includes(source) || !projectId) return res.status(400).json({ error: 'source et projectId requis' });
  const result = await serverLock.withLock(server.id, 'installation d\'un mod', () => modManager.installMod(server, source, projectId));
  res.json({ ok: true, ...result, restartRequired: restartHint(server) && result.installed.length > 0 });
}));

// POST /api/servers/:id/mods/fix-dependencies — installe les dépendances manquantes détectées
router.post('/:id/mods/fix-dependencies', authMiddleware, serverLock.requireIdle, wrap(async (req, res) => {
  const server = serverOf(req);
  const result = await serverLock.withLock(server.id, 'installation des dépendances', () => modManager.installMissingDependencies(server));
  res.json({ ok: true, ...result, restartRequired: restartHint(server) && result.installed.length > 0 });
}));

// POST /api/servers/:id/mods/upload — .jar envoyés à la main (champ « files »), vérifiés avant d'être gardés
router.post('/:id/mods/upload', authMiddleware, serverLock.requireIdle, wrap(async (req, res) => {
  const server = serverOf(req);
  const { mods } = modManager.dirsOf(server.id);
  fs.mkdirSync(mods, { recursive: true });
  const multer = require('multer');
  const tmpDir = path.join(DATA_PATH, 'servers', server.id, 'uploads');
  fs.mkdirSync(tmpDir, { recursive: true });
  const upload = multer({ dest: tmpDir, limits: { fileSize: MAX_JAR, files: 50 } }).array('files');
  await new Promise((resolve, reject) => upload(req, res, err => (err ? reject(Object.assign(new Error(err.message), { status: 400 })) : resolve())));

  const saved = [];
  const skipped = [];
  const warnings = [];
  try {
    for (const f of req.files || []) {
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
      if (!/^[^/\\\0]+\.jar$/i.test(name)) { skipped.push(`${name} (pas un .jar)`); continue; }
      const dest = path.join(mods, name);
      if (fs.existsSync(dest) || fs.existsSync(`${dest}.disabled`)) { skipped.push(`${name} (déjà présent)`); continue; }
      const check = modManager.checkUploaded(server, f.path);
      warnings.push(...check.warnings);
      try { fs.renameSync(f.path, dest); } catch { fs.copyFileSync(f.path, dest); }
      saved.push(name);
    }
  } finally {
    for (const f of req.files || []) fs.rmSync(f.path, { force: true });
  }
  res.json({ ok: true, saved, skipped, warnings, restartRequired: restartHint(server) && saved.length > 0 });
}));

module.exports = router;
