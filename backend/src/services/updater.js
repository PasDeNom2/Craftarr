const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
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

// Dossiers et fichiers "données utilisateur" à préserver lors d'une mise à jour
const USER_WORLD_DIRS = ['world', 'world_nether', 'world_the_end'];
const USER_CONFIG_FILES = ['server.properties', 'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json', 'usercache.json'];
const USER_CONFIG_DIRS = ['config', 'plugins'];

/**
 * Extrait les données utilisateur (monde + configs) d'un backup zip vers serverDir.
 * Écrase les fichiers correspondants issus de l'installation fraîche.
 */
function restoreUserDataFromBackup(backupPath, serverDir) {
  const zip = new AdmZip(backupPath);
  const entries = zip.getEntries();

  for (const entry of entries) {
    const name = entry.entryName;
    // Monde (world/, world_nether/, world_the_end/)
    const isWorld = USER_WORLD_DIRS.some(d => name === d + '/' || name.startsWith(d + '/'));
    // Fichiers config racine (ops.json, server.properties, …)
    const isConfigFile = USER_CONFIG_FILES.includes(name);
    // Répertoires config/ et plugins/
    const isConfigDir = USER_CONFIG_DIRS.some(d => name === d + '/' || name.startsWith(d + '/'));

    if (!isWorld && !isConfigFile && !isConfigDir) continue;
    if (entry.isDirectory) continue;

    const dest = path.join(serverDir, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.getData());
  }
}

async function applyUpdate(server, updateInfo) {
  const db = getDb();
  const DATA_PATH = process.env.DATA_PATH || '/data';
  const serverDir = path.join(DATA_PATH, 'servers', server.id, 'server');

  const histId = uuidv4();
  db.prepare(`
    INSERT INTO update_history (id, server_id, from_version, to_version, status, changelog)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(histId, server.id, server.modpack_version, updateInfo.latestVersion, updateInfo.changelog || null);

  db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('updating', server.id);
  if (io) io.to(`server:${server.id}`).emit('server:update-start', { serverId: server.id, ...updateInfo });

  try {
    // 1. Backup complet pré-update (monde + inventaire + configs)
    const backup = await backupService.createBackup(server, 'pre-update');
    db.prepare('UPDATE update_history SET backup_id = ? WHERE id = ?').run(backup.id, histId);
    console.log(`[Updater] Backup pré-update créé: ${backup.filename}`);

    // 2. Arrêt et suppression du container existant
    if (server.container_id) {
      try { await dockerService.stopContainer(server.container_id, 30); } catch {}
      await dockerService.removeContainer(server.container_id);
      db.prepare('UPDATE servers SET container_id = NULL, container_name = NULL WHERE id = ?').run(server.id);
    }

    // 3. Mise à jour de la version en DB avant l'install fraîche
    db.prepare('UPDATE servers SET modpack_version_id = ?, modpack_version = ? WHERE id = ?')
      .run(updateInfo.latestVersionId, updateInfo.latestVersion, server.id);

    // 4. Installation fraîche (wipe complet du serverDir + téléchargement de la nouvelle version)
    const serverWithNewVersion = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);
    console.log(`[Updater] Installation fraîche de ${updateInfo.latestVersion}…`);
    await installer.freshInstallModpack(serverWithNewVersion, serverDir);

    // 5. Restauration des données utilisateur depuis le backup pré-update
    //    (monde, inventaires joueurs, server.properties, ops, whitelist, configs mods)
    console.log(`[Updater] Restauration des données monde et configs depuis ${backup.filename}…`);
    restoreUserDataFromBackup(backup.path, serverDir);

    // 6. Correction des permissions (Node tourne en root, MC en uid=1000)
    try {
      execSync(`chown -R 1000:1000 ${serverDir}`);
    } catch {
      try { execSync(`chmod -R 755 ${serverDir}`); } catch {}
    }

    // 7. Création du nouveau container avec les env vars de la nouvelle version
    const freshServer = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);
    const { containerId, containerName } = await dockerService.createServerContainer(freshServer);
    db.prepare('UPDATE servers SET container_id = ?, container_name = ?, status = ? WHERE id = ?')
      .run(containerId, containerName, 'starting', freshServer.id);
    await dockerService.startContainer(containerId);

    db.prepare('UPDATE update_history SET status = ? WHERE id = ?').run('success', histId);

    // 8. Nettoyage des anciens backups (garde les 15 derniers)
    await backupService.cleanOldBackups(server.id, 15);

    if (io) io.to(`server:${server.id}`).emit('server:update-done', {
      serverId: server.id,
      version: updateInfo.latestVersion,
      changelog: updateInfo.changelog,
    });

    console.log(`[Updater] Serveur ${server.id} mis à jour vers ${updateInfo.latestVersion}`);
  } catch (err) {
    db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('error', server.id);
    db.prepare('UPDATE update_history SET status = ? WHERE id = ?').run('failed', histId);
    if (io) io.to(`server:${server.id}`).emit('server:update-error', { serverId: server.id, error: err.message });
    console.error(`[Updater] Échec update serveur ${server.id}:`, err.message);
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
