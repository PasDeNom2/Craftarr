const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../config/database');
const backupService = require('./backup');
const dockerService = require('./docker');
const { getSourceApiKey } = require('./sourceAggregator');
const curseforge = require('./curseforge');
const modrinth = require('./modrinth');

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

async function applyUpdate(server, updateInfo) {
  const db = getDb();
  const histId = uuidv4();
  db.prepare(`
    INSERT INTO update_history (id, server_id, from_version, to_version, status, changelog)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(histId, server.id, server.modpack_version, updateInfo.latestVersion, updateInfo.changelog || null);

  db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('updating', server.id);
  if (io) io.to(`server:${server.id}`).emit('server:update-start', { serverId: server.id, ...updateInfo });

  try {
    // 1. Backup automatique pre-update
    const backup = await backupService.createBackup(server, 'pre-update');
    db.prepare('UPDATE update_history SET backup_id = ? WHERE id = ?').run(backup.id, histId);

    // 2. Arrêt du serveur
    if (server.container_id) {
      await dockerService.stopContainer(server.container_id, 30);
    }

    // 3. Téléchargement et remplacement des mods
    if (updateInfo.downloadUrl) {
      const serverDir = path.join(DATA_PATH, 'servers', server.id, 'server');
      const modsDir = path.join(serverDir, 'mods');
      const zipPath = path.join(DATA_PATH, 'servers', server.id, 'update.zip');

      const axios = require('axios');
      const res = await axios.get(updateInfo.downloadUrl, { responseType: 'stream', timeout: 120000 });
      await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(zipPath);
        res.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      // Sauvegarde et remplacement du dossier mods
      const modsBackupDir = path.join(DATA_PATH, 'servers', server.id, 'mods-old');
      if (fs.existsSync(modsDir)) {
        if (fs.existsSync(modsBackupDir)) fs.rmSync(modsBackupDir, { recursive: true });
        fs.renameSync(modsDir, modsBackupDir);
      }
      fs.mkdirSync(modsDir, { recursive: true });

      const AdmZip = require('adm-zip');
      const zip = new AdmZip(zipPath);
      const zipEntries = zip.getEntries();
      for (const entry of zipEntries) {
        if (entry.entryName.startsWith('mods/') || entry.entryName.startsWith('mods\\')) {
          const targetPath = path.join(serverDir, entry.entryName);
          if (entry.isDirectory) {
            fs.mkdirSync(targetPath, { recursive: true });
          } else {
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.writeFileSync(targetPath, entry.getData());
          }
        }
      }
      fs.unlinkSync(zipPath);
    }

    // 4. Mise à jour DB
    db.prepare('UPDATE servers SET modpack_version = ?, modpack_version_id = ?, status = ? WHERE id = ?')
      .run(updateInfo.latestVersion, updateInfo.latestVersionId, 'running', server.id);
    db.prepare('UPDATE update_history SET status = ? WHERE id = ?').run('success', histId);

    // 5. Redémarrage
    if (server.container_id) {
      await dockerService.startContainer(server.container_id);
    }

    // 6. Nettoyage des anciens backups (garde les 5 derniers pre-update)
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

module.exports = { scheduleUpdater, checkAllServers, checkServerUpdate, applyUpdate, setIo };
