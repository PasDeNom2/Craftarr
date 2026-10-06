const axios = require('axios');

const BASE_URL = 'https://api.modrinth.com/v2';

function createClient(apiKey) {
  const headers = { 'Accept': 'application/json' };
  if (apiKey) headers['Authorization'] = apiKey;
  return axios.create({ baseURL: BASE_URL, headers, timeout: 15000 });
}

async function searchModpacks(apiKey, { query = '', mcVersion, loader, category, limit = 20, offset = 0, sortBy = 'downloads' } = {}) {
  const client = createClient(apiKey);
  const facets = [['project_type:modpack']];
  // Chaque valeur multiple = OR dans le même tableau de facets
  if (mcVersion) facets.push(mcVersion.split(',').map(v => `versions:${v.trim()}`));
  if (loader)    facets.push(loader.split(',').map(l => `categories:${l.trim()}`));
  if (category)  facets.push(category.split(',').map(c => `categories:${c.trim()}`));

  const res = await client.get('/search', {
    params: {
      query: query || undefined,
      facets: JSON.stringify(facets),
      limit,
      offset,
      index: sortBy,
    }
  });

  return {
    data: res.data.hits.map(normalizeModpack),
    pagination: { total: res.data.total_hits, index: offset, pageSize: limit },
  };
}

async function getModpack(apiKey, projectId) {
  const client = createClient(apiKey);
  const [project, members] = await Promise.all([
    client.get(`/project/${projectId}`),
    client.get(`/project/${projectId}/members`).catch(() => ({ data: [] })),
  ]);
  return normalizeModpackDetail(project.data, members.data);
}

function normalizeVersion(v) {
  return {
    id: v.id,
    name: v.name,
    versionNumber: v.version_number,
    mcVersions: v.game_versions || [],
    loaders: v.loaders || [],
    datePublished: v.date_published,
    downloadCount: v.downloads,
    files: v.files.map(f => ({
      filename: f.filename,
      url: f.url,
      primary: f.primary,
      size: f.size,
    })),
    changelog: v.changelog || null,
  };
}

async function getVersions(apiKey, projectId) {
  const client = createClient(apiKey);
  const res = await client.get(`/project/${projectId}/version`);
  return res.data.map(normalizeVersion);
}

/** Une version précise (par id), sans dépendre de la liste complète du projet. */
async function getVersion(apiKey, versionId) {
  const client = createClient(apiKey);
  const res = await client.get(`/version/${versionId}`);
  return normalizeVersion(res.data);
}

async function getModList(apiKey, projectId) {
  const modListCache = require('./modListCache');
  const cacheKey = `modrinth:${projectId}`;
  const cached = modListCache.get(cacheKey);
  if (cached) return cached;

  const axios = require('axios');
  const client = createClient(apiKey);

  // 1. Récupère uniquement la dernière version (limit=1)
  const versionsRes = await client.get(`/project/${projectId}/version`, { params: { limit: 1 } });
  const versions = versionsRes.data;
  if (!versions.length) return [];

  // 2. Trouve le fichier mrpack
  let mrpackUrl = null;
  let mrpackSize = null;
  for (const version of versions) {
    const primary = version.files?.find(f => f.primary && f.filename?.endsWith('.mrpack'))
      || version.files?.find(f => f.filename?.endsWith('.mrpack'));
    if (primary) { mrpackUrl = primary.url; mrpackSize = primary.size; break; }
  }
  if (!mrpackUrl) return [];

  // 3. Télécharge uniquement modrinth.index.json via Range requests ZIP
  //    Évite de télécharger tout le mrpack (peut faire des centaines de Mo pour les gros packs)
  const index = await require('./remoteZip').readZipJson(mrpackUrl, 'modrinth.index.json', mrpackSize);
  if (!index) return [];

  // 4. Extrait les project IDs depuis les URLs cdn.modrinth.com
  const projectIds = [];
  const seen = new Set();
  // Fichiers hébergés ailleurs (CurseForge, GitHub…) : absents de l'API Modrinth, listés par nom de fichier
  const external = [];
  for (const file of (index.files || [])) {
    const match = (file.downloads || []).map(url => url.match(/cdn\.modrinth\.com\/data\/([^/]+)\//)).find(Boolean);
    if (match) {
      if (!seen.has(match[1])) { projectIds.push(match[1]); seen.add(match[1]); }
    } else if (/\.jar$/i.test(file.path || '')) {
      const name = file.path.split('/').pop().replace(/\.jar$/i, '');
      external.push({ id: `file:${file.path}`, name, summary: '', thumbnailUrl: null, downloadCount: 0, slug: null, websiteUrl: null, external: true });
    }
  }
  if (!projectIds.length && !external.length) return [];

  // 5. Batch fetch en parallèle (lots de 50, toutes les requêtes en même temps)
  const batches = [];
  for (let i = 0; i < projectIds.length; i += 50) batches.push(projectIds.slice(i, i + 50));

  const results = await Promise.allSettled(
    batches.map(batch => client.get('/projects', { params: { ids: JSON.stringify(batch) } }))
  );

  const mods = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      mods.push(...(r.value.data || []).map(p => ({
        id: p.id,
        name: p.title,
        summary: p.description,
        thumbnailUrl: p.icon_url || null,
        downloadCount: p.downloads || 0,
        slug: p.slug,
        websiteUrl: `https://modrinth.com/mod/${p.slug}`,
      })));
    }
  }

  const sorted = [...mods, ...external].sort((a, b) => a.name.localeCompare(b.name));
  modListCache.set(cacheKey, sorted);
  return sorted;
}

function normalizeModpack(hit) {
  return {
    id: hit.project_id,
    source: 'modrinth',
    name: hit.title,
    summary: hit.description,
    description: null,
    thumbnailUrl: hit.icon_url || null,
    screenshots: (hit.gallery || []).map(g => g.url || g),
    downloadCount: hit.downloads || 0,
    categories: hit.categories || [],
    mcVersions: hit.versions || [],
    latestVersion: hit.latest_version || null,
    latestVersionId: hit.latest_version || null,
    hasServerPack: false,
    websiteUrl: `https://modrinth.com/modpack/${hit.slug}`,
    authors: hit.author ? [hit.author] : [],
    slug: hit.slug,
  };
}

function normalizeModpackDetail(project, members) {
  return {
    id: project.id,
    source: 'modrinth',
    name: project.title,
    summary: project.description,
    description: project.body || null,
    thumbnailUrl: project.icon_url || null,
    screenshots: (project.gallery || []).map(g => g.url),
    downloadCount: project.downloads || 0,
    categories: project.categories || [],
    mcVersions: project.game_versions || [],
    latestVersion: null,
    latestVersionId: null,
    hasServerPack: false,
    websiteUrl: `https://modrinth.com/modpack/${project.slug}`,
    authors: members.map(m => m.user?.username || m.username).filter(Boolean),
    slug: project.slug,
    changelog: null,
    sourceLinks: project.source_url ? [project.source_url] : [],
    license: project.license?.id || null,
  };
}

async function testConnection(apiKey) {
  try {
    const client = createClient(apiKey);
    await client.get('/search', { params: { query: 'test', limit: 1, facets: '[["project_type:modpack"]]' } });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { searchModpacks, getModpack, getVersions, getVersion, getModList, testConnection };
