const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../config/database');

const DATA_PATH = process.env.DATA_PATH || '/data';
// Hors du dossier du serveur : supprimer/réinstaller un serveur ne doit jamais emporter ses backups
const BACKUPS_ROOT = path.join(DATA_PATH, 'backups');

const CONFIG_FILES = ['ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json', 'server.properties', 'usercache.json'];
const CONFIG_DIRS = ['plugins', 'config'];

function backupsDirFor(serverId) {
  return path.join(BACKUPS_ROOT, serverId);
}

/** Nom du monde principal (level-name de server.properties), "world" par défaut. */
function readLevelName(serverDir) {
  try {
    const props = fs.readFileSync(path.join(serverDir, 'server.properties'), 'utf8');
    const m = props.match(/^level-name\s*=\s*(.+?)\s*$/m);
    // level-name peut contenir un chemin : on n'accepte qu'un nom de dossier simple
    if (m && /^[\w .-]+$/.test(m[1]) && !m[1].includes('..')) return m[1];
  } catch {}
  return 'world';
}

/** Dossiers de monde du serveur : level-name + ses dimensions séparées (Bukkit/Paper). */
function getWorldDirs(serverDir) {
  const level = readLevelName(serverDir);
  return [level, `${level}_nether`, `${level}_the_end`];
}

/** Éléments (dossiers/fichiers) contenus dans un backup. */
function backupItems(serverDir) {
  return [...getWorldDirs(serverDir), ...CONFIG_FILES, ...CONFIG_DIRS];
}

async function createBackup(server, trigger = 'manual') {
  const db = getDb();
  const serverDir = path.join(DATA_PATH, 'servers', server.id, 'server');
  const backupsDir = backupsDirFor(server.id);
  fs.mkdirSync(backupsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `backup-${trigger}-${timestamp}.zip`;
  const backupPath = path.join(backupsDir, filename);

  // Si le serveur tourne, forcer une sauvegarde complète avant de zipper
  const isRunning = server.status === 'running' && server.container_id;
  if (isRunning) {
    const rcon = require('./rcon');
    try {
      await rcon.sendCommand(server, 'save-all flush');
      // Laisser 2s pour que Minecraft finisse d'écrire les fichiers
      await new Promise(r => setTimeout(r, 2000));
      await rcon.sendCommand(server, 'save-off');
    } catch {
      // RCON indisponible (serveur en démarrage) — on continue quand même
    }
  }

  try {
    await createZipBackup(serverDir, backupPath);
  } catch (err) {
    try { fs.unlinkSync(backupPath); } catch {}
    throw err;
  } finally {
    if (isRunning) {
      const rcon = require('./rcon');
      try { await rcon.sendCommand(server, 'save-on'); } catch {}
    }
  }

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
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);

    for (const item of backupItems(serverDir)) {
      const itemPath = path.join(serverDir, item);
      if (!fs.existsSync(itemPath)) continue;
      if (fs.statSync(itemPath).isDirectory()) archive.directory(itemPath, item);
      else archive.file(itemPath, { name: item });
    }

    archive.finalize();
  });
}

/**
 * Remplace des éléments de serverDir par ceux extraits dans stagingDir, élément par élément.
 * Seuls les éléments présents dans stagingDir sont touchés.
 */
function swapInFromStaging(stagingDir, serverDir, items) {
  for (const item of items) {
    const src = path.join(stagingDir, item);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(serverDir, item);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(src, dest);
  }
}

/**
 * Restaure un backup sans risque : l'archive est vérifiée et extraite à part AVANT de toucher
 * au monde actuel. Si le zip est corrompu, le serveur reste tel quel.
 */
async function restoreBackup(server, backup) {
  const dockerService = require('./docker');
  const db = getDb();
  const serverDir = path.join(DATA_PATH, 'servers', server.id, 'server');
  const stagingDir = path.join(DATA_PATH, 'servers', server.id, '.restore-staging');

  // 1. Vérification de l'archive (serveur toujours en marche)
  if (!fs.existsSync(backup.path)) throw Object.assign(new Error('Fichier de backup introuvable sur le disque'), { status: 404 });
  let zip;
  try {
    zip = new AdmZip(backup.path);
    if (!zip.getEntries().length) throw new Error('archive vide');
  } catch (err) {
    throw Object.assign(new Error(`Backup illisible ou corrompu (${err.message}) — rien n'a été modifié`), { status: 400 });
  }

  // 2. Extraction à part
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  try {
    zip.extractAllTo(stagingDir, true);
  } catch (err) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw new Error(`Extraction du backup impossible (${err.message}) — rien n'a été modifié`);
  }

  // 3. Arrêt propre, puis bascule
  if (server.container_id) {
    try { await dockerService.stopContainer(server.container_id); } catch {}
  }
  db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('stopped', server.id);

  try {
    // Le monde restauré remplace entièrement l'actuel (y compris ses dimensions absentes du backup)
    const restoredWorlds = getWorldDirs(serverDir).filter(d => fs.existsSync(path.join(stagingDir, d)));
    if (restoredWorlds.length) {
      for (const d of getWorldDirs(serverDir)) fs.rmSync(path.join(serverDir, d), { recursive: true, force: true });
    }
    // Uniquement les éléments qu'un backup Craftarr peut contenir (jamais mods/, libraries/…)
    swapInFromStaging(stagingDir, serverDir, backupItems(serverDir));
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  // 4. Redémarrage
  if (server.container_id) {
    await dockerService.startContainer(server.container_id, server);
    db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('starting', server.id);
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

/**
 * Migration : les backups étaient rangés dans servers/<id>/backups/ et partaient avec le serveur
 * à sa suppression. On les déplace dans backups/<id>/ et on met à jour les chemins en base.
 */
function migrateBackupLocation() {
  const db = getDb();
  const rows = db.prepare('SELECT id, server_id, filename, path FROM backups').all();
  let moved = 0;
  for (const b of rows) {
    const target = path.join(backupsDirFor(b.server_id), b.filename);
    if (b.path === target || !fs.existsSync(b.path)) continue;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(b.path, target);
      db.prepare('UPDATE backups SET path = ? WHERE id = ?').run(target, b.id);
      moved++;
    } catch (err) {
      console.warn(`[Backup] Migration impossible pour ${b.filename} : ${err.message}`);
    }
  }
  if (moved) console.log(`[Backup] ${moved} backup(s) déplacé(s) vers ${BACKUPS_ROOT}`);
}

module.exports = {
  createBackup, restoreBackup, cleanOldBackups, migrateBackupLocation,
  backupsDirFor, getWorldDirs, readLevelName, swapInFromStaging,
};
