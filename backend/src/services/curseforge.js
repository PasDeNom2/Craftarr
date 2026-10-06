const axios = require('axios');
const { isMcVersion } = require('./mcVersion');

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

/** Normalise un fichier CurseForge (client pack, server pack ou mod). */
function normalizeFile(f) {
  const gv = f.gameVersions || [];
  return {
    id: String(f.id),
    displayName: f.displayName,
    fileName: f.fileName,
    fileDate: f.fileDate,
    downloadUrl: f.downloadUrl,
    isServerPack: f.isServerPack || false,
    serverPackFileId: f.serverPackFileId ? String(f.serverPackFileId) : null,
    parentProjectFileId: f.parentProjectFileId ? String(f.parentProjectFileId) : null,
    gameVersions: gv,
    mcVersions: gv.filter(isMcVersion),
    loaders: detectLoaders(gv),
    releaseType: f.releaseType,
    fileSize: f.fileLength,
  };
}

// Plafond de pagination : les très vieux packs ont des centaines de fichiers
const MAX_FILES = 500;

/**
 * Tous les fichiers d'un modpack (client packs ET server packs), du plus récent au plus ancien.
 * L'API est paginée (50 max par page) : sans pagination, une version ancienne choisie par
 * l'utilisateur était introuvable et l'installeur prenait silencieusement la dernière.
 */
async function getModpackFiles(apiKey, modpackId) {
  if (!apiKey) return [];
  const client = createClient(apiKey);
  const files = [];
  for (let index = 0; index < MAX_FILES; index += 50) {
    const res = await client.get(`/v1/mods/${modpackId}/files`, { params: { pageSize: 50, index } });
    const page = res.data.data || [];
    files.push(...page.map(normalizeFile));
    const total = res.data.pagination?.totalCount ?? 0;
    if (page.length < 50 || files.length >= total) break;
  }
  return files.sort((a, b) => new Date(b.fileDate) - new Date(a.fileDate));
}

async function getFileById(apiKey, modpackId, fileId) {
  if (!apiKey) return null;
  const client = createClient(apiKey);
  const res = await client.get(`/v1/mods/${modpackId}/files/${fileId}`);
  return normalizeFile(res.data.data);
}

/**
 * Infos projet (slug, distribution autorisée…) pour une liste de projectIDs, par lots de 50.
 * Retourne une Map projectId(string) → { slug, name, allowModDistribution }.
 */
async function getModsInfo(apiKey, modIds) {
  const client = createClient(apiKey);
  const out = new Map();
  for (let i = 0; i < modIds.length; i += 50) {
    const chunk = modIds.slice(i, i + 50);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await client.post('/v1/mods', { modIds: chunk }, { timeout: 30000 });
        for (const m of res.data.data || []) {
          out.set(String(m.id), { slug: m.slug, name: m.name, allowModDistribution: m.allowModDistribution !== false });
        }
        break;
      } catch (err) {
        if (attempt === 3) throw err;
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }
  return out;
}

/**
 * URLs de téléchargement d'un fichier CurseForge. L'API renvoie downloadUrl: null quand l'auteur
 * a désactivé la distribution tierce : le fichier reste en général servi par les CDN forgecdn.
 */
function fileUrls(file) {
  const id = parseInt(file.id, 10);
  const name = encodeURIComponent(file.fileName);
  const p = `${Math.floor(id / 1000)}/${id % 1000}/${name}`;
  return [...new Set([
    file.downloadUrl,
    `https://mediafilez.forgecdn.net/files/${p}`,
    `https://edge.forgecdn.net/files/${p}`,
  ].filter(Boolean))];
}

/** manifest.json d'un client pack, sans télécharger tout le zip quand le CDN accepte les Range. */
async function getClientManifest(file) {
  const { readZipJson } = require('./remoteZip');
  for (const url of fileUrls(file)) {
    const manifest = await readZipJson(url, 'manifest.json', file.fileSize);
    if (manifest) return manifest;
  }
  return null;
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
    if (isMcVersion(i.gameVersion)) {
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
  const latest = files.find(f => !f.isServerPack);
  if (!latest) return [];

  // 2. Télécharge et parse uniquement manifest.json via Range requests
  const manifest = await getClientManifest(latest);
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

module.exports = {
  searchModpacks, getModpack, getModpackFiles, getFileById, getModsInfo, getClientManifest, fileUrls,
  getModList, testConnection,
};
