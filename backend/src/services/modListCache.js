// Cache mémoire TTL pour les listes de mods (évite de re-télécharger le mrpack à chaque fois)
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 heure

const cache = new Map();

function get(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return entry.data;
}

function set(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

module.exports = { get, set };
