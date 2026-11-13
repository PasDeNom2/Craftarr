// Routes de gestion des clés API révocables (/api/api-keys).
const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../../config/database');
const { generateApiKey, hashApiKey } = require('../../config/secrets');
const authMiddleware = require('../../middleware/auth');
const validate = require('../../services/validate');

const MAX_ACTIVE_KEYS = 25;
const router = express.Router();

function requireSession(req, res, next) {
  if (req.apiKey) {
    return res.status(403).json({ error: 'Cette route exige une session utilisateur' });
  }
  return next();
}

function formatApiKey(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    username: row.username || undefined,
    name: row.name,
    prefix: row.prefix,
    read_only: !!row.read_only,
    created_at: row.created_at,
    last_used_at: row.last_used_at || null,
    expires_at: row.expires_at || null,
    revoked: !!row.revoked,
  };
}

// GET /api/api-keys (?all=1 pour admin)
router.get('/', authMiddleware, requireSession, (req, res, next) => {
  try {
    const showAll = req.query.all === '1' || req.query.all === 'true';
    if (showAll && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Accès réservé aux administrateurs' });
    }

    const db = getDb();
    const sql = `
      SELECT k.id, k.user_id, u.username, k.name, k.prefix, k.read_only,
             k.created_at, k.last_used_at, k.expires_at, k.revoked
      FROM api_keys k
      JOIN users u ON u.id = k.user_id
      ${showAll ? '' : 'WHERE k.user_id = ?'}
      ORDER BY k.revoked ASC, k.created_at DESC, k.rowid DESC
    `;
    const rows = showAll ? db.prepare(sql).all() : db.prepare(sql).all(req.user.id);
    res.json(rows.map(formatApiKey));
  } catch (err) {
    next(err);
  }
});

// POST /api/api-keys { name, read_only?, expires_in_days? }
router.post('/', authMiddleware, requireSession, (req, res, next) => {
  try {
    const body = req.body || {};
    const name = validate.str(body.name, { max: 80, field: 'name', noNewlines: true });
    const readOnly = body.read_only === undefined ? false : validate.bool(body.read_only, 'read_only');

    let expiresAt = null;
    if (body.expires_in_days !== undefined && body.expires_in_days !== null && body.expires_in_days !== '') {
      const days = validate.int(body.expires_in_days, { min: 1, max: 3650, field: 'expires_in_days' });
      expiresAt = new Date(Date.now() + days * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
    }

    const db = getDb();
    const activeCount = db.prepare(`
      SELECT COUNT(*) AS n FROM api_keys
      WHERE user_id = ? AND revoked = 0 AND (expires_at IS NULL OR expires_at > datetime('now'))
    `).get(req.user.id).n;

    if (activeCount >= MAX_ACTIVE_KEYS) {
      return res.status(400).json({ error: `Limite de ${MAX_ACTIVE_KEYS} clés API actives atteinte` });
    }

    const id = crypto.randomUUID();
    const key = generateApiKey();
    const prefix = key.slice(4, 12);
    const hash = hashApiKey(key);

    db.prepare(`
      INSERT INTO api_keys (id, user_id, name, prefix, hash, read_only, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.user.id, name, prefix, hash, readOnly ? 1 : 0, expiresAt);

    const created = db.prepare(`
      SELECT k.id, k.user_id, u.username, k.name, k.prefix, k.read_only,
             k.created_at, k.last_used_at, k.expires_at, k.revoked
      FROM api_keys k
      JOIN users u ON u.id = k.user_id
      WHERE k.id = ?
    `).get(id);

    res.status(201).json({ key, ...formatApiKey(created) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/api-keys/:kid (révocation)
router.delete('/:kid', authMiddleware, requireSession, (req, res, next) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT id, user_id, revoked FROM api_keys WHERE id = ?').get(req.params.kid);
    // Clé d'un autre utilisateur (non admin) : 404 pour ne pas révéler son existence
    if (!row || (row.user_id !== req.user.id && req.user.role !== 'admin')) {
      return res.status(404).json({ error: 'Clé API introuvable' });
    }

    db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ?').run(row.id);
    res.json({ ok: true, id: row.id, revoked: true });
  } catch (err) {
    next(err);
  }
});

module.exports = { mount: '/api/api-keys', router };
