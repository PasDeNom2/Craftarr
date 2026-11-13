// Routes comptes multiples, permissions par serveur, 2FA TOTP et journal d'activité.
const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getDb } = require('../../config/database');
const { encrypt } = require('../../config/encryption');
const { getJwtSecret, signUserToken } = require('../../config/secrets');
const authMiddleware = require('../../middleware/auth');
const { VALID_PERMS, parsePerms, logActivity } = require('../../middleware/permissions');
const totp = require('../../services/totp');
const validate = require('../../services/validate');

const ROLES = ['admin', 'user'];

function formatUser(row, permsByUser = null) {
  return {
    id: row.id,
    username: row.username,
    role: row.role || 'admin',
    disabled: !!row.disabled,
    totp_enabled: !!row.totp_enabled,
    created_at: row.created_at,
    last_login_at: row.last_login_at || null,
    ...(permsByUser ? { permissions: permsByUser.get(row.id) || {} } : {}),
  };
}

function normalizeDateBound(raw, endOfDay = false) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return `${s} ${endOfDay ? '23:59:59' : '00:00:00'}`;
  }
  return s.replace('T', ' ').replace(/\.\d+Z?$|Z$/i, '').slice(0, 19);
}

// ─── 2FA (/api/auth/2fa/*) ────────────────────────────────────────────────────
const auth2faRouter = express.Router();

// GET /api/auth/2fa/status
auth2faRouter.get('/2fa/status', authMiddleware, (req, res) => {
  const row = getDb().prepare('SELECT totp_enabled FROM users WHERE id = ?').get(req.user.id);
  res.json({ enabled: !!row?.totp_enabled });
});

// POST /api/auth/2fa/setup
auth2faRouter.post('/2fa/setup', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const user = db.prepare('SELECT id, username, totp_enabled FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (user.totp_enabled) return res.status(400).json({ error: 'La double authentification est déjà activée' });

    const secret = totp.generateSecret();
    db.prepare('UPDATE users SET totp_secret = ?, totp_last_step = NULL WHERE id = ?')
      .run(encrypt(secret), user.id);

    const otpauthUrl = totp.buildOtpAuthUri({ secret, username: user.username });
    res.json({ secret, otpauthUrl });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/2fa/enable { code }
auth2faRouter.post('/2fa/enable', authMiddleware, (req, res, next) => {
  try {
    const { code } = req.body || {};
    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ error: 'Code de vérification requis' });
    }
    const db = getDb();
    const user = db.prepare('SELECT id, totp_secret, totp_enabled FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (user.totp_enabled) return res.status(400).json({ error: 'La double authentification est déjà activée' });
    if (!user.totp_secret) return res.status(400).json({ error: 'Initialisez d\'abord la double authentification' });

    const { decrypt } = require('../../config/encryption');
    const secret = decrypt(user.totp_secret);
    if (!secret) return res.status(400).json({ error: 'Secret 2FA illisible, relancez la configuration' });

    const check = totp.verifyTotp(secret, code);
    if (!check.valid) return res.status(400).json({ error: 'Code de vérification invalide' });

    const recoveryCodes = totp.generateRecoveryCodes(8);
    const hashes = recoveryCodes.map(totp.hashRecoveryCode);
    totp.clearReplayCache(user.id);
    db.prepare('UPDATE users SET totp_enabled = 1, recovery_codes = ?, totp_last_step = NULL WHERE id = ?')
      .run(JSON.stringify(hashes), user.id);

    res.json({ ok: true, recoveryCodes });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/2fa/disable { password, code }
auth2faRouter.post('/2fa/disable', authMiddleware, async (req, res, next) => {
  try {
    const { password, code } = req.body || {};
    if (typeof password !== 'string' || !password || typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ error: 'Mot de passe et code requis' });
    }
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (!user.totp_enabled) return res.status(400).json({ error: 'La double authentification n\'est pas activée' });

    if (!(await bcrypt.compare(password, user.password_hash))) {
      return res.status(403).json({ error: 'Mot de passe incorrect' });
    }

    const totpCheck = totp.verifyUserTotp(db, user, code);
    const recCheck = !totpCheck.valid ? totp.verifyAndConsumeRecoveryCode(user.recovery_codes, code) : { valid: false };
    if (!totpCheck.valid && !recCheck.valid) {
      return res.status(400).json({ error: 'Code 2FA invalide' });
    }

    totp.clearReplayCache(user.id);
    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = NULL, totp_last_step = NULL WHERE id = ?')
      .run(user.id);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/2fa/verify { challenge, code | recoveryCode }
auth2faRouter.post('/2fa/verify', (req, res, next) => {
  try {
    const { challenge, code, recoveryCode } = req.body || {};
    if (typeof challenge !== 'string' || !challenge) {
      return res.status(400).json({ error: 'Challenge requis' });
    }
    if (!code && !recoveryCode) {
      return res.status(400).json({ error: 'Code requis' });
    }

    let claims;
    try {
      claims = jwt.verify(challenge, getJwtSecret());
    } catch {
      logActivity({ ip: req.ip, action: 'POST /api/auth/2fa/verify', status: 401, details: { reason: 'invalid_challenge' } });
      return res.status(401).json({ error: 'Session 2FA expirée ou invalide' });
    }

    if (!claims || claims.purpose !== '2fa' || !claims.id) {
      return res.status(401).json({ error: 'Challenge 2FA invalide' });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(claims.id);
    if (!user || user.disabled || !user.totp_enabled || (claims.tv || 0) !== (user.token_version || 0)) {
      logActivity({
        userId: user?.id || null,
        username: user?.username || null,
        ip: req.ip,
        action: 'POST /api/auth/2fa/verify',
        status: 401,
        details: { reason: user?.disabled ? 'disabled' : 'invalid_user' },
      });
      return res.status(401).json({ error: 'Session invalide ou compte désactivé' });
    }

    if (recoveryCode) {
      const check = totp.verifyAndConsumeRecoveryCode(user.recovery_codes, recoveryCode);
      if (!check.valid) {
        logActivity({
          userId: user.id,
          username: user.username,
          ip: req.ip,
          action: 'POST /api/auth/2fa/verify',
          status: 401,
          details: { method: 'recovery' },
        });
        return res.status(401).json({ error: 'Code de secours invalide' });
      }
      db.prepare("UPDATE users SET recovery_codes = ?, last_login_at = datetime('now') WHERE id = ?")
        .run(check.remainingHashesJson, user.id);
      logActivity({
        userId: user.id,
        username: user.username,
        ip: req.ip,
        action: 'POST /api/auth/2fa/verify',
        status: 200,
        details: { method: 'recovery' },
      });
      return res.json({ token: signUserToken(user), username: user.username, role: user.role || 'admin' });
    }

    const check = totp.verifyUserTotp(db, user, code);
    if (!check.valid) {
      logActivity({
        userId: user.id,
        username: user.username,
        ip: req.ip,
        action: 'POST /api/auth/2fa/verify',
        status: 401,
        details: { method: 'totp', replayed: !!check.replayed },
      });
      return res.status(401).json({ error: check.replayed ? 'Ce code a déjà été utilisé' : 'Code 2FA invalide' });
    }

    db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
    logActivity({
      userId: user.id,
      username: user.username,
      ip: req.ip,
      action: 'POST /api/auth/2fa/verify',
      status: 200,
      details: { method: 'totp' },
    });
    res.json({ token: signUserToken(user), username: user.username, role: user.role || 'admin' });
  } catch (err) {
    next(err);
  }
});

// ─── Gestion des utilisateurs (/api/users) ────────────────────────────────────
const usersRouter = express.Router();

// GET /api/users
usersRouter.get('/', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT id, username, role, disabled, totp_enabled, created_at, last_login_at
      FROM users ORDER BY created_at ASC, rowid ASC
    `).all();
    const permRows = db.prepare('SELECT user_id, server_id, perms FROM server_permissions').all();
    const permsByUser = new Map();
    for (const p of permRows) {
      const list = Array.from(parsePerms(p.perms));
      if (list.length === 0) continue;
      if (!permsByUser.has(p.user_id)) permsByUser.set(p.user_id, {});
      permsByUser.get(p.user_id)[p.server_id] = list;
    }
    res.json(rows.map(u => formatUser(u, permsByUser)));
  } catch (err) {
    next(err);
  }
});

// POST /api/users { username, password, role }
usersRouter.post('/', authMiddleware, async (req, res, next) => {
  try {
    const { username, password, role = 'user' } = req.body || {};
    const validUsername = validate.str(username, { max: 64, field: 'username', noNewlines: true });
    if (validUsername.length < 3) {
      return res.status(400).json({ error: 'Nom d\'utilisateur trop court (min 3 caractères)' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Mot de passe trop court (min 8 caractères)' });
    }
    const validRole = validate.oneOf(role, ROLES, 'role');

    const db = getDb();
    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(validUsername);
    if (exists) {
      return res.status(409).json({ error: 'Ce nom d\'utilisateur existe déjà' });
    }

    const id = crypto.randomUUID();
    const hash = await bcrypt.hash(password, 10);
    db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(id, validUsername, hash, validRole);

    const created = db.prepare('SELECT id, username, role, disabled, totp_enabled, created_at, last_login_at FROM users WHERE id = ?').get(id);
    res.status(201).json({ ...formatUser(created), permissions: {} });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/users/:uid { role?, disabled?, password? }
usersRouter.patch('/:uid', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.uid);
    if (!target) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const body = req.body || {};
    const sets = [];
    const vals = [];

    if (body.role !== undefined) {
      const nextRole = validate.oneOf(body.role, ROLES, 'role');
      if (target.role === 'admin' && nextRole !== 'admin') {
        if (target.id === req.user.id) {
          return res.status(400).json({ error: 'Impossible de modifier votre propre rôle' });
        }
        const otherAdmins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?").get(target.id).n;
        if (otherAdmins === 0) {
          return res.status(400).json({ error: 'Impossible de rétrograder le dernier administrateur' });
        }
      }
      sets.push('role = ?');
      vals.push(nextRole);
    }

    let bumpTokenVersion = false;
    if (body.disabled !== undefined) {
      const nextDisabled = validate.bool(body.disabled, 'disabled') ? 1 : 0;
      if (nextDisabled === 1) {
        if (target.id === req.user.id) {
          return res.status(400).json({ error: 'Impossible de désactiver votre propre compte' });
        }
        if (target.role === 'admin') {
          const otherAdmins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?").get(target.id).n;
          if (otherAdmins === 0) {
            return res.status(400).json({ error: 'Impossible de désactiver le dernier administrateur' });
          }
        }
        bumpTokenVersion = true;
      }
      sets.push('disabled = ?');
      vals.push(nextDisabled);
    }

    if (body.password !== undefined) {
      if (typeof body.password !== 'string' || body.password.length < 8) {
        return res.status(400).json({ error: 'Mot de passe trop court (min 8 caractères)' });
      }
      sets.push('password_hash = ?');
      vals.push(await bcrypt.hash(body.password, 10));
      bumpTokenVersion = true;
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'Aucun champ modifiable fourni' });
    }
    if (bumpTokenVersion) {
      sets.push('token_version = token_version + 1');
    }

    vals.push(target.id);
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

    const updated = db.prepare('SELECT id, username, role, disabled, totp_enabled, created_at, last_login_at FROM users WHERE id = ?').get(target.id);
    res.json(formatUser(updated));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/users/:uid
usersRouter.delete('/:uid', authMiddleware, (req, res, next) => {
  try {
    if (req.params.uid === req.user.id) {
      return res.status(400).json({ error: 'Impossible de supprimer votre propre compte' });
    }
    const db = getDb();
    const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.params.uid);
    if (!target) return res.status(404).json({ error: 'Utilisateur introuvable' });

    if (target.role === 'admin') {
      const otherAdmins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND id != ?").get(target.id).n;
      if (otherAdmins === 0) {
        return res.status(400).json({ error: 'Impossible de supprimer le dernier administrateur' });
      }
    }

    db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PUT /api/users/:uid/servers/:id { perms: [] }
usersRouter.put('/:uid/servers/:id', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.uid);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const server = db.prepare('SELECT id FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });

    const { perms } = req.body || {};
    if (!Array.isArray(perms)) {
      return res.status(400).json({ error: '«perms» doit être un tableau' });
    }
    const unique = [];
    const seen = new Set();
    for (const p of perms) {
      if (typeof p !== 'string' || !VALID_PERMS.has(p)) {
        return res.status(400).json({ error: `Permission inconnue : ${p}` });
      }
      if (!seen.has(p)) {
        seen.add(p);
        unique.push(p);
      }
    }

    if (unique.length === 0) {
      db.prepare('DELETE FROM server_permissions WHERE user_id = ? AND server_id = ?').run(user.id, server.id);
    } else {
      db.prepare(`
        INSERT INTO server_permissions (user_id, server_id, perms)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, server_id) DO UPDATE SET perms = excluded.perms
      `).run(user.id, server.id, unique.join(','));
    }

    res.json({ ok: true, user_id: user.id, server_id: server.id, perms: unique });
  } catch (err) {
    next(err);
  }
});

// ─── Journal d'activité (/api/activity) ───────────────────────────────────────
const activityRouter = express.Router();

// GET /api/activity?user=&server=&action=&from=&to=&page=1&limit=50
activityRouter.get('/', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const where = [];
    const args = [];

    if (req.query.user) {
      const u = String(req.query.user).trim();
      if (u) {
        where.push('(a.user_id = ? OR a.username LIKE ?)');
        args.push(u, `%${u}%`);
      }
    }
    if (req.query.server) {
      where.push('a.server_id = ?');
      args.push(String(req.query.server).trim());
    }
    if (req.query.action) {
      where.push('a.action LIKE ?');
      args.push(`%${String(req.query.action).trim()}%`);
    }
    const fromBound = normalizeDateBound(req.query.from, false);
    if (fromBound) {
      where.push('a.at >= ?');
      args.push(fromBound);
    }
    const toBound = normalizeDateBound(req.query.to, true);
    if (toBound) {
      where.push('a.at <= ?');
      args.push(toBound);
    }

    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50));
    const offset = (page - 1) * limit;
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = db.prepare(`SELECT COUNT(*) AS n FROM activity_log a ${whereSql}`).get(...args).n;
    const rows = db.prepare(`
      SELECT a.*, s.name AS server_name
      FROM activity_log a
      LEFT JOIN servers s ON s.id = a.server_id
      ${whereSql}
      ORDER BY a.at DESC, a.id DESC
      LIMIT ? OFFSET ?
    `).all(...args, limit, offset);

    const items = rows.map(r => {
      let details = null;
      if (r.details) {
        try { details = JSON.parse(r.details); } catch { details = null; }
      }
      return { ...r, details };
    });

    res.json({
      items,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = [
  { mount: '/api/auth', router: auth2faRouter },
  { mount: '/api/users', router: usersRouter },
  { mount: '/api/activity', router: activityRouter },
];
