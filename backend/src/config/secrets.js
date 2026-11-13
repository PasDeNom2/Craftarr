// @ts-check
/**
 * Gestion des secrets persistants.
 * Si les variables d'env ne sont pas définies, génère des secrets
 * aléatoires au premier démarrage et les stocke dans /data/secrets.json
 * pour qu'ils soient réutilisés à chaque redémarrage du container.
 * Le compte admin n'est PAS créé ici : voir le jeton de premier démarrage (routes/auth.js).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_PATH = process.env.DATA_PATH || '/data';
const SECRETS_FILE = path.join(DATA_PATH, 'secrets.json');

/**
 * @typedef {Object} StoredSecrets
 * @property {string} [jwt_secret]
 * @property {string} [encryption_key]
 */

/**
 * Charge ou génère les secrets persistants (JWT_SECRET, ENCRYPTION_KEY) dans secrets.json.
 * @returns {StoredSecrets}
 */
function loadOrCreateSecrets() {
  const dataPath = process.env.DATA_PATH || DATA_PATH;
  const secretsFile = path.join(dataPath, 'secrets.json');
  fs.mkdirSync(dataPath, { recursive: true });

  /** @type {StoredSecrets} */
  let stored = {};
  if (fs.existsSync(secretsFile)) {
    try {
      stored = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
        throw new Error('Format JSON invalide');
      }
    } catch (err) {
      const corruptName = `secrets.json.corrupt-${Date.now()}`;
      const corruptPath = path.join(dataPath, corruptName);
      fs.renameSync(secretsFile, corruptPath);
      throw new Error(
        `secrets.json illisible : renommé en ${corruptName} ; restaurez-le depuis une sauvegarde ou supprimez-le pour régénérer (les clés API chiffrées seront perdues) — ${err.message}`
      );
    }
  }

  let changed = false;

  // JWT_SECRET
  if (!stored.jwt_secret) {
    stored.jwt_secret = crypto.randomBytes(48).toString('hex');
    changed = true;
  }

  // ENCRYPTION_KEY (exactement 32 chars)
  if (!stored.encryption_key) {
    stored.encryption_key = crypto.randomBytes(16).toString('hex'); // 32 hex chars
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(secretsFile, JSON.stringify(stored, null, 2), { mode: 0o600 });
  }

  // Injecte dans process.env (priorité à l'env existant)
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = stored.jwt_secret;
  if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = stored.encryption_key;

  return stored;
}

/**
 * Secret JWT unique pour tout le backend. Jamais de valeur par défaut : un secret connu
 * ("change-me") permettrait de forger un token admin. loadOrCreateSecrets() le garantit au démarrage.
 * @returns {string}
 */
function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET absent ou trop court (min 32 caractères) — loadOrCreateSecrets() doit être appelé au démarrage');
  }
  return secret;
}

/**
 * Vérifie un jeton de SESSION utilisateur (en-tête Authorization ou socket).
 * Refuse les jetons à usage unique (liens de téléchargement, signés avec le même secret) :
 * avant, un lien vu dans les logs du proxy ouvrait toute l'API pendant 5 minutes.
 * Refuse aussi les sessions d'avant un changement de mot de passe (token_version).
 * @param {string} token
 * @returns {{ id: string, username: string, role: string }}
 */
function verifyUserToken(token) {
  const jwt = require('jsonwebtoken');
  const claims = jwt.verify(token, getJwtSecret());
  if (claims.purpose || !claims.id) throw new Error('jeton non utilisable pour une session');
  const { getDb } = require('./database');
  const user = getDb().prepare('SELECT id, username, token_version, role, disabled FROM users WHERE id = ?').get(claims.id);
  if (!user) throw new Error('utilisateur supprimé');
  if (user.disabled) throw new Error('compte désactivé');
  if ((claims.tv || 0) !== (user.token_version || 0)) throw new Error('session révoquée');
  return { id: user.id, username: user.username, role: user.role || 'admin' };
}

/**
 * Vérifie une clé API (`cra_...`) : validité, révocation, expiration et compte actif.
 * Met à jour `last_used_at` au plus une fois par minute.
 * @param {string} rawKey
 * @returns {{ user: { id: string, username: string, role: string }, apiKey: { id: string, user_id: string, name: string, prefix: string, read_only: boolean, expires_at: string | null } }}
 */
function verifyApiKey(rawKey) {
  if (typeof rawKey !== 'string' || !/^cra_[0-9A-Za-z]{40}$/.test(rawKey)) {
    throw new Error('Clé API invalide');
  }
  const hash = hashApiKey(rawKey);
  const { getDb } = require('./database');
  const db = getDb();
  const row = db.prepare(`
    SELECT k.id, k.user_id, k.name, k.prefix, k.read_only, k.last_used_at, k.expires_at, k.revoked,
           u.id AS u_id, u.username AS u_username, u.role AS u_role, u.disabled AS u_disabled
    FROM api_keys k
    JOIN users u ON u.id = k.user_id
    WHERE k.hash = ?
  `).get(hash);

  if (!row) throw new Error('Clé API invalide');
  if (row.revoked) throw new Error('Clé API révoquée');
  if (row.expires_at) {
    const exp = parseSqliteUtc(row.expires_at);
    if (!Number.isNaN(exp) && exp <= Date.now()) {
      throw new Error('Clé API expirée');
    }
  }
  if (row.u_disabled) throw new Error('compte désactivé');

  const last = row.last_used_at ? parseSqliteUtc(row.last_used_at) : NaN;
  if (Number.isNaN(last) || Date.now() - last >= 60_000) {
    db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
  }

  return {
    user: { id: row.u_id, username: row.u_username, role: row.u_role || 'admin' },
    apiKey: {
      id: row.id,
      user_id: row.user_id,
      name: row.name,
      prefix: row.prefix,
      read_only: !!row.read_only,
      expires_at: row.expires_at || null,
    },
  };
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Génère une clé API au format `cra_` + 40 caractères base62 aléatoires.
 * @returns {string}
 */
function generateApiKey() {
  let out = 'cra_';
  while (out.length < 44) {
    const buf = crypto.randomBytes(64);
    for (let i = 0; i < buf.length && out.length < 44; i++) {
      // 248 = 62 * 4 : tirage uniforme sans biais modulo
      if (buf[i] < 248) out += BASE62[buf[i] % 62];
    }
  }
  return out;
}

/**
 * Empreinte SHA-256 hexadécimale d'une clé API.
 * @param {string} rawKey
 * @returns {string}
 */
function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(String(rawKey)).digest('hex');
}

/**
 * Parse un horodatage SQLite UTC (`YYYY-MM-DD HH:MM:SS`) ou ISO en millisecondes.
 * @param {string} raw
 * @returns {number}
 */
function parseSqliteUtc(raw) {
  if (!raw || typeof raw !== 'string') return NaN;
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`;
  return Date.parse(iso);
}

/**
 * Vérifie un jeton JWT de session ou une clé API (`cra_...`).
 * @param {string} token
 * @returns {{ user: { id: string, username: string, role: string }, apiKey: { id: string, user_id: string, name: string, prefix: string, read_only: boolean, expires_at: string | null } | null }}
 */
function verifyCredential(token) {
  if (typeof token === 'string' && token.startsWith('cra_')) {
    return verifyApiKey(token);
  }
  return { user: verifyUserToken(token), apiKey: null };
}

/**
 * Jeton de session (7 jours) pour un utilisateur.
 * @param {{ id: string, username: string, token_version?: number }} user
 * @returns {string}
 */
function signUserToken(user) {
  const jwt = require('jsonwebtoken');
  return jwt.sign({ id: user.id, username: user.username, tv: user.token_version || 0 }, getJwtSecret(), { expiresIn: '7d' });
}

module.exports = {
  verifyUserToken,
  verifyApiKey,
  verifyCredential,
  generateApiKey,
  hashApiKey,
  signUserToken, loadOrCreateSecrets, getJwtSecret };
