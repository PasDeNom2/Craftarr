// Pré-génération du monde avec Chunky (https://modrinth.com/plugin/chunky).
//
// Une case à cocher suffit côté UI :
//  1. ensureChunky() installe la bonne version de Chunky (loader + version MC du serveur, depuis
//     Modrinth, hash vérifié) dans mods/ ou plugins/, avec ses dépendances obligatoires.
//  2. Une boucle (toutes les 30 s) pilote Chunky par RCON sur les serveurs en marche :
//     démarrage de la tâche, pause dès qu'un joueur se connecte (pas de lag en jeu), reprise quand
//     le serveur est vide, suivi de la progression, détection de la fin.
//  3. pause-when-empty-seconds est désactivé : un serveur 1.21.2+ vide se met en pause et ne
//     générerait plus rien.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getDb } = require('../config/database');
const rcon = require('./rcon');
const { isMcVersion } = require('./mcVersion');

const DATA_PATH = process.env.DATA_PATH || '/data';
const MODRINTH = 'https://api.modrinth.com/v2';
const TICK_MS = 30_000;
const PLUGIN_LOADERS = new Set(['paper', 'purpur', 'spigot', 'bukkit', 'folia']);

// Dimensions pré-générables, dans l'ordre de génération
const WORLDS = ['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end'];

/** Dimensions choisies pour un serveur (ordre de WORLDS, overworld par défaut). */
function worldsOf(server) {
  const wanted = new Set(String(server.pregen_worlds || '').split(',').map(w => w.trim()));
  const list = WORLDS.filter(w => wanted.has(w));
  return list.length ? list : [WORLDS[0]];
}

/** Normalise une liste reçue de l'API (tableau ou chaîne) en valeur de colonne. */
function normalizeWorlds(value) {
  const arr = Array.isArray(value) ? value : String(value || '').split(',');
  return worldsOf({ pregen_worlds: arr.join(',') }).join(',');
}

/** Progression globale : dimensions terminées + avancement de la dimension en cours. */
function overallProgress(server, percent) {
  const n = worldsOf(server).length;
  const idx = Math.min(server.pregen_world_index || 0, n - 1);
  return Math.round(((idx * 100 + percent) / n) * 10) / 10;
}

let io = null;
let timer = null;
const busy = new Set();

function setIo(instance) { io = instance; }
const serverDir = server => path.join(DATA_PATH, 'servers', server.id, 'server');

function emit(server, patch) {
  io?.emit('pregen:update', { serverId: server.id, ...patch });
}

function setState(server, fields) {
  const keys = Object.keys(fields);
  getDb().prepare(`UPDATE servers SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => fields[k]), server.id);
  Object.assign(server, fields);
  emit(server, {
    status: server.pregen_status, progress: server.pregen_progress, eta: server.pregen_eta ?? null, message: server.pregen_message ?? null,
    worldIndex: server.pregen_world_index || 0,
  });
}

/** Version MC effective du serveur (même logique que la création du container). */
function resolveMcVersion(server) {
  try {
    const env = require('./docker')._internals.buildEnvVars(server);
    const v = env.find(e => e.startsWith('VERSION='))?.slice(8);
    if (isMcVersion(v)) return v;
  } catch { /* dossier pas encore prêt */ }
  if (isMcVersion(server.mc_version)) return server.mc_version;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(serverDir(server), '.craftarr-pack.json'), 'utf8'));
    if (isMcVersion(meta.mcVersion)) return meta.mcVersion;
  } catch {}
  return null;
}

/** Où et pour quel loader installer Chunky, ou { error } si ce type de serveur ne le permet pas. */
function targetFor(server) {
  const loader = (server.loader_type || '').toLowerCase();
  if (!loader || loader === 'vanilla') return { error: 'Chunky nécessite un serveur moddé ou Paper (pas un serveur vanilla pur)' };
  if (PLUGIN_LOADERS.has(loader)) return { dir: 'plugins', loaders: [loader, 'paper', 'bukkit', 'spigot'] };
  if (loader === 'quilt') return { dir: 'mods', loaders: ['quilt', 'fabric'] };
  return { dir: 'mods', loaders: [loader] };
}

function chunkyJarIn(dir) {
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).find(f => /^chunky(?!border)[-_.]/i.test(f) && f.endsWith('.jar')) || null;
}

async function findVersion(slug, loaders, mcVersion) {
  const { data } = await axios.get(`${MODRINTH}/project/${slug}/version`, {
    params: { loaders: JSON.stringify(loaders), game_versions: JSON.stringify([mcVersion]) },
    timeout: 15000,
    headers: { 'User-Agent': 'Craftarr (github.com/PasDeNom2/Craftarr)' },
  });
  // Stable d'abord, puis la plus récente
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

/**
 * Installe Chunky s'il n'est pas déjà présent. Renvoie { installed, file } ou lève une erreur
 * lisible (pas de version compatible, serveur vanilla…).
 */
async function ensureChunky(server) {
  const target = targetFor(server);
  if (target.error) throw new Error(target.error);
  const dir = path.join(serverDir(server), target.dir);
  const existing = chunkyJarIn(dir);
  if (existing) return { installed: false, file: existing };

  const mc = resolveMcVersion(server);
  if (!mc) throw new Error('Version de Minecraft inconnue : impossible de choisir la bonne version de Chunky');
  const version = await findVersion('chunky', target.loaders, mc);
  if (!version) throw new Error(`Aucune version de Chunky pour ${server.loader_type} ${mc}`);

  const file = await installVersion(version, dir);
  // Dépendances obligatoires (ex. Fabric API) si le pack ne les fournit pas déjà
  for (const dep of version.dependencies || []) {
    if (dep.dependency_type !== 'required' || !dep.project_id) continue;
    try {
      const { data: project } = await axios.get(`${MODRINTH}/project/${dep.project_id}`, { timeout: 15000 });
      const already = fs.readdirSync(dir).some(f => f.toLowerCase().includes(project.slug.toLowerCase()));
      if (already) continue;
      const depVersion = await findVersion(project.slug, target.loaders, mc);
      if (depVersion) await installVersion(depVersion, dir);
    } catch (err) {
      console.warn(`[Pregen] Dépendance ${dep.project_id} non installée : ${err.message}`);
    }
  }
  disablePauseWhenEmpty(server);
  console.log(`[Pregen] Chunky ${version.version_number} installé pour ${server.id.slice(0, 8)} (${server.loader_type} ${mc})`);
  return { installed: true, file };
}

/** pause-when-empty-seconds=0 dans server.properties (sinon le serveur vide se fige). */
function disablePauseWhenEmpty(server) {
  const file = path.join(serverDir(server), 'server.properties');
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  if (/^pause-when-empty-seconds=0\s*$/m.test(content)) return;
  const next = /^pause-when-empty-seconds=.*$/m.test(content)
    ? content.replace(/^pause-when-empty-seconds=.*$/m, 'pause-when-empty-seconds=0')
    : content.replace(/\n?$/, '\npause-when-empty-seconds=0\n');
  fs.writeFileSync(file, next);
}

// ─── Réponses de Chunky ──────────────────────────────────────
const strip = s => String(s || '').replace(/§[0-9a-fk-or]/gi, '').replace(/&[0-9a-fk-or]/gi, '');
const RE_UNKNOWN = /unknown (or incomplete )?command|unknown command|incorrect argument/i;

function parseProgress(text) {
  const m = strip(text).match(/Processed:\s*([\d,.]+)\s*chunks\s*\(([\d.,]+)%\)(?:,\s*ETA:\s*([\d:]+))?/i);
  if (!m) return null;
  return { percent: parseFloat(m[2].replace(',', '.')), eta: m[3] || null };
}

async function send(server, cmd) {
  return strip(await rcon.sendCommand(server, cmd));
}

/**
 * Démarre la tâche de la dimension en cours (pregen_world_index), rayon choisi.
 * Overworld : centrée sur le spawn ; Nether / End : centrées en 0,0 (portails, île principale).
 */
async function startTask(server) {
  const radius = Math.max(100, Math.min(50_000, server.pregen_radius || 3000));
  const world = worldsOf(server)[server.pregen_world_index || 0] || WORLDS[0];
  // Une ligne de progression par minute dans la console au lieu d'une par seconde
  await send(server, 'chunky quiet 60');
  await send(server, `chunky world ${world}`).catch(() => {});
  await send(server, world === 'minecraft:overworld' ? 'chunky spawn' : 'chunky center 0 0');
  await send(server, `chunky radius ${radius}`);
  let resp = await send(server, 'chunky start');
  // Une ancienne tâche existe : on la relance proprement
  if (/already started|To start a new task/i.test(resp)) resp = await send(server, 'chunky confirm');
  return resp;
}

async function tickServer(server) {
  const status = server.pregen_status;
  if (status === 'done' || status === 'unsupported') return;

  // Mod absent (nouvelle installation, mise à jour du pack qui a remplacé mods/…) → réinstaller
  const target = targetFor(server);
  if (target.error) { setState(server, { pregen_status: 'unsupported', pregen_message: target.error }); return; }
  if (!chunkyJarIn(path.join(serverDir(server), target.dir))) {
    try {
      await ensureChunky(server);
      setState(server, { pregen_status: 'needs_restart', pregen_message: null });
    } catch (err) {
      setState(server, { pregen_status: 'error', pregen_message: err.message });
    }
    return;
  }

  let players = 0;
  try { players = (await rcon.getPlayerList(server)).names.length; } catch { return; } // RCON pas prêt

  const probe = await send(server, 'chunky progress');
  if (RE_UNKNOWN.test(probe)) {
    // Jar présent mais pas chargé : le serveur a démarré avant l'installation
    if (status !== 'needs_restart') setState(server, { pregen_status: 'needs_restart', pregen_message: null });
    return;
  }
  const prog = parseProgress(probe);
  const shouldPause = server.pregen_pause_players !== 0 && players > 0;

  if (prog) {
    // Tâche en cours
    const overall = overallProgress(server, prog.percent);
    if (shouldPause) {
      await send(server, 'chunky pause');
      setState(server, { pregen_status: 'paused', pregen_progress: overall, pregen_eta: null, pregen_message: 'players' });
    } else {
      setState(server, { pregen_status: 'running', pregen_progress: overall, pregen_eta: prog.eta, pregen_message: null });
    }
    return;
  }

  // Aucune tâche active
  if (shouldPause) {
    if (status === 'running') setState(server, { pregen_status: 'paused', pregen_eta: null, pregen_message: 'players' });
    return;
  }
  if (!status || status === 'pending' || status === 'needs_restart' || status === 'error') {
    if (status && status !== 'pending' && server.pregen_progress > 0) {
      // Reprise après redémarrage
      const resp = await send(server, 'chunky continue');
      if (!/no tasks/i.test(resp)) { setState(server, { pregen_status: 'running', pregen_message: null }); return; }
    }
    await startCurrentWorld(server);
    return;
  }
  // running/paused sans tâche active : soit terminée, soit interrompue par un redémarrage
  const resp = await send(server, 'chunky continue');
  if (/no tasks/i.test(resp)) {
    // Dimension terminée : passer à la suivante s'il en reste
    const next = (server.pregen_world_index || 0) + 1;
    if (next < worldsOf(server).length) {
      setState(server, { pregen_world_index: next, pregen_progress: overallProgress({ ...server, pregen_world_index: next }, 0), pregen_eta: null });
      await startCurrentWorld(server);
      return;
    }
    setState(server, { pregen_status: 'done', pregen_progress: 100, pregen_eta: null, pregen_message: null });
    console.log(`[Pregen] Pré-génération terminée pour ${server.id.slice(0, 8)}`);
    io?.emit('log', { serverId: server.id, line: '[Craftarr] ✓ Pré-génération du monde terminée', timestamp: Date.now() });
  } else {
    setState(server, { pregen_status: 'running', pregen_message: null });
  }
}

async function startCurrentWorld(server) {
  const resp = await startTask(server);
  const world = worldsOf(server)[server.pregen_world_index || 0];
  if (/Task started|continuing/i.test(resp)) {
    setState(server, { pregen_status: 'running', pregen_progress: server.pregen_progress || 0, pregen_message: null });
    console.log(`[Pregen] Tâche démarrée pour ${server.id.slice(0, 8)} : ${world} (rayon ${server.pregen_radius})`);
  } else {
    setState(server, { pregen_status: 'error', pregen_message: resp.slice(0, 300) || 'Réponse inattendue de Chunky' });
  }
}

async function tick() {
  const servers = getDb().prepare(
    "SELECT * FROM servers WHERE pregen_enabled = 1 AND status = 'running' AND container_id IS NOT NULL",
  ).all();
  for (const server of servers) {
    if (busy.has(server.id)) continue;
    busy.add(server.id);
    try { await tickServer(server); }
    catch (err) { console.warn(`[Pregen] ${server.id.slice(0, 8)} : ${err.message}`); }
    finally { busy.delete(server.id); }
  }
}

function start() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  setTimeout(tick, 10_000);
}
function stop() { clearInterval(timer); timer = null; }

/** Chunky existe-t-il pour ce loader et cette version de Minecraft ? */
async function isAvailable(loader, mcVersion) {
  const target = targetFor({ loader_type: loader });
  if (target.error || !isMcVersion(mcVersion)) return false;
  try { return !!(await findVersion('chunky', target.loaders, mcVersion)); } catch { return false; }
}

/** Arrête la tâche Chunky en cours (désactivation ou changement de rayon). */
async function cancelTask(server) {
  if (server.status !== 'running') return;
  try {
    await send(server, 'chunky cancel');
    await send(server, 'chunky confirm');
  } catch { /* Chunky absent ou RCON indisponible */ }
}

module.exports = {
  setIo, start, stop, ensureChunky, cancelTask, tick, isAvailable, WORLDS, worldsOf, normalizeWorlds,
  _internals: { parseProgress, targetFor, chunkyJarIn, disablePauseWhenEmpty, tickServer, strip },
};
