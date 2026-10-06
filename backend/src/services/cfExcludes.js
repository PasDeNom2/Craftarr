const fs = require('fs');
const path = require('path');
const axios = require('axios');

/**
 * Liste communautaire des mods CurseForge client-only à ne pas installer sur un serveur
 * (maintenue par itzg/docker-minecraft-server, Apache-2.0) : exclusions globales par slug,
 * et exceptions par modpack (forceIncludes) quand un pack a vraiment besoin d'un de ces mods.
 * Rafraîchie toutes les 24 h ; copie embarquée (src/assets) si GitHub est injoignable.
 */
const URL = 'https://raw.githubusercontent.com/itzg/docker-minecraft-server/master/files/cf-exclude-include.json';
const BUNDLED = path.join(__dirname, '..', 'assets', 'cf-exclude-include.json');
const TTL_MS = 24 * 60 * 60 * 1000;

let cache = null; // { at, data }

async function loadList() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  try {
    const res = await axios.get(URL, { timeout: 10000 });
    if (!Array.isArray(res.data?.globalExcludes)) throw new Error('format inattendu');
    cache = { at: Date.now(), data: res.data };
  } catch (err) {
    console.warn(`[CF excludes] Liste distante indisponible (${err.message}) — copie embarquée utilisée`);
    cache = { at: Date.now(), data: JSON.parse(fs.readFileSync(BUNDLED, 'utf8')) };
  }
  return cache.data;
}

/** Slugs à exclure et à forcer pour un modpack donné (slug du modpack, peut être null). */
async function getRules(modpackSlug) {
  const list = await loadList();
  const pack = (modpackSlug && list.modpacks?.[modpackSlug]) || {};
  return {
    excludes: new Set([...(list.globalExcludes || []), ...(pack.excludes || [])]),
    forceIncludes: new Set([...(list.globalForceIncludes || []), ...(pack.forceIncludes || [])]),
  };
}

module.exports = { getRules };
