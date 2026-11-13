/**
 * Réglages globaux de Craftarr modifiables depuis l'interface (clé → valeur texte),
 * stockés dans la table app_settings. Lecture directe en base : peu de clés, peu d'appels.
 */
const { getDb } = require('../config/database');

// Seules ces clés peuvent être lues / écrites. Les fonctionnalités ajoutent les leurs avec register().
const KEYS = new Set(['notify_webhook_url']);
// Clés secrètes (mots de passe, jetons) : chiffrées en base, jamais renvoyées par all()
const SECRET_KEYS = new Set();

/**
 * Déclare une clé de réglage. { secret: true } → chiffrée (AES-256-GCM, config/encryption)
 * et masquée dans all() (seul `has_<clé>` est exposé).
 */
function register(key, { secret = false } = {}) {
  KEYS.add(key);
  if (secret) SECRET_KEYS.add(key);
}

function get(key) {
  try {
    const raw = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? null;
    if (raw !== null && SECRET_KEYS.has(key)) return require('../config/encryption').decrypt(raw);
    return raw;
  } catch {
    return null;
  }
}

function set(key, value) {
  if (!KEYS.has(key)) throw Object.assign(new Error(`Réglage inconnu : ${key}`), { status: 400 });
  if (value === null || value === '') {
    getDb().prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  } else {
    getDb().prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, SECRET_KEYS.has(key) ? require('../config/encryption').encrypt(String(value)) : String(value));
  }
}

function all() {
  const out = {};
  for (const key of KEYS) {
    if (SECRET_KEYS.has(key)) out[`has_${key}`] = get(key) !== null;
    else out[key] = get(key);
  }
  return out;
}

module.exports = { get, set, all, register, KEYS };
