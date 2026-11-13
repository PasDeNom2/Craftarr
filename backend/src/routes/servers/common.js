// @ts-check
// Helpers partagés par les routes /api/servers.
const fs = require('fs');
const path = require('path');

/** @typedef {import('../../types').ServerRow} ServerRow */

/**
 * @typedef {Omit<ServerRow, 'whitelist_enabled' | 'online_mode' | 'auto_update' | 'needs_recreate' | 'pregen_enabled' | 'pregen_pause_players' | 'pregen_worlds'> & {
 *   whitelist_enabled: boolean,
 *   online_mode: boolean,
 *   auto_update: boolean,
 *   needs_recreate: boolean,
 *   pregen_enabled: boolean,
 *   pregen_pause_players: boolean,
 *   pregen_worlds: string[],
 * }} FormattedServer
 */

/** @type {string} */
const DATA_PATH = process.env.DATA_PATH || '/data';

// Multer pour l'upload de fichiers (world zip)
let multer;
try { multer = require('multer'); } catch { multer = null; }

/**
 * Crée une instance multer pour l'import de monde, ou null si multer est indisponible.
 * @returns {any}
 */
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

/**
 * Formate une ligne SQLite `servers` pour l'API (booléens et dimensions).
 * @param {ServerRow} row
 * @returns {FormattedServer}
 */
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
    ...require('../../services/extensions').decorate(row),
  };
}

/**
 * Retourne le premier port TCP disponible à partir de 25565.
 * @param {any} db
 * @returns {number}
 */
function findFreePort(db) {
  const rows = db.prepare('SELECT port FROM servers').all();
  const usedPorts = new Set(rows.map(r => r.port));
  let port = 25565;
  while (usedPorts.has(port)) port++;
  return port;
}

/**
 * Serveur (autre que excludeId) qui utilise déjà ce port hôte, ou null.
 * @param {any} db
 * @param {number} port
 * @param {string | null} [excludeId=null]
 * @returns {{ id: string, name: string } | null}
 */
function portOwner(db, port, excludeId = null) {
  return db.prepare('SELECT id, name FROM servers WHERE port = ? AND id != ?')
    .get(port, excludeId || '') || null;
}

/**
 * Traduit l'état du container Docker en statut Craftarr.
 * @param {string} dockerStatus
 * @param {string} currentStatus
 * @returns {string}
 */
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
