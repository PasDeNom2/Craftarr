/**
 * Gestion des secrets persistants.
 * Si les variables d'env ne sont pas définies, génère des secrets
 * aléatoires au premier démarrage et les stocke dans /data/secrets.json
 * pour qu'ils soient réutilisés à chaque redémarrage du container.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_PATH = process.env.DATA_PATH || '/data';
const SECRETS_FILE = path.join(DATA_PATH, 'secrets.json');

function generatePassword(length = 16) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(length))
    .map(b => chars[b % chars.length])
    .join('');
}

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
  let firstRun = false;

  // JWT_SECRET
  if (!stored.jwt_secret) {
    stored.jwt_secret = crypto.randomBytes(48).toString('hex');
    changed = true;
    firstRun = true;
  }

  // ENCRYPTION_KEY (exactement 32 chars)
  if (!stored.encryption_key) {
    stored.encryption_key = crypto.randomBytes(16).toString('hex'); // 32 hex chars
    changed = true;
  }

  // ADMIN_PASSWORD : généré une seule fois, affiché au premier démarrage
  if (!stored.admin_password) {
    stored.admin_password = generatePassword(14);
    changed = true;
    firstRun = true;
  }

  // ADMIN_USERNAME : par défaut admin
  if (!stored.admin_username) {
    stored.admin_username = 'admin';
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(stored, null, 2));
  }

  // Injecte dans process.env (priorité à l'env existant)
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = stored.jwt_secret;
  if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = stored.encryption_key;
  if (!process.env.ADMIN_PASSWORD) process.env.ADMIN_PASSWORD = stored.admin_password;
  if (!process.env.ADMIN_USERNAME) process.env.ADMIN_USERNAME = stored.admin_username;

  if (firstRun) {
    console.log('');
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║           Craftarr — Premier démarrage           ║');
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║  Identifiant : ${stored.admin_username.padEnd(33)}║`);
    console.log(`║  Mot de passe : ${stored.admin_password.padEnd(32)}║`);
    console.log('║                                                  ║');
    console.log('║  Secrets sauvegardés dans /data/secrets.json     ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log('');
  }

  return stored;
}

module.exports = { loadOrCreateSecrets };
