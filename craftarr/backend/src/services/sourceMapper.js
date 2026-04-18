const axios = require('axios');
const { decrypt } = require('../config/encryption');

/**
 * Résout un chemin JSON-path simple (ex: "data.items.0.title") dans un objet
 */
function resolvePath(obj, pathStr) {
  if (!pathStr) return undefined;
  return pathStr.split('.').reduce((cur, key) => {
    if (cur == null) return undefined;
    return cur[key];
  }, obj);
}

/**
 * Mappe un item brut d'une source custom selon le field_mapping_json
 * Mapping keys attendues: name, description, thumbnailUrl, downloadUrl, version, mcVersion, id
 */
function mapItem(item, mapping) {
  const mapped = {};
  for (const [key, path] of Object.entries(mapping)) {
    mapped[key] = resolvePath(item, path);
  }
  return {
    id: String(mapped.id || item.id || ''),
    source: 'custom',
    name: mapped.name || item.name || item.title || '',
    summary: mapped.description || item.description || item.summary || '',
    thumbnailUrl: mapped.thumbnailUrl || item.thumbnailUrl || item.icon_url || null,
    downloadCount: Number(mapped.downloads || item.downloads || 0),
    categories: [],
    mcVersions: mapped.mcVersion ? [mapped.mcVersion] : [],
    latestVersion: mapped.version || null,
    hasServerPack: false,
    downloadUrl: mapped.downloadUrl || item.downloadUrl || null,
    authors: [],
    slug: mapped.id || item.id || null,
  };
}

/**
 * Récupère les modpacks depuis une source custom
 */
async function fetchCustomSource(source, searchQuery = '') {
  const apiKey = source.api_key_encrypted ? decrypt(source.api_key_encrypted) : null;
  const mapping = source.field_mapping_json ? JSON.parse(source.field_mapping_json) : {};

  const headers = { Accept: 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  let url = source.base_url;
  if (!url.endsWith('/')) url += '/';
  const searchEndpoint = mapping._searchEndpoint || 'search';
  const queryParam = mapping._queryParam || 'query';

  const params = searchQuery ? { [queryParam]: searchQuery } : {};

  try {
    const res = await axios.get(`${url}${searchEndpoint}`, { headers, params, timeout: 10000 });
    const data = res.data;

    const items = mapping._itemsPath ? resolvePath(data, mapping._itemsPath) : (Array.isArray(data) ? data : data.data || data.items || []);

    return (items || []).map(item => ({ ...mapItem(item, mapping), source: source.id }));
  } catch (err) {
    console.error(`[SourceMapper] Erreur source ${source.name}:`, err.message);
    return [];
  }
}

async function testCustomSource(source) {
  try {
    const results = await fetchCustomSource(source, 'test');
    return { ok: true, count: results.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { fetchCustomSource, mapItem, testCustomSource };
