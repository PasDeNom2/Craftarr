// Helpers partagés par les routes /api/servers.
const fs = require('fs');
const path = require('path');

const DATA_PATH = process.env.DATA_PATH || '/data';

// Multer pour l'upload de fichiers (world zip)
let multer;
try { multer = require('multer'); } catch { multer = null; }

function getUpload() {
  if (!multer) return null;
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(DATA_PATH, 'servers', req.params.id, 'uploads');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, 'world-import.zip'),
  });
  return multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } }); // 2 Go max
}

function formatServer(row) {
  return {
    ...row,
    whitelist_enabled: !!row.whitelist_enabled,
    online_mode: row.online_mode !== 0,
    auto_update: !!row.auto_update,
    needs_recreate: !!row.needs_recreate,
    pregen_enabled: !!row.pregen_enabled,
    pregen_pause_players: row.pregen_pause_players !== 0,
    pregen_worlds: require('../../services/pregen').worldsOf(row),
  };
}

function findFreePort(db) {
  const rows = db.prepare('SELECT port, rcon_port FROM servers').all();
  const usedPorts = new Set(rows.flatMap(r => [r.port, r.rcon_port]));
  let port = 25565;
  while (usedPorts.has(port) || usedPorts.has(port + 10)) port++;
  return port;
}

/** Serveur (autre que excludeId) qui utilise déjà ce port hôte, ou null. */
function portOwner(db, port, excludeId = null) {
  return db.prepare('SELECT id, name FROM servers WHERE (port = ? OR rcon_port = ?) AND id != ?')
    .get(port, port, excludeId || '') || null;
}

function mapDockerStatus(dockerStatus, currentStatus) {
  if (['installing', 'updating', 'starting'].includes(currentStatus)) return currentStatus;
  switch (dockerStatus) {
    case 'running': return 'running';
    case 'exited':
    case 'stopped': return 'stopped';
    case 'removed': return 'stopped';
    default: return currentStatus;
  }
}

module.exports = { DATA_PATH, getUpload, formatServer, findFreePort, mapDockerStatus, portOwner };
