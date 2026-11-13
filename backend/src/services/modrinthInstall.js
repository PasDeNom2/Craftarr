/**
 * Installe un projet Modrinth (mod ou plugin) compatible avec un serveur, avec ses dépendances
 * obligatoires. Utilisé par spark, BlueMap, Geyser, Floodgate… (même logique que Chunky).
 *
 *   const { ensureProject } = require('./modrinthInstall');
 *   const r = await ensureProject(server, 'bluemap');   // { installed, file, dir, version }
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const MODRINTH = 'https://api.modrinth.com/v2';
const UA = { 'User-Agent': 'Craftarr (github.com/PasDeNom2/Craftarr)' };
const PLUGIN_LOADERS = new Set(['paper', 'purpur', 'spigot', 'bukkit', 'folia']);
const DATA_PATH = process.env.DATA_PATH || '/data';

const serverDirOf = (server) => path.join(DATA_PATH, 'servers', server.id, 'server');

/** Dossier et loaders Modrinth acceptés pour ce serveur, ou { error }. */
function targetFor(server) {
  const loader = (server.loader_type || '').toLowerCase();
  if (!loader || loader === 'vanilla') return { error: 'Nécessite un serveur moddé (Fabric, Forge, NeoForge, Quilt) ou Paper/Purpur' };
  if (PLUGIN_LOADERS.has(loader)) return { dir: 'plugins', loaders: [loader, 'paper', 'bukkit', 'spigot'] };
  if (loader === 'quilt') return { dir: 'mods', loaders: ['quilt', 'fabric'] };
  return { dir: 'mods', loaders: [loader] };
}

/** Version Minecraft effective du serveur (métadonnées du pack, sinon colonne mc_version). */
function mcVersionOf(server) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(serverDirOf(server), '.craftarr-pack.json'), 'utf8'));
    if (meta?.mcVersion) return meta.mcVersion;
  } catch { /* pas de métadonnées */ }
  return server.mc_version || null;
}

async function findVersion(slug, loaders, mcVersion) {
  const { data } = await axios.get(`${MODRINTH}/project/${slug}/version`, {
    params: { loaders: JSON.stringify(loaders), game_versions: JSON.stringify([mcVersion]) },
    timeout: 15000, headers: UA,
  });
  return data.find(v => v.version_type === 'release') || data[0] || null;
}

async function installVersion(version, destDir) {
  const { _internals: { downloadFile } } = require('./installer');
  const file = version.files.find(f => f.primary) || version.files[0];
  const dest = path.join(destDir, file.filename);
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(destDir, { recursive: true });
    await downloadFile(file.url, dest, null, file.hashes?.sha1 ? { sha1: file.hashes.sha1 } : {});
  }
  return file.filename;
}

/** Fichier .jar déjà présent pour ce projet (nom commençant par le slug), ou null. */
function findInstalled(dir, slug) {
  if (!fs.existsSync(dir)) return null;
  const re = new RegExp(`^${slug.replace(/[^a-z0-9]/gi, '.?')}[-_.+]`, 'i');
  return fs.readdirSync(dir).find(f => re.test(f) && f.endsWith('.jar')) || null;
}

/**
 * Installe le projet `slug` s'il manque. Options : { filePattern: RegExp } pour reconnaître un
 * fichier déjà installé quand son nom ne commence pas par le slug.
 */
async function ensureProject(server, slug, { filePattern } = {}) {
  const target = targetFor(server);
  if (target.error) throw Object.assign(new Error(target.error), { status: 400 });
  const dir = path.join(serverDirOf(server), target.dir);
  const existing = filePattern
    ? (fs.existsSync(dir) ? fs.readdirSync(dir).find(f => filePattern.test(f)) : null)
    : findInstalled(dir, slug);
  if (existing) return { installed: false, file: existing, dir: target.dir };

  const mc = mcVersionOf(server);
  if (!mc) throw Object.assign(new Error('Version de Minecraft inconnue'), { status: 400 });
  const version = await findVersion(slug, target.loaders, mc);
  if (!version) throw Object.assign(new Error(`Aucune version de ${slug} pour ${server.loader_type} ${mc}`), { status: 422 });
  const file = await installVersion(version, dir);
  for (const dep of version.dependencies || []) {
    if (dep.dependency_type !== 'required' || !dep.project_id) continue;
    try {
      const { data: project } = await axios.get(`${MODRINTH}/project/${dep.project_id}`, { timeout: 15000, headers: UA });
      if (findInstalled(dir, project.slug)) continue;
      const depVersion = await findVersion(project.slug, target.loaders, mc);
      if (depVersion) await installVersion(depVersion, dir);
    } catch (err) {
      console.warn(`[modrinthInstall] Dépendance ${dep.project_id} de ${slug} non installée : ${err.message}`);
    }
  }
  console.log(`[modrinthInstall] ${slug} ${version.version_number} installé pour ${server.id.slice(0, 8)}`);
  return { installed: true, file, dir: target.dir, version: version.version_number };
}

/** Supprime le .jar du projet s'il est présent. Renvoie le nom supprimé ou null. */
function removeProject(server, slug, { filePattern } = {}) {
  const target = targetFor(server);
  if (target.error) return null;
  const dir = path.join(serverDirOf(server), target.dir);
  const f = filePattern ? (fs.existsSync(dir) ? fs.readdirSync(dir).find(n => filePattern.test(n)) : null) : findInstalled(dir, slug);
  if (f) fs.rmSync(path.join(dir, f), { force: true });
  return f || null;
}

module.exports = { ensureProject, removeProject, targetFor, mcVersionOf, findInstalled, serverDirOf, PLUGIN_LOADERS };
