/**
 * Réglages globaux de Craftarr modifiables depuis l'interface (clé → valeur texte),
 * stockés dans la table app_settings. Lecture directe en base : peu de clés, peu d'appels.
 */
const { getDb } = require('../config/database');

// Seules ces clés peuvent être lues / écrites par l'API
const KEYS = new Set(['notify_webhook_url']);

function get(key) {
  try {
    return getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? null;
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
      .run(key, String(value));
  }
}

function all() {
  const out = {};
  for (const key of KEYS) out[key] = get(key);
  return out;
}

module.exports = { get, set, all, KEYS };
