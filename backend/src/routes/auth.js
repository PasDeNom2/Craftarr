const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getDb } = require('../config/database');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
const { getJwtSecret } = require('../config/secrets');

// ─── Jeton de premier démarrage ───────────────────────────────
// Tant qu'aucun compte n'existe, /setup exige ce jeton, affiché uniquement dans les logs du backend.
// Sans lui, n'importe qui atteignant l'UI avant l'admin pouvait créer le compte et prendre la main.
let setupToken = null;

function initSetupToken() {
  const { n } = getDb().prepare('SELECT COUNT(*) as n FROM users').get();
  if (n > 0) { setupToken = null; return; }
  setupToken = crypto.randomBytes(6).toString('hex').toUpperCase(); // 12 caractères
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║           Craftarr — Premier démarrage           ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Jeton de configuration : ${setupToken.padEnd(23)}║`);
  console.log("║  À saisir dans l'interface pour créer le compte  ║");
  console.log('║  administrateur (docker logs craftarr-backend).  ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
}

function isValidSetupToken(candidate) {
  if (!setupToken || typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate.trim().toUpperCase());
  const b = Buffer.from(setupToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─── GET /api/auth/setup-needed ───────────────────────────────
// Retourne { needed: true } si aucun utilisateur n'existe encore.
// Pas d'authentification requise.
router.get('/setup-needed', (req, res) => {
  const db = getDb();
  const { n } = db.prepare('SELECT COUNT(*) as n FROM users').get();
  res.json({ needed: n === 0 });
});

// ─── POST /api/auth/setup ─────────────────────────────────────
// Crée le premier compte administrateur.
// Refusé si un utilisateur existe déjà.
router.post('/setup', async (req, res, next) => {
  try {
    const db = getDb();
    const { n } = db.prepare('SELECT COUNT(*) as n FROM users').get();
    if (n > 0) {
      return res.status(403).json({ error: 'Un compte administrateur existe déjà.' });
    }

    const { username, password, setupToken: candidate } = req.body;
    if (!isValidSetupToken(candidate)) {
      return res.status(403).json({ error: 'Jeton de configuration invalide — voir les logs du backend (docker logs craftarr-backend)' });
    }
    if (!username || !password) {
      return res.status(400).json({ error: 'Identifiants requis' });
    }
    if (username.trim().length < 3) {
      return res.status(400).json({ error: 'Nom d\'utilisateur trop court (min 3 caractères)' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Mot de passe trop court (min 8 caractères)' });
    }

    const id = crypto.randomUUID();
    const hash = await bcrypt.hash(password, 10);
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(id, username.trim(), hash);
    setupToken = null; // usage unique
    console.log(`[Auth] Compte admin créé via setup : ${username.trim()}`);

    const token = jwt.sign({ id, username: username.trim() }, getJwtSecret(), { expiresIn: '7d' });
    res.json({ token, username: username.trim() });
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/auth/login ─────────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Identifiants requis' });
    }
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }
    const token = jwt.sign(
      { id: user.id, username: user.username },
      getJwtSecret(),
      { expiresIn: '7d' }
    );
    res.json({ token, username: user.username });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/auth/me ─────────────────────────────────────────
router.get('/me', authMiddleware, (req, res) => {
  res.json({ id: req.user.id, username: req.user.username });
});

module.exports = { router, initSetupToken };
