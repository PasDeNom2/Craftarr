const { getDb } = require('../config/database');
const { decrypt } = require('../config/encryption');
const curseforge = require('./curseforge');
const modrinth = require('./modrinth');
const { fetchCustomSource } = require('./sourceMapper');

function getActiveSources() {
  const db = getDb();
  return db.prepare('SELECT * FROM api_sources WHERE enabled = 1').all();
}

function getSourceApiKey(source) {
  if (!source.api_key_encrypted) {
    // Fallback sur les env vars pour les sources built-in
    if (source.id === 'curseforge') return process.env.CURSEFORGE_API_KEY || '';
    if (source.id === 'modrinth') return process.env.MODRINTH_API_KEY || '';
    return '';
  }
  return decrypt(source.api_key_encrypted) || '';
}

async function fetchFromSource(source, searchParams) {
  const apiKey = getSourceApiKey(source);

  try {
    if (source.id === 'curseforge' || (source.format === 'curseforge' && source.is_builtin)) {
      if (!apiKey) { console.warn('[Aggregator] CurseForge : clé API manquante'); return []; }
      const res = await curseforge.searchModpacks(apiKey, searchParams);
      return res.data;
    }

    if (source.id === 'modrinth' || source.format === 'modrinth') {
      const res = await modrinth.searchModpacks(apiKey, searchParams);
      return res.data;
    }

    // Source custom
    return await fetchCustomSource(source, searchParams.query);
  } catch (err) {
    const status = err.response?.status;
    if (status === 403 || status === 401) {
      console.error(`[Aggregator] ${source.name} : clé API rejetée (${status}) — vérifiez la clé dans Paramètres`);
    } else {
      console.error(`[Aggregator] Erreur source ${source.name}:`, err.message);
    }
    return [];
  }
}

async function aggregateSearch(searchParams = {}) {
  const sources = getActiveSources();
  const results = await Promise.allSettled(
    sources.map(source => fetchFromSource(source, searchParams))
  );

  const all = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      r.value.forEach(item => {
        all.push({ ...item, _sourceName: sources[i].name });
      });
    }
  });

  // Déduplique par nom+source, trie par downloadCount
  const seen = new Set();
  return all
    .filter(item => {
      const key = `${item.source}:${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (b.downloadCount || 0) - (a.downloadCount || 0));
}

async function getModpackDetail(sourceId, modpackId) {
  const db = getDb();
  const source = db.prepare('SELECT * FROM api_sources WHERE id = ?').get(sourceId);
  if (!source) throw new Error(`Source inconnue : ${sourceId}`);

  const apiKey = getSourceApiKey(source);

  if (sourceId === 'curseforge') {
    return curseforge.getModpack(apiKey, modpackId);
  }
  if (sourceId === 'modrinth') {
    return modrinth.getModpack(apiKey, modpackId);
  }
  throw new Error(`Detail non supporté pour la source : ${sourceId}`);
}

async function getModpackVersions(sourceId, modpackId) {
  const db = getDb();
  const source = db.prepare('SELECT * FROM api_sources WHERE id = ?').get(sourceId);
  if (!source) throw new Error(`Source inconnue : ${sourceId}`);

  const apiKey = getSourceApiKey(source);

  if (sourceId === 'curseforge') {
    return curseforge.getModpackFiles(apiKey, modpackId);
  }
  if (sourceId === 'modrinth') {
    return modrinth.getVersions(apiKey, modpackId);
  }
  return [];
}

module.exports = { aggregateSearch, getModpackDetail, getModpackVersions, getActiveSources, getSourceApiKey };
