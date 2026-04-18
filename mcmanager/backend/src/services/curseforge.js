const axios = require('axios');

const BASE_URL = 'https://api.curseforge.com';
const MINECRAFT_GAME_ID = 432;
const MODPACKS_CLASS_ID = 4471;

function createClient(apiKey) {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      'x-api-key': apiKey,
      'Accept': 'application/json',
    },
    timeout: 15000,
  });
}

async function searchModpacks(apiKey, { query = '', mcVersion, sortField = 2, pageSize = 20, index = 0 } = {}) {
  if (!apiKey) return { data: [], pagination: { total: 0 } };
  const client = createClient(apiKey);
  const params = {
    gameId: MINECRAFT_GAME_ID,
    classId: MODPACKS_CLASS_ID,
    searchFilter: query || undefined,
    sortField,
    sortOrder: 'desc',
    pageSize,
    index,
  };
  if (mcVersion) params.gameVersion = mcVersion;

  const res = await client.get('/v1/mods/search', { params });
  return {
    data: res.data.data.map(normalizeModpack),
    pagination: res.data.pagination,
  };
}

async function getModpack(apiKey, modpackId) {
  if (!apiKey) return null;
  const client = createClient(apiKey);
  const res = await client.get(`/v1/mods/${modpackId}`);
  return normalizeModpack(res.data.data);
}

async function getModpackFiles(apiKey, modpackId) {
  if (!apiKey) return [];
  const client = createClient(apiKey);
  const res = await client.get(`/v1/mods/${modpackId}/files`, {
    params: { gameVersion: undefined, pageSize: 50 }
  });
  return res.data.data.map(f => {
    const gv = f.gameVersions || [];
    return {
      id: String(f.id),
      displayName: f.displayName,
      fileName: f.fileName,
      fileDate: f.fileDate,
      downloadUrl: f.downloadUrl,
      isServerPack: f.isServerPack || false,
      serverPackFileId: f.serverPackFileId ? String(f.serverPackFileId) : null,
      gameVersions: gv,
      mcVersions: gv.filter(v => /^1\.\d+/.test(v)),
      loaders: detectLoaders(gv),
      releaseType: f.releaseType,
      fileSize: f.fileLength,
    };
  });
}

async function getFileById(apiKey, modpackId, fileId) {
  if (!apiKey) return null;
  const client = createClient(apiKey);
  const res = await client.get(`/v1/mods/${modpackId}/files/${fileId}`);
  const f = res.data.data;
  return {
    id: String(f.id),
    displayName: f.displayName,
    fileName: f.fileName,
    downloadUrl: f.downloadUrl,
    isServerPack: f.isServerPack || false,
    gameVersions: f.gameVersions || [],
    fileSize: f.fileLength,
  };
}

function normalizeModpack(data) {
  const thumbUrl = data.logo?.thumbnailUrl || data.logo?.url || null;
  const latestFiles = data.latestFiles || [];
  const serverPack = latestFiles.find(f => f.isServerPack);

  return {
    id: String(data.id),
    source: 'curseforge',
    name: data.name,
    summary: data.summary,
    description: null,
    thumbnailUrl: thumbUrl,
    screenshots: (data.screenshots || []).map(s => s.url),
    downloadCount: data.downloadCount || 0,
    categories: (data.categories || []).map(c => c.name),
    mcVersions: extractMcVersions(data.latestFilesIndexes || []),
    latestVersion: data.latestFilesIndexes?.[0]?.filename || null,
    latestVersionId: data.latestFilesIndexes?.[0]?.fileId ? String(data.latestFilesIndexes[0].fileId) : null,
    hasServerPack: !!serverPack,
    websiteUrl: data.links?.websiteUrl || null,
    authors: (data.authors || []).map(a => a.name),
    slug: data.slug || null,
  };
}

function detectLoaders(versions = []) {
  const v = versions.map(s => s.toLowerCase());
  const loaders = [];
  if (v.some(s => s === 'neoforge')) loaders.push('neoforge');
  if (v.some(s => s === 'forge')) loaders.push('forge');
  if (v.some(s => s === 'fabric')) loaders.push('fabric');
  if (v.some(s => s === 'quilt')) loaders.push('quilt');
  return loaders;
}

function extractMcVersions(indexes) {
  const versions = new Set();
  indexes.forEach(i => {
    if (i.gameVersion && /^\d+\.\d+/.test(i.gameVersion)) {
      versions.add(i.gameVersion);
    }
  });
  return [...versions];
}

async function testConnection(apiKey) {
  if (!apiKey) return { ok: false, error: 'Clé API manquante' };
  try {
    const client = createClient(apiKey);
    // Teste un endpoint qui requiert réellement la clé API
    await client.get('/v1/mods/search', {
      params: { gameId: MINECRAFT_GAME_ID, classId: MODPACKS_CLASS_ID, pageSize: 1 }
    });
    return { ok: true };
  } catch (err) {
    const status = err.response?.status;
    if (status === 403) return { ok: false, error: 'Clé API invalide ou non activée (403 Forbidden)' };
    if (status === 401) return { ok: false, error: 'Clé API refusée (401 Unauthorized)' };
    return { ok: false, error: err.response?.data || err.message };
  }
}

module.exports = { searchModpacks, getModpack, getModpackFiles, getFileById, testConnection };
