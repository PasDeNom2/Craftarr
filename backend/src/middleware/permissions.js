// Contrôle d'accès centralisé (rôles + permissions par serveur) et journalisation des actions.
const { getDb } = require('../config/database');
const { verifyUserToken } = require('../config/secrets');

const ALL_PERMS = ['view', 'console', 'power', 'files', 'players', 'backups', 'manage'];
const VALID_PERMS = new Set(ALL_PERMS);

const ADMIN_PREFIXES = ['/settings', '/sources', '/users', '/activity', '/offsite', '/router', '/backups/orphans'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Découpe la colonne `perms` (virgules) en ensemble de permissions valides. */
function parsePerms(raw) {
  const set = new Set();
  for (const part of String(raw || '').split(',')) {
    const p = part.trim();
    if (VALID_PERMS.has(p)) set.add(p);
  }
  return set;
}

/** Charge les permissions par serveur pour un utilisateur non-admin. */
function loadUserServerPerms(userId) {
  const db = getDb();
  const rows = db.prepare('SELECT server_id, perms FROM server_permissions WHERE user_id = ?').all(userId);
  const map = new Map();
  const allowedIds = new Set();
  for (const r of rows) {
    const set = parsePerms(r.perms);
    if (set.size > 0) {
      map.set(r.server_id, set);
      allowedIds.add(r.server_id);
    }
  }
  return { map, allowedIds };
}

/** Vérifie une permission pour un utilisateur (HTTP ou Socket.io). */
function hasServerPerm(user, serverId, perm) {
  if (!user || !serverId) return false;
  try {
    const db = getDb();
    const row = db.prepare('SELECT role, disabled FROM users WHERE id = ?').get(user.id);
    if (!row || row.disabled) return false;
    if (row.role === 'admin') return true;
    const permRow = db.prepare('SELECT perms FROM server_permissions WHERE user_id = ? AND server_id = ?').get(user.id, serverId);
    return parsePerms(permRow?.perms).has(perm);
  } catch {
    return false;
  }
}

/** Normalise le chemin d'une requête API en motif avec `:id` et extrait un éventuel serverId. */
function normalizeActionPath(apiPath) {
  const clean = (apiPath || '/').replace(/\/+$/, '') || '/';
  const segs = clean.split('/').filter(Boolean);
  let serverId = null;

  if (segs[0] === 'servers' && segs[1]) {
    serverId = segs[1];
    segs[1] = ':id';
    if (segs[2] === 'backups' && segs[3]) segs[3] = ':id';
    else if (segs[2] === 'schedules' && segs[3]) segs[3] = ':id';
    else if (segs[2] === 'profiles' && segs[3] && segs[3] !== 'new') segs[3] = ':id';
    else if ((segs[2] === 'players' || segs[2] === 'whitelist') && segs[3]) segs[3] = ':id';
  } else if (segs[0] === 'users' && segs[1]) {
    segs[1] = ':id';
    if (segs[2] === 'servers' && segs[3]) {
      serverId = segs[3];
      segs[3] = ':id';
    }
  } else if (segs[0] === 'sources' && segs[1] && !['export', 'import'].includes(segs[1])) {
    segs[1] = ':id';
  } else if (segs[0] === 'backups' && segs[1] === 'orphans' && segs[2]) {
    segs[2] = ':id';
  }

  for (let i = 0; i < segs.length; i++) {
    if (UUID_RE.test(segs[i])) segs[i] = ':id';
  }

  return { normalized: '/api/' + segs.join('/'), serverId };
}

/** Enregistre une entrée dans `activity_log` sans jamais lever d'exception vers la route. */
function logActivity({ userId = null, username = null, ip = null, action, serverId = null, status = null, details = null }) {
  try {
    const serialized = details ? JSON.stringify(details) : null;
    getDb().prepare(`
      INSERT INTO activity_log (user_id, username, ip, action, server_id, status, details)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, username, ip, action, serverId, status, serialized);
  } catch {
    // Ne jamais bloquer une requête à cause du journal
  }
}

/**
 * Découpe le chemin en segments décodés : les doubles slash et le slash final disparaissent,
 * l'encodage (%xx) est résolu segment par segment (un %2F reste DANS son segment, comme le fait
 * le routeur Express pour les paramètres). Retourne null si l'encodage est invalide.
 * La comparaison des motifs se fait en minuscules : le routeur Express n'est pas sensible à la casse.
 */
function pathSegments(rawPath) {
  const segs = [];
  for (const part of String(rawPath || '/').split('/')) {
    if (!part) continue;
    try { segs.push(decodeURIComponent(part)); } catch { return null; }
  }
  return segs;
}

const SIGNED_DOWNLOAD = (l) => (
  (l.length === 3 && l[0] === 'servers' && l[2] === 'world-download') ||
  (l.length === 4 && l[0] === 'servers' && l[2] === 'files' && l[3] === 'download') ||
  (l.length === 5 && l[0] === 'backups' && l[1] === 'orphans' && l[4] === 'download')
);

const PUBLIC_AUTH = new Set(['setup-needed', 'setup', 'login']);

function isPublicOrSignedRoute(method, l, req) {
  if (l.length === 1 && l[0] === 'health') return true;
  if (l[0] === 'auth' && l.length === 2 && PUBLIC_AUTH.has(l[1])) return true;
  if (l[0] === 'auth' && l.length === 3 && l[1] === '2fa' && l[2] === 'verify') return true;
  const isGet = method === 'GET' || method === 'HEAD';
  if (isGet && l.length === 3 && l[0] === 'servers' && l[2] === 'icon') return true;
  if (isGet && req.query?.token && SIGNED_DOWNLOAD(l)) return true;
  return false;
}

const ADMIN_PREFIX_SEGS = ADMIN_PREFIXES.map(pfx => pfx.split('/').filter(Boolean));

/**
 * Détermine la règle de permission requise pour une requête authentifiée non-admin.
 * @param {string} method
 * @param {string[]} segs segments décodés (casse d'origine, pour l'identifiant du serveur)
 */
function requiredPermission(method, segs) {
  const l = segs.map(s => s.toLowerCase());
  if (l.length === 1 && l[0] === 'servers' && method === 'POST') return 'admin';
  for (const pfx of ADMIN_PREFIX_SEGS) {
    if (pfx.every((seg, i) => l[i] === seg)) return 'admin';
  }

  if (l[0] !== 'servers' || l.length < 2) return null; // autres routes authentifiées (/servers GET, /catalog, /vanilla, /auth/me...)

  const serverId = segs[1];
  const sub = l.slice(2);
  const s0 = sub[0];
  const isGet = method === 'GET' || method === 'HEAD';

  if (sub.length === 0 && method === 'DELETE') return 'admin';
  if (s0 === 'files') return { serverId, perm: 'files' };
  // Lecture de rapports de crash / logs : équivalent à un accès fichiers
  if (s0 === 'diagnostics' && sub[1] === 'file') return { serverId, perm: 'files' };
  if (isGet) return { serverId, perm: 'view' };
  if (method === 'POST' && sub.length === 1 && (s0 === 'rcon' || s0 === 'console')) return { serverId, perm: 'console' };
  if (method === 'POST' && sub.length === 1 && ['start', 'stop', 'restart'].includes(s0)) return { serverId, perm: 'power' };
  if (s0 === 'players' || s0 === 'whitelist') return { serverId, perm: 'players' };
  if (
    (s0 === 'backup' && sub.length === 1) || s0 === 'backups' ||
    (s0 && s0.startsWith('world-')) || s0 === 'offsite'
  ) {
    return { serverId, perm: 'backups' };
  }
  return { serverId, perm: 'manage' };
}

function permissionsMiddleware(req, res, next) {
  const method = req.method.toUpperCase();
  const segs = pathSegments(req.path);
  if (!segs) return res.status(400).json({ error: 'Chemin invalide' });
  const lower = segs.map(s => s.toLowerCase());
  const p = '/' + segs.join('/');

  if (isPublicOrSignedRoute(method, lower, req)) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // Laisse les routes sans jeton (ex. download sans ?token=) gérer leur 401 si besoin
    if ((method === 'GET' || method === 'HEAD') && SIGNED_DOWNLOAD(lower)) {
      return next();
    }
    return res.status(401).json({ error: 'Token manquant' });
  }

  let user;
  try {
    user = verifyUserToken(authHeader.slice(7));
  } catch (err) {
    const disabled = err?.message === 'compte désactivé';
    return res.status(401).json({ error: disabled ? 'Compte désactivé' : 'Token invalide ou expiré' });
  }

  req.user = user;

  // Journalisation de toute requête non-GET authentifiée (sans corps ni secret)
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const { normalized, serverId } = normalizeActionPath(p);
    res.on('finish', () => {
      logActivity({
        userId: user.id,
        username: user.username,
        ip: req.ip,
        action: `${method} ${normalized}`,
        serverId,
        status: res.statusCode,
        details: null,
      });
    });
  }

  if (user.role === 'admin') {
    req.allowedServerIds = null;
    req.permsFor = () => [...ALL_PERMS];
    return next();
  }

  const { map, allowedIds } = loadUserServerPerms(user.id);
  req.serverPerms = map;
  req.allowedServerIds = allowedIds;
  req.permsFor = (serverId) => Array.from(map.get(serverId) || []);

  const reqRule = requiredPermission(method, segs);
  if (reqRule === 'admin') {
    return res.status(403).json({ error: 'Accès réservé aux administrateurs' });
  }
  if (reqRule && !map.get(reqRule.serverId)?.has(reqRule.perm)) {
    return res.status(403).json({ error: 'Permission refusée' });
  }

  return next();
}

module.exports = Object.assign(permissionsMiddleware, {
  ALL_PERMS,
  VALID_PERMS,
  parsePerms,
  hasServerPerm,
  logActivity,
  normalizeActionPath,
});
