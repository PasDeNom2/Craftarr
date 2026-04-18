const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../config/database');

const DATA_PATH = process.env.DATA_PATH || '/data';

const WORLD_DIRS = ['world', 'world_nether', 'world_the_end'];
const CONFIG_FILES = ['ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json', 'server.properties'];
const CONFIG_DIRS = ['plugins', 'config'];

async function createBackup(server, trigger = 'manual') {
  const db = getDb();
  const serverDir = path.join(DATA_PATH, 'servers', server.id, 'server');
  const backupsDir = path.join(DATA_PATH, 'servers', server.id, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `backup-${trigger}-${timestamp}.zip`;
  const backupPath = path.join(backupsDir, filename);

  await createZipBackup(serverDir, backupPath);

  const stats = fs.statSync(backupPath);
  const id = uuidv4();

  db.prepare(`
    INSERT INTO backups (id, server_id, filename, path, size_bytes, trigger, modpack_version_at_backup)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, server.id, filename, backupPath, stats.size, trigger, server.modpack_version || null);

  console.log(`[Backup] ${trigger} backup créé pour serveur ${server.id}: ${filename} (${Math.round(stats.size / 1024 / 1024)}MB)`);

  return db.prepare('SELECT * FROM backups WHERE id = ?').get(id);
}

function createZipBackup(serverDir, outputPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);

    // Mondes
    for (const worldDir of WORLD_DIRS) {
      const dirPath = path.join(serverDir, worldDir);
      if (fs.existsSync(dirPath)) {
        archive.directory(dirPath, worldDir);
      }
    }

    // Fichiers de config
    for (const file of CONFIG_FILES) {
      const filePath = path.join(serverDir, file);
      if (fs.existsSync(filePath)) {
        archive.file(filePath, { name: file });
      }
    }

    // Dossiers config/plugins
    for (const dir of CONFIG_DIRS) {
      const dirPath = path.join(serverDir, dir);
      if (fs.existsSync(dirPath)) {
        archive.directory(dirPath, dir);
      }
    }

    archive.finalize();
  });
}

async function restoreBackup(server, backup) {
  const dockerService = require('./docker');
  const db = getDb();
  const serverDir = path.join(DATA_PATH, 'servers', server.id, 'server');

  // Arrêt du serveur
  if (server.container_id) {
    try { await dockerService.stopContainer(server.container_id, 15); } catch {}
  }

  db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('stopped', server.id);

  // Extraction du backup
  const zip = new AdmZip(backup.path);

  // Suppression des données existantes avant restore
  for (const worldDir of WORLD_DIRS) {
    const dirPath = path.join(serverDir, worldDir);
    if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true });
  }
  for (const configDir of CONFIG_DIRS) {
    const dirPath = path.join(serverDir, configDir);
    if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true });
  }
  for (const file of CONFIG_FILES) {
    const filePath = path.join(serverDir, file);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  zip.extractAllTo(serverDir, true);

  // Redémarrage
  if (server.container_id) {
    await dockerService.startContainer(server.container_id);
    db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('running', server.id);
  }

  console.log(`[Backup] Restore effectué pour serveur ${server.id} depuis ${backup.filename}`);
}

async function cleanOldBackups(serverId, keepCount = 10) {
  const db = getDb();
  const backups = db.prepare(
    'SELECT * FROM backups WHERE server_id = ? ORDER BY created_at DESC'
  ).all(serverId);

  if (backups.length <= keepCount) return;
  const toDelete = backups.slice(keepCount);

  for (const b of toDelete) {
    try { fs.unlinkSync(b.path); } catch {}
    db.prepare('DELETE FROM backups WHERE id = ?').run(b.id);
  }
  console.log(`[Backup] ${toDelete.length} anciens backups supprimés pour ${serverId}`);
}

module.exports = { createBackup, restoreBackup, cleanOldBackups };
