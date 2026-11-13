// Routes de gestion de la carte web BlueMap (/api/servers/:id/bluemap*).
const express = require('express');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../../config/database');
const authMiddleware = require('../../middleware/auth');
const modrinthInstall = require('../../services/modrinthInstall');
const serverLock = require('../../services/serverLock');
const { formatServer } = require('../servers/common');

const router = express.Router();

const PLUGIN_LOADERS = modrinthInstall.PLUGIN_LOADERS || new Set(['paper', 'purpur', 'spigot', 'bukkit', 'folia']);
const serverDirOf = (server) => (
  typeof modrinthInstall.serverDirOf === 'function'
    ? modrinthInstall.serverDirOf(server)
    : path.join(process.env.DATA_PATH || '/data', 'servers', server.id, 'server')
);

/** Dossier de configuration BlueMap selon le loader du serveur. */
function configDirFor(server) {
  const loader = (server.loader_type || '').toLowerCase();
  const dir = serverDirOf(server);
  if (PLUGIN_LOADERS.has(loader)) {
    return path.join(dir, 'plugins', 'BlueMap');
  }
  return path.join(dir, 'config', 'bluemap');
}

/** Vérifie si un .jar BlueMap est présent dans le dossier mods/ ou plugins/ du serveur. */
function isBluemapInstalled(server) {
  const loader = (server.loader_type || '').toLowerCase();
  if (!loader || loader === 'vanilla') return false;
  const dir = path.join(serverDirOf(server), PLUGIN_LOADERS.has(loader) ? 'plugins' : 'mods');
  if (typeof modrinthInstall.findInstalled === 'function') {
    return !!modrinthInstall.findInstalled(dir, 'bluemap');
  }
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).some(f => /^bluemap[-_.+]/i.test(f) && f.endsWith('.jar'));
}

/**
 * Crée ou met à jour une clé dans un fichier HOCON simple (clé: valeur)
 * sans modifier le reste du fichier ni les commentaires.
 */
function upsertHoconKey(filePath, key, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const line = `${key}: ${value}`;
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${line}\n`, 'utf8');
    return;
  }
  let content = fs.readFileSync(filePath, 'utf8');
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^([ \\t]*)${escaped}\\s*[:=].*$`, 'gm');
  if (re.test(content)) {
    content = content.replace(re, `$1${line}`);
  } else {
    if (content.length && !content.endsWith('\n')) content += '\n';
    content += `${line}\n`;
  }
  fs.writeFileSync(filePath, content, 'utf8');
}

/**
 * Attribue le premier port hôte libre à partir de 8100, unique entre serveurs
 * et sans conflit avec les ports de jeu.
 */
function findFreeBluemapPort(db, currentServer) {
  const rows = db.prepare('SELECT id, port, bluemap_enabled, bluemap_port FROM servers').all();
  const used = new Set();
  for (const r of rows) {
    if (r.port) used.add(Number(r.port));
    if (r.id !== currentServer.id && r.bluemap_enabled && r.bluemap_port) {
      used.add(Number(r.bluemap_port));
    }
  }
  if (currentServer.bluemap_port && currentServer.bluemap_port >= 8100 && !used.has(currentServer.bluemap_port)) {
    return currentServer.bluemap_port;
  }
  let port = 8100;
  while (used.has(port)) port++;
  return port;
}

function assertModdable(server) {
  const loader = (server.loader_type || '').toLowerCase();
  if (!loader || loader === 'vanilla') {
    throw Object.assign(
      new Error('BlueMap nécessite un serveur moddé (Fabric, Forge, NeoForge, Quilt) ou Paper/Purpur'),
      { status: 400 }
    );
  }
}

// GET /api/servers/:id/bluemap
router.get('/:id/bluemap', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });

    res.json({
      enabled: !!server.bluemap_enabled,
      port: server.bluemap_port || null,
      installed: isBluemapInstalled(server),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/servers/:id/bluemap/enable
router.post('/:id/bluemap/enable', authMiddleware, serverLock.requireIdle, async (req, res, next) => {
  try {
    const result = await serverLock.withLock(req.params.id, 'bluemap', async () => {
      const db = getDb();
      const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
      if (!server) return { notFound: true };

      assertModdable(server);
      await modrinthInstall.ensureProject(server, 'bluemap');

      const cfgDir = configDirFor(server);
      upsertHoconKey(path.join(cfgDir, 'core.conf'), 'accept-download', 'true');
      upsertHoconKey(path.join(cfgDir, 'webserver.conf'), 'port', '8100');

      const port = findFreeBluemapPort(db, server);
      db.prepare('UPDATE servers SET bluemap_enabled = 1, bluemap_port = ?, needs_recreate = 1 WHERE id = ?')
        .run(port, server.id);

      const updated = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);
      return { updated };
    });

    if (result.notFound) return res.status(404).json({ error: 'Serveur introuvable' });
    const { updated } = result;
    res.json({
      ok: true,
      enabled: true,
      port: updated.bluemap_port,
      installed: isBluemapInstalled(updated),
      needs_recreate: !!updated.needs_recreate,
      server: formatServer(updated),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/servers/:id/bluemap/disable
router.post('/:id/bluemap/disable', authMiddleware, serverLock.requireIdle, async (req, res, next) => {
  try {
    const result = await serverLock.withLock(req.params.id, 'bluemap', async () => {
      const db = getDb();
      const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
      if (!server) return { notFound: true };

      assertModdable(server);
      if (typeof modrinthInstall.removeProject === 'function') {
        modrinthInstall.removeProject(server, 'bluemap');
      }

      db.prepare('UPDATE servers SET bluemap_enabled = 0, needs_recreate = 1 WHERE id = ?')
        .run(server.id);

      const updated = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);
      return { updated };
    });

    if (result.notFound) return res.status(404).json({ error: 'Serveur introuvable' });
    const { updated } = result;
    res.json({
      ok: true,
      enabled: false,
      port: updated.bluemap_port || null,
      installed: isBluemapInstalled(updated),
      needs_recreate: !!updated.needs_recreate,
      server: formatServer(updated),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = { mount: '/api/servers', router };
