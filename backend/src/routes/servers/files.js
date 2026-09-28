// Explorateur de fichiers du dossier serveur.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../../config/database');
const authMiddleware = require('../../middleware/auth');
const { DATA_PATH } = require('./common');
const nbt = require('../../services/nbt');

const router = express.Router();

const MAX_TEXT = 5 * 1024 * 1024;      // édition dans le navigateur
const MAX_RAW = 20 * 1024 * 1024;      // aperçu (images)
const MAX_UPLOAD = 1024 * 1024 * 1024; // 1 Go par fichier

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function serverDirOf(req) {
  const server = getDb().prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  if (!server) throw httpError(404, 'Serveur introuvable');
  return { server, root: path.join(DATA_PATH, 'servers', server.id, 'server') };
}

/**
 * Résout un chemin relatif au dossier serveur. Refuse tout ce qui en sort
 * (« .. », chemins absolus, liens symboliques qui pointent ailleurs).
 */
function resolveSafe(root, rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const target = path.resolve(root, clean);
  if (target !== root && !target.startsWith(root + path.sep)) throw httpError(403, 'Accès refusé');
  if (fs.existsSync(target)) {
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(target);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw httpError(403, 'Accès refusé');
  }
  return target;
}

const relOf = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

function validName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 255
    && !/[/\\\0]/.test(name) && name !== '.' && name !== '..';
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

const wrap = fn => async (req, res, next) => {
  try { await fn(req, res, next); } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

// GET /api/servers/:id/files?path= — contenu d'un dossier
router.get('/:id/files', authMiddleware, wrap((req, res) => {
  const { root } = serverDirOf(req);
  if (!fs.existsSync(root)) throw httpError(404, 'Chemin introuvable');
  const dir = resolveSafe(root, req.query.path);
  if (!fs.existsSync(dir)) throw httpError(404, 'Chemin introuvable');
  if (!fs.statSync(dir).isDirectory()) throw httpError(400, 'Ce chemin n\'est pas un dossier');

  const entries = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    let st = null;
    try { st = fs.statSync(path.join(dir, e.name)); } catch { /* lien cassé */ }
    const isDir = st ? st.isDirectory() : e.isDirectory();
    entries.push({ name: e.name, isDir, size: st && !isDir ? st.size : null, mtime: st ? st.mtimeMs : null });
  }
  entries.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true })));
  res.json({ path: relOf(root, dir), entries });
}));

// GET /api/servers/:id/files/content?path= — lire un fichier texte
router.get('/:id/files/content', authMiddleware, wrap((req, res) => {
  const { root } = serverDirOf(req);
  const file = resolveSafe(root, req.query.path);
  if (!fs.existsSync(file)) throw httpError(404, 'Fichier introuvable');
  const st = fs.statSync(file);
  if (!st.isFile()) throw httpError(400, 'Ce chemin n\'est pas un fichier');
  if (st.size > MAX_TEXT) throw httpError(413, 'Fichier trop grand pour l\'éditeur (max 5 Mo)');
  const buf = fs.readFileSync(file);
  if (isBinary(buf)) throw httpError(415, 'Fichier binaire : téléchargez-le plutôt');
  res.json({ path: relOf(root, file), content: buf.toString('utf8'), mtime: st.mtimeMs, size: st.size });
}));

// PUT /api/servers/:id/files/content — écrire un fichier texte (écriture atomique)
// baseMtime (facultatif) : refuse d'écraser un fichier modifié entre-temps (ex. par le serveur).
router.put('/:id/files/content', authMiddleware, wrap((req, res) => {
  const { path: rel, content, baseMtime, force } = req.body || {};
  if (!rel || typeof content !== 'string') throw httpError(400, 'path et content requis');
  const { root } = serverDirOf(req);
  const file = resolveSafe(root, rel);
  if (file === root) throw httpError(400, 'Chemin invalide');
  if (fs.existsSync(file)) {
    const st = fs.statSync(file);
    if (!st.isFile()) throw httpError(400, 'Ce chemin n\'est pas un fichier');
    if (baseMtime && !force && Math.abs(st.mtimeMs - baseMtime) > 1) {
      return res.status(409).json({ error: 'Le fichier a été modifié sur le disque depuis son ouverture', mtime: st.mtimeMs });
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.craftarr-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
  res.json({ ok: true, mtime: fs.statSync(file).mtimeMs });
}));

// GET /api/servers/:id/files/nbt?path= — fichier NBT (level.dat, *.nbt…) converti en SNBT éditable
router.get('/:id/files/nbt', authMiddleware, wrap((req, res) => {
  const { root } = serverDirOf(req);
  const file = resolveSafe(root, req.query.path);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw httpError(404, 'Fichier introuvable');
  const st = fs.statSync(file);
  if (st.size > MAX_TEXT) throw httpError(413, 'Fichier trop grand pour l\'éditeur (max 5 Mo)');
  let parsed;
  try { parsed = nbt.parseNbt(fs.readFileSync(file)); } catch (err) { throw httpError(415, `Pas un fichier NBT lisible : ${err.message}`); }
  const snbt = nbt.toSnbt(parsed.root);
  if (snbt.length > 20 * 1024 * 1024) throw httpError(413, 'Contenu NBT trop volumineux pour l\'éditeur');
  res.json({ path: relOf(root, file), content: snbt, compression: parsed.compression, rootName: parsed.name, mtime: st.mtimeMs, size: st.size });
}));

// PUT /api/servers/:id/files/nbt { path, content, baseMtime, force } — SNBT reconverti en NBT
// (même compression et même nom de racine que l'original ; l'ancienne version est gardée en .craftarr-bak)
router.put('/:id/files/nbt', authMiddleware, wrap((req, res) => {
  const { path: rel, content, baseMtime, force } = req.body || {};
  if (!rel || typeof content !== 'string') throw httpError(400, 'path et content requis');
  const { root } = serverDirOf(req);
  const file = resolveSafe(root, rel);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw httpError(404, 'Fichier introuvable');
  const st = fs.statSync(file);
  if (baseMtime && !force && Math.abs(st.mtimeMs - baseMtime) > 1) {
    return res.status(409).json({ error: 'Le fichier a été modifié sur le disque depuis son ouverture', mtime: st.mtimeMs });
  }
  const original = fs.readFileSync(file);
  let meta;
  try { meta = nbt.parseNbt(original); } catch { meta = { name: '', compression: 'gzip' }; }
  let tree;
  try { tree = nbt.parseSnbt(content); } catch (err) { throw httpError(400, err.message); }
  const out = nbt.serializeNbt({ name: meta.name, root: tree, compression: meta.compression });
  fs.writeFileSync(`${file}.craftarr-bak`, original);
  const tmp = `${file}.craftarr-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, file);
  res.json({ ok: true, mtime: fs.statSync(file).mtimeMs, size: out.length });
}));

// POST /api/servers/:id/files/mkdir { path } — créer un dossier
router.post('/:id/files/mkdir', authMiddleware, wrap((req, res) => {
  const { root } = serverDirOf(req);
  const rel = String(req.body?.path || '');
  if (!validName(path.basename(rel))) throw httpError(400, 'Nom invalide');
  const dir = resolveSafe(root, rel);
  if (fs.existsSync(dir)) throw httpError(409, 'Ce nom existe déjà');
  fs.mkdirSync(dir, { recursive: true });
  res.json({ ok: true, path: relOf(root, dir) });
}));

// POST /api/servers/:id/files/rename { from, to } — renommer ou déplacer
router.post('/:id/files/rename', authMiddleware, wrap((req, res) => {
  const { root } = serverDirOf(req);
  const { from, to } = req.body || {};
  if (!from || !to || !validName(path.basename(String(to)))) throw httpError(400, 'Nom invalide');
  const src = resolveSafe(root, from);
  const dst = resolveSafe(root, to);
  if (src === root || dst === root) throw httpError(400, 'Chemin invalide');
  if (!fs.existsSync(src)) throw httpError(404, 'Fichier introuvable');
  if (fs.existsSync(dst)) throw httpError(409, 'Ce nom existe déjà');
  if (dst.startsWith(src + path.sep)) throw httpError(400, 'Impossible de déplacer un dossier dans lui-même');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(src, dst);
  res.json({ ok: true, path: relOf(root, dst) });
}));

// POST /api/servers/:id/files/delete { paths: [] } — supprimer (récursif)
router.post('/:id/files/delete', authMiddleware, wrap((req, res) => {
  const { root } = serverDirOf(req);
  const paths = Array.isArray(req.body?.paths) ? req.body.paths : [];
  if (!paths.length) throw httpError(400, 'paths requis');
  const targets = paths.map(p => resolveSafe(root, p));
  if (targets.some(t => t === root)) throw httpError(400, 'Impossible de supprimer la racine du serveur');
  let deleted = 0;
  for (const t of targets) {
    if (!fs.existsSync(t)) continue;
    fs.rmSync(t, { recursive: true, force: true });
    deleted++;
  }
  res.json({ ok: true, deleted });
}));

// POST /api/servers/:id/files/upload?path=dossier — envoyer des fichiers (multipart, champ « files »)
router.post('/:id/files/upload', authMiddleware, wrap(async (req, res) => {
  const { root } = serverDirOf(req);
  const dir = resolveSafe(root, req.query.path);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw httpError(404, 'Dossier introuvable');
  const multer = require('multer');
  const tmpDir = path.join(DATA_PATH, 'servers', req.params.id, 'uploads');
  fs.mkdirSync(tmpDir, { recursive: true });
  const upload = multer({ dest: tmpDir, limits: { fileSize: MAX_UPLOAD, files: 200 } }).array('files');
  await new Promise((resolve, reject) => upload(req, res, err => (err ? reject(httpError(400, err.message)) : resolve())));

  const files = req.files || [];
  const overwrite = req.query.overwrite === '1';
  const saved = [];
  const skipped = [];
  try {
    for (const f of files) {
      // multer décode les noms en latin1
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
      if (!validName(name)) { skipped.push(name); continue; }
      const dst = resolveSafe(root, path.posix.join(relOf(root, dir), name));
      if (fs.existsSync(dst) && (!overwrite || fs.statSync(dst).isDirectory())) { skipped.push(name); continue; }
      try { fs.renameSync(f.path, dst); } catch { fs.copyFileSync(f.path, dst); }
      saved.push(name);
    }
  } finally {
    for (const f of files) fs.rmSync(f.path, { force: true });
  }
  res.json({ ok: true, saved, skipped });
}));

// GET /api/servers/:id/files/raw?path= — contenu brut (aperçu d'images)
router.get('/:id/files/raw', authMiddleware, wrap((req, res) => {
  const { root } = serverDirOf(req);
  const file = resolveSafe(root, req.query.path);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw httpError(404, 'Fichier introuvable');
  if (fs.statSync(file).size > MAX_RAW) throw httpError(413, 'Fichier trop grand');
  res.set('Cache-Control', 'no-store');
  res.sendFile(file, { dotfiles: 'allow' });
}));

// Téléchargement natif via lien signé à usage unique (même principe que le monde) :
// fichier → envoyé tel quel ; dossier ou sélection multiple → zip streamé.
const usedTokens = new Map();

router.post('/:id/files/download-token', authMiddleware, wrap((req, res) => {
  const { root } = serverDirOf(req);
  const paths = (Array.isArray(req.body?.paths) ? req.body.paths : [req.body?.path]).filter(p => typeof p === 'string');
  if (!paths.length) throw httpError(400, 'paths requis');
  for (const p of paths) if (!fs.existsSync(resolveSafe(root, p))) throw httpError(404, 'Fichier introuvable');
  const jwt = require('jsonwebtoken');
  const { getJwtSecret } = require('../../config/secrets');
  const token = jwt.sign({ purpose: 'files-download', serverId: req.params.id, paths, jti: uuidv4() }, getJwtSecret(), { expiresIn: '5m' });
  res.json({ url: `/api/servers/${req.params.id}/files/download?token=${encodeURIComponent(token)}` });
}));

router.get('/:id/files/download', async (req, res, next) => {
  try {
    const jwt = require('jsonwebtoken');
    const { getJwtSecret } = require('../../config/secrets');
    let claims;
    try { claims = jwt.verify(String(req.query.token || ''), getJwtSecret()); } catch { claims = null; }
    const now = Date.now();
    for (const [jti, exp] of usedTokens) if (exp < now) usedTokens.delete(jti);
    if (!claims || claims.purpose !== 'files-download' || claims.serverId !== req.params.id || usedTokens.has(claims.jti)) {
      return res.status(401).json({ error: 'Lien de téléchargement invalide ou expiré' });
    }
    usedTokens.set(claims.jti, claims.exp * 1000);

    const { server, root } = serverDirOf(req);
    const targets = claims.paths.map(p => resolveSafe(root, p)).filter(t => fs.existsSync(t));
    if (!targets.length) return res.status(404).json({ error: 'Fichier introuvable' });

    const single = targets.length === 1 ? targets[0] : null;
    if (single && fs.statSync(single).isFile()) {
      return res.download(single, path.basename(single), { dotfiles: 'allow' });
    }

    const base = single && single !== root ? path.basename(single) : server.name.replace(/[^a-z0-9_-]/gi, '_');
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(base)}.zip"`);
    const archiver = require('archiver');
    const archive = archiver('zip', { zlib: { level: 5 } });
    req.on('close', () => { if (!res.writableFinished) archive.abort(); });
    archive.on('error', err => { console.error('[files-download]', err.message); res.destroy(); });
    archive.pipe(res);
    for (const t of targets) {
      const name = t === root ? base : path.basename(t);
      if (fs.statSync(t).isDirectory()) archive.directory(t, name); else archive.file(t, { name });
    }
    archive.finalize();
  } catch (err) {
    if (err.status && !res.headersSent) return res.status(err.status).json({ error: err.message });
    if (res.headersSent) { res.destroy(); return; }
    next(err);
  }
});

module.exports = router;
module.exports.resolveSafe = resolveSafe;
