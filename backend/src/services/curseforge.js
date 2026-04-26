const axios = require('axios');

const BASE_URL = 'https://api.curseforge.com';
const MINECRAFT_GAME_ID = 432;
const MODPACKS_CLASS_ID = 4471;

// Mapping catégorie générique → categoryId CurseForge
const CF_CATEGORY_IDS = {
  'adventure':    4475,
  'technology':   4472,
  'magic':        4484,
  'exploration':  4476,
  'combat':       4792,
  'quests':       4718,
  'multiplayer':  4498,
  'challenging':  4730,
  'kitchen-sink': 4478,
  'lightweight':  5128,
  'sci-fi':       4695,
};

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

async function searchModpacks(apiKey, { query = '', mcVersion, loader, category, sortField = 2, pageSize = 20, index = 0 } = {}) {
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
  if (mcVersion) params.gameVersion = mcVersion.split(',')[0].trim(); // CurseForge accepte 1 version
  if (category) {
    // Prend le premier categoryId valide parmi les catégories sélectionnées
    const cats = category.split(',').map(c => c.trim());
    const catId = cats.map(c => CF_CATEGORY_IDS[c]).find(Boolean);
    if (catId) params.categoryId = catId;
  }
  // CurseForge ne filtre pas par loader nativement

  const res = await client.get('/v1/mods/search', { params });
  return {
    data: res.data.data.map(normalizeModpack),
    pagination: res.data.pagination,
  };
}

async function getModpack(apiKey, modpackId) {
  if (!apiKey) return null;
  const client = createClient(apiKey);
  const [modRes, descRes] = await Promise.allSettled([
    client.get(`/v1/mods/${modpackId}`),
    client.get(`/v1/mods/${modpackId}/description`),
  ]);
  if (modRes.status !== 'fulfilled') return null;
  const normalized = normalizeModpack(modRes.value.data.data);
  if (descRes.status === 'fulfilled') {
    // L'API renvoie du HTML — on le garde tel quel, le frontend le rendra
    normalized.description = descRes.value.data.data || null;
    normalized.descriptionIsHtml = true;
  }
  return normalized;
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
    if (i.gameVersion && /^1\.\d+/.test(i.gameVersion)) {
      versions.add(i.gameVersion);
    }
  });
  return [...versions];
}

async function getModList(apiKey, modpackId) {
  if (!apiKey) return [];

  const modListCache = require('./modListCache');
  const cacheKey = `curseforge:${modpackId}`;
  const cached = modListCache.get(cacheKey);
  if (cached) return cached;

  const client = createClient(apiKey);

  // 1. Récupère les fichiers du modpack
  const files = await getModpackFiles(apiKey, modpackId);
  const latest = files.find(f => !f.isServerPack) || files[0];
  if (!latest?.downloadUrl) return [];

  // 2. Télécharge et parse uniquement manifest.json via Range requests
  const axios = require('axios');
  const manifest = await extractCfManifest(axios, latest.downloadUrl);
  if (!manifest) return [];

  const projectIds = (manifest.files || []).map(f => f.projectID).filter(Boolean);
  if (!projectIds.length) return [];

  // 3. Batch fetch en parallèle
  const batches = [];
  for (let i = 0; i < projectIds.length; i += 50) batches.push(projectIds.slice(i, i + 50));

  const results = await Promise.allSettled(
    batches.map(batch => client.post('/v1/mods', { modIds: batch }))
  );

  const mods = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      mods.push(...(r.value.data?.data || []).map(m => ({
        id: String(m.id),
        name: m.name,
        summary: m.summary || '',
        thumbnailUrl: m.logo?.thumbnailUrl || m.logo?.url || null,
        downloadCount: m.downloadCount || 0,
        slug: m.slug || null,
        websiteUrl: m.links?.websiteUrl || null,
      })));
    }
  }

  const sorted = mods.sort((a, b) => a.name.localeCompare(b.name));
  modListCache.set(cacheKey, sorted);
  return sorted;
}

// Extrait manifest.json depuis un zip CurseForge via Range requests HTTP
async function extractCfManifest(axios, url) {
  try {
    const zlib = require('zlib');
    const head = await axios.head(url, { timeout: 10000 }).catch(() => null);
    const supportsRange = head?.headers?.['accept-ranges'] === 'bytes';
    const fileSize = parseInt(head?.headers?.['content-length'] || '0', 10);

    if (!supportsRange || !fileSize) {
      const AdmZip = require('adm-zip');
      const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
      const zip = new AdmZip(Buffer.from(res.data));
      const entry = zip.getEntry('manifest.json');
      return entry ? JSON.parse(entry.getData().toString('utf8')) : null;
    }

    // Lire EOCD
    const eocdSize = Math.min(65557, fileSize);
    const eocdRes = await axios.get(url, {
      responseType: 'arraybuffer', timeout: 15000,
      headers: { Range: `bytes=${fileSize - eocdSize}-${fileSize - 1}` },
    });
    const eocdBuf = Buffer.from(eocdRes.data);
    let eocdOffset = -1;
    for (let i = eocdBuf.length - 22; i >= 0; i--) {
      if (eocdBuf.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
    }
    if (eocdOffset < 0) throw new Error('EOCD not found');

    const cdOffset = eocdBuf.readUInt32LE(eocdOffset + 16);
    const cdSize   = eocdBuf.readUInt32LE(eocdOffset + 12);

    // Lire Central Directory
    const cdRes = await axios.get(url, {
      responseType: 'arraybuffer', timeout: 15000,
      headers: { Range: `bytes=${cdOffset}-${cdOffset + cdSize - 1}` },
    });
    const cdBuf = Buffer.from(cdRes.data);

    // Trouver manifest.json
    let pos = 0, localHeaderOffset = -1, compressedSize = 0, compressionMethod = 0;
    while (pos < cdBuf.length - 4) {
      if (cdBuf.readUInt32LE(pos) !== 0x02014b50) break;
      const method     = cdBuf.readUInt16LE(pos + 10);
      const cSize      = cdBuf.readUInt32LE(pos + 20);
      const fnLen      = cdBuf.readUInt16LE(pos + 28);
      const extraLen   = cdBuf.readUInt16LE(pos + 30);
      const commentLen = cdBuf.readUInt16LE(pos + 32);
      const lhOffset   = cdBuf.readUInt32LE(pos + 42);
      const filename   = cdBuf.slice(pos + 46, pos + 46 + fnLen).toString('utf8');
      if (filename === 'manifest.json') {
        localHeaderOffset = lhOffset; compressedSize = cSize; compressionMethod = method;
      }
      pos += 46 + fnLen + extraLen + commentLen;
    }
    if (localHeaderOffset < 0) return null;

    // Lire Local File Header
    const lhRes = await axios.get(url, {
      responseType: 'arraybuffer', timeout: 15000,
      headers: { Range: `bytes=${localHeaderOffset}-${localHeaderOffset + 29}` },
    });
    const lhBuf = Buffer.from(lhRes.data);
    const dataOffset = localHeaderOffset + 30 + lhBuf.readUInt16LE(26) + lhBuf.readUInt16LE(28);

    // Lire les données compressées
    const dataRes = await axios.get(url, {
      responseType: 'arraybuffer', timeout: 15000,
      headers: { Range: `bytes=${dataOffset}-${dataOffset + compressedSize - 1}` },
    });
    const compressed = Buffer.from(dataRes.data);
    const jsonBuf = compressionMethod === 8 ? zlib.inflateRawSync(compressed) : compressed;
    return JSON.parse(jsonBuf.toString('utf8'));
  } catch (_) {
    try {
      const AdmZip = require('adm-zip');
      const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
      const zip = new AdmZip(Buffer.from(res.data));
      const entry = zip.getEntry('manifest.json');
      return entry ? JSON.parse(entry.getData().toString('utf8')) : null;
    } catch (__) { return null; }
  }
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

module.exports = { searchModpacks, getModpack, getModpackFiles, getFileById, getModList, testConnection };
