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

// Télécharge uniquement modrinth.index.json depuis un fichier mrpack (zip)
// en utilisant des Range requests HTTP — évite de télécharger tout le fichier
async function extractMrpackIndex(axios, url, totalSize) {
  try {
    const zlib = require('zlib');

    // Fallback : si taille inconnue ou serveur ne supporte pas Range, télécharge tout
    // D'abord HEAD pour vérifier Accept-Ranges
    const head = await axios.head(url, { timeout: 10000 }).catch(() => null);
    const supportsRange = head?.headers?.['accept-ranges'] === 'bytes';
    const fileSize = totalSize || parseInt(head?.headers?.['content-length'] || '0', 10);

    if (!supportsRange || !fileSize) {
      // Fallback : téléchargement complet
      const AdmZip = require('adm-zip');
      const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
      const zip = new AdmZip(Buffer.from(res.data));
      const entry = zip.getEntry('modrinth.index.json');
      return entry ? JSON.parse(entry.getData().toString('utf8')) : null;
    }

    // Étape 1 : lire l'EOCD (End of Central Directory) = derniers 22 octets min
    const eocdSize = Math.min(65557, fileSize); // max possible avec commentaire ZIP
    const eocdRes = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: { Range: `bytes=${fileSize - eocdSize}-${fileSize - 1}` },
    });
    const eocdBuf = Buffer.from(eocdRes.data);

    // Cherche la signature EOCD (0x06054b50) en partant de la fin
    let eocdOffset = -1;
    for (let i = eocdBuf.length - 22; i >= 0; i--) {
      if (eocdBuf.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
    }
    if (eocdOffset < 0) throw new Error('EOCD non trouvé');

    const cdOffset = eocdBuf.readUInt32LE(eocdOffset + 16);
    const cdSize   = eocdBuf.readUInt32LE(eocdOffset + 12);

    // Étape 2 : lire le Central Directory
    const cdRes = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: { Range: `bytes=${cdOffset}-${cdOffset + cdSize - 1}` },
    });
    const cdBuf = Buffer.from(cdRes.data);

    // Étape 3 : parser le Central Directory pour trouver modrinth.index.json
    let pos = 0;
    let localHeaderOffset = -1;
    let compressedSize = 0;
    let compressionMethod = 0;

    while (pos < cdBuf.length - 4) {
      if (cdBuf.readUInt32LE(pos) !== 0x02014b50) break;
      const method     = cdBuf.readUInt16LE(pos + 10);
      const cSize      = cdBuf.readUInt32LE(pos + 20);
      const fnLen      = cdBuf.readUInt16LE(pos + 28);
      const extraLen   = cdBuf.readUInt16LE(pos + 30);
      const commentLen = cdBuf.readUInt16LE(pos + 32);
      const lhOffset   = cdBuf.readUInt32LE(pos + 42);
      const filename   = cdBuf.slice(pos + 46, pos + 46 + fnLen).toString('utf8');

      if (filename === 'modrinth.index.json') {
        localHeaderOffset = lhOffset;
        compressedSize = cSize;
        compressionMethod = method;
      }
      pos += 46 + fnLen + extraLen + commentLen;
    }

    if (localHeaderOffset < 0) return null;

    // Étape 4 : lire le Local File Header pour obtenir l'offset réel des données
    const lhRes = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: { Range: `bytes=${localHeaderOffset}-${localHeaderOffset + 29}` },
    });
    const lhBuf = Buffer.from(lhRes.data);
    const lhFnLen    = lhBuf.readUInt16LE(26);
    const lhExtraLen = lhBuf.readUInt16LE(28);
    const dataOffset = localHeaderOffset + 30 + lhFnLen + lhExtraLen;

    // Étape 5 : lire uniquement les données compressées de modrinth.index.json
    const dataRes = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: { Range: `bytes=${dataOffset}-${dataOffset + compressedSize - 1}` },
    });
    const compressedData = Buffer.from(dataRes.data);

    const jsonBuf = compressionMethod === 8
      ? zlib.inflateRawSync(compressedData)
      : compressedData;

    return JSON.parse(jsonBuf.toString('utf8'));
  } catch (err) {
    // Fallback total si quelque chose échoue
    try {
      const AdmZip = require('adm-zip');
      const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
      const zip = new AdmZip(Buffer.from(res.data));
      const entry = zip.getEntry('modrinth.index.json');
      return entry ? JSON.parse(entry.getData().toString('utf8')) : null;
    } catch (_) { return null; }
  }
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
  const index = await extractMrpackIndex(axios, mrpackUrl, mrpackSize);
  if (!index) return [];

  // 4. Extrait les project IDs depuis les URLs cdn.modrinth.com
  const projectIds = [];
  const seen = new Set();
  for (const file of (index.files || [])) {
    for (const url of (file.downloads || [])) {
      const match = url.match(/cdn\.modrinth\.com\/data\/([^/]+)\//);
      if (match && !seen.has(match[1])) {
        projectIds.push(match[1]);
        seen.add(match[1]);
        break;
      }
    }
  }
  if (!projectIds.length) return [];

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

  const sorted = mods.sort((a, b) => a.name.localeCompare(b.name));
  modListCache.set(cacheKey, sorted);
  return sorted;
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

module.exports = { searchModpacks, getModpack, getVersions, getModList, getServerPackUrl, testConnection };
