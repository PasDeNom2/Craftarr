// Explorateur de fichiers du dossier serveur.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../../config/database');
const authMiddleware = require('../../middleware/auth');
const { DATA_PATH } = require('./common');

const router = express.Router();

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

module.exports = router;
