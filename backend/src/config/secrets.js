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

function loadOrCreateSecrets() {
  fs.mkdirSync(DATA_PATH, { recursive: true });

  let stored = {};
  if (fs.existsSync(SECRETS_FILE)) {
    try {
      stored = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
    } catch {
      stored = {};
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
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(stored, null, 2), { mode: 0o600 });
  }

  // Injecte dans process.env (priorité à l'env existant)
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = stored.jwt_secret;
  if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = stored.encryption_key;

  return stored;
}

/**
 * Secret JWT unique pour tout le backend. Jamais de valeur par défaut : un secret connu
 * ("change-me") permettrait de forger un token admin. loadOrCreateSecrets() le garantit au démarrage.
 */
function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET absent ou trop court (min 32 caractères) — loadOrCreateSecrets() doit être appelé au démarrage');
  }
  return secret;
}

module.exports = { loadOrCreateSecrets, getJwtSecret };
