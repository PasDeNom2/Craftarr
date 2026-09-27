const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../config/database');
const backupService = require('./backup');
const dockerService = require('./docker');
const installer = require('./installer');
const { getSourceApiKey } = require('./sourceAggregator');
const curseforge = require('./curseforge');
const modrinth = require('./modrinth');

const { execSync } = require('child_process');

let io;
function setIo(ioInstance) { io = ioInstance; }

const DATA_PATH = process.env.DATA_PATH || '/data';
const schedules = new Map();

async function checkServerUpdate(server) {
  const db = getDb();
  const sourceRow = db.prepare('SELECT * FROM api_sources WHERE id = ?').get(server.modpack_source);
  if (!sourceRow) return null;

  const apiKey = getSourceApiKey(sourceRow);
  let latestVersionId = null;
  let latestVersion = null;
  let downloadUrl = null;
  let changelog = null;

  try {
    if (server.modpack_source === 'curseforge') {
      if (!apiKey) return null;
      const files = await curseforge.getModpackFiles(apiKey, server.modpack_id);
      const latest = files[0];
      if (!latest) return null;
      latestVersionId = String(latest.id);
      latestVersion = latest.displayName || latest.fileName;
      downloadUrl = latest.downloadUrl;
    } else if (server.modpack_source === 'modrinth') {
      const versions = await modrinth.getVersions(apiKey, server.modpack_id);
      const latest = versions[0];
      if (!latest) return null;
      latestVersionId = latest.id;
      latestVersion = latest.versionNumber;
      changelog = latest.changelog;
      downloadUrl = latest.files.find(f => f.primary)?.url || latest.files[0]?.url;
    } else {
      return null;
    }
  } catch (err) {
    console.error(`[Updater] Erreur check update ${server.id}:`, err.message);
    return null;
  }

  if (!latestVersionId) return null;
  const isNew = latestVersionId !== server.modpack_version_id;
  return isNew ? { latestVersionId, latestVersion, downloadUrl, changelog } : null;
}

// Fichiers "données utilisateur" à préserver lors d'une mise à jour (les mondes : backupService.getWorldDirs)
const USER_CONFIG_FILES = ['server.properties', 'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json', 'usercache.json'];
const USER_CONFIG_DIRS = ['config', 'plugins'];

/**
 * Copie les données utilisateur (monde + configs) de l'ancienne installation vers la nouvelle.
 * Le serveur est arrêté à ce moment-là : la copie est plus fraîche que le backup pré-update
 * (aucune perte de la progression faite pendant l'installation).
 */
function copyUserData(oldDir, newDir) {
  for (const name of [...backupService.getWorldDirs(oldDir), ...USER_CONFIG_FILES, ...USER_CONFIG_DIRS]) {
    const src = path.join(oldDir, name);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(newDir, name), { recursive: true, force: true });
  }
}

function fixOwnership(dir) {
  // Node tourne en root, MC en uid=1000
  try {
    execSync(`chown -R 1000:1000 "${dir}"`);
  } catch {
    try { execSync(`chmod -R 755 "${dir}"`); } catch {}
  }
}

async function recreateAndStart(serverId) {
  const db = getDb();
  const fresh = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  const { containerId, containerName } = await dockerService.createServerContainer(fresh);
  db.prepare('UPDATE servers SET container_id = ?, container_name = ?, status = ? WHERE id = ?')
    .run(containerId, containerName, 'starting', serverId);
  await dockerService.startContainer(containerId, fresh);
}

/**
 * Mise à jour d'un modpack sans risque de perdre le serveur :
 *   1. backup pré-update,
 *   2. arrêt du serveur,
 *   3. installation de la nouvelle version dans server.staging/ (l'ancienne reste intacte),
 *   4. bascule : server/ → server.old/, server.staging/ → server/, copie monde + configs,
 *   5. redémarrage ; server.old/ n'est supprimé qu'une fois le nouveau container démarré.
 * En cas d'échec, l'ancienne installation est remise en place et redémarrée.
 */
async function applyUpdate(server, updateInfo) {
  const db = getDb();
  const baseDir = path.join(DATA_PATH, 'servers', server.id);
  const serverDir = path.join(baseDir, 'server');
  const stagingDir = path.join(baseDir, 'server.staging');
  const oldDir = path.join(baseDir, 'server.old');
  // L'installation réécrit aussi mc_version / loader_type : tout restaurer en cas de rollback
  const previous = {
    modpack_version_id: server.modpack_version_id,
    modpack_version: server.modpack_version,
    mc_version: server.mc_version,
    loader_type: server.loader_type,
  };
  let swapped = false;

  const histId = uuidv4();
  db.prepare(`
    INSERT INTO update_history (id, server_id, from_version, to_version, status, changelog)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(histId, server.id, server.modpack_version, updateInfo.latestVersion, updateInfo.changelog || null);

  db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('updating', server.id);
  if (io) io.to(`server:${server.id}`).emit('server:update-start', { serverId: server.id, ...updateInfo });

  try {
    // 1. Backup complet pré-update (monde + inventaire + configs) — filet de sécurité
    const backup = await backupService.createBackup(server, 'pre-update');
    db.prepare('UPDATE update_history SET backup_id = ? WHERE id = ?').run(backup.id, histId);
    console.log(`[Updater] Backup pré-update créé: ${backup.filename}`);

    // 2. Arrêt et suppression du container existant (le monde est sauvegardé à l'arrêt)
    if (server.container_id) {
      try { await dockerService.stopContainer(server.container_id); } catch {}
      await dockerService.removeContainer(server.container_id);
      db.prepare('UPDATE servers SET container_id = NULL, container_name = NULL WHERE id = ?').run(server.id);
    }

    // 3. Installation fraîche dans le dossier de staging — server/ n'est pas touché
    db.prepare('UPDATE servers SET modpack_version_id = ?, modpack_version = ? WHERE id = ?')
      .run(updateInfo.latestVersionId, updateInfo.latestVersion, server.id);
    const serverWithNewVersion = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);
    console.log(`[Updater] Installation fraîche de ${updateInfo.latestVersion} (staging)…`);
    await installer.freshInstallModpack(serverWithNewVersion, stagingDir);

    // 4. Bascule + reprise des données utilisateur depuis l'ancienne installation
    if (fs.existsSync(oldDir)) fs.rmSync(oldDir, { recursive: true, force: true });
    fs.renameSync(serverDir, oldDir);
    fs.renameSync(stagingDir, serverDir);
    swapped = true;
    console.log('[Updater] Reprise du monde et des configs de l\'ancienne installation…');
    copyUserData(oldDir, serverDir);
    fixOwnership(serverDir);

    // 5. Nouveau container avec les env vars de la nouvelle version
    await recreateAndStart(server.id);
    fs.rmSync(oldDir, { recursive: true, force: true });

    db.prepare('UPDATE update_history SET status = ? WHERE id = ?').run('success', histId);

    // 6. Nettoyage des anciens backups (garde les 15 derniers)
    await backupService.cleanOldBackups(server.id, 15);

    if (io) io.to(`server:${server.id}`).emit('server:update-done', {
      serverId: server.id,
      version: updateInfo.latestVersion,
      changelog: updateInfo.changelog,
    });

    console.log(`[Updater] Serveur ${server.id} mis à jour vers ${updateInfo.latestVersion}`);
  } catch (err) {
    console.error(`[Updater] Échec update serveur ${server.id}:`, err.message);
    db.prepare('UPDATE update_history SET status = ? WHERE id = ?').run('failed', histId);
    if (io) io.to(`server:${server.id}`).emit('server:update-error', { serverId: server.id, error: err.message });

    // Rollback : remettre l'ancienne installation et la redémarrer
    try {
      if (swapped) {
        fs.rmSync(serverDir, { recursive: true, force: true });
        fs.renameSync(oldDir, serverDir);
      }
      fs.rmSync(stagingDir, { recursive: true, force: true });
      db.prepare('UPDATE servers SET modpack_version_id = ?, modpack_version = ?, mc_version = ?, loader_type = ? WHERE id = ?')
        .run(previous.modpack_version_id, previous.modpack_version, previous.mc_version, previous.loader_type, server.id);
      await recreateAndStart(server.id);
      console.log(`[Updater] Rollback effectué — ${server.id} relancé sur ${previous.modpack_version}`);
    } catch (rollbackErr) {
      db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('error', server.id);
      console.error(`[Updater] Rollback impossible pour ${server.id}:`, rollbackErr.message);
    }
  }
}

async function checkAllServers() {
  const db = getDb();
  const servers = db.prepare('SELECT * FROM servers WHERE auto_update = 1').all();
  for (const server of servers) {
    const update = await checkServerUpdate(server);
    if (update) {
      console.log(`[Updater] Nouvelle version disponible pour ${server.name}: ${update.latestVersion}`);
      if (io) io.emit('server:update-available', { serverId: server.id, serverName: server.name, ...update });
      await applyUpdate(server, update);
    }
  }
}

function scheduleUpdater() {
  const hours = parseInt(process.env.UPDATE_CHECK_INTERVAL_HOURS || '6', 10);
  const cronExpr = `0 */${hours} * * *`;
  const job = cron.schedule(cronExpr, checkAllServers, { scheduled: true });
  schedules.set('global', job);
  console.log(`[Updater] Planifié toutes les ${hours}h (cron: ${cronExpr})`);
}

/**
 * Résout l'URL de téléchargement CurseForge pour une mise à jour.
 * Gère le cas downloadUrl=null via le CDN forgecdn, et préfère le server pack si disponible.
 */
async function resolveCurseForgeDownloadUrl(server, targetFile, allFiles) {
  const db = getDb();
  const sourceRow = db.prepare('SELECT * FROM api_sources WHERE id = ?').get(server.modpack_source);
  const { getSourceApiKey } = require('./sourceAggregator');
  const apiKey = getSourceApiKey(sourceRow);

  const serverPacks = (allFiles || []).filter(f => f.isServerPack);
  let resolvedFile = targetFile;

  // Chercher un server pack associé à ce fichier client
  if (targetFile.serverPackFileId) {
    let sp = serverPacks.find(f => String(f.id) === String(targetFile.serverPackFileId));
    if (!sp && apiKey) {
      try {
        sp = await curseforge.getFileById(apiKey, server.modpack_id, targetFile.serverPackFileId);
      } catch {}
    }
    if (sp) resolvedFile = sp;
  } else if (serverPacks.length > 0) {
    resolvedFile = serverPacks[0];
  }

  return resolvedFile.downloadUrl || buildCdnUrl(resolvedFile.id, resolvedFile.fileName);
}

function buildCdnUrl(fileId, fileName) {
  const id = parseInt(fileId, 10);
  return `https://mediafilez.forgecdn.net/files/${Math.floor(id / 1000)}/${id % 1000}/${encodeURIComponent(fileName)}`;
}

module.exports = { scheduleUpdater, checkAllServers, checkServerUpdate, applyUpdate, resolveCurseForgeDownloadUrl, setIo };
