const axios = require('axios');

const BASE_URL = 'https://api.modrinth.com/v2';

function createClient(apiKey) {
  const headers = { 'Accept': 'application/json' };
  if (apiKey) headers['Authorization'] = apiKey;
  return axios.create({ baseURL: BASE_URL, headers, timeout: 15000 });
}

async function searchModpacks(apiKey, { query = '', mcVersion, limit = 20, offset = 0, sortBy = 'downloads' } = {}) {
  const client = createClient(apiKey);
  const facets = [['project_type:modpack']];
  if (mcVersion) facets.push([`versions:${mcVersion}`]);

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

async function getVersions(apiKey, projectId) {
  const client = createClient(apiKey);
  const res = await client.get(`/project/${projectId}/version`);
  return res.data.map(v => ({
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
  }));
}

// Conservé pour compatibilité — la logique serveur est gérée dans installMrpack (installer.js)
async function getServerPackUrl(apiKey, projectId) {
  const versions = await getVersions(apiKey, projectId);
  const latest = versions[0];
  if (!latest) return null;
  const primary = latest.files.find(f => f.primary) || latest.files[0];
  return primary ? { url: primary.url, version: latest } : null;
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

module.exports = { searchModpacks, getModpack, getVersions, getServerPackUrl, testConnection };
