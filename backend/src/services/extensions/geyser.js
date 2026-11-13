// Extension crossplay Bedrock (Geyser + Floodgate) : ports Docker, décoration JSON,
// installation/suppression des jars Modrinth et édition ciblée de config.yml.
const fs = require('fs');
const path = require('path');
const { getDb } = require('../../config/database');

const SUPPORTED_LOADERS = new Set(['fabric', 'neoforge', 'paper', 'purpur']);
const DEFAULT_GEYSER_PORT = 19132;

function serverDirOf(server) {
  const dataPath = process.env.DATA_PATH || '/data';
  return path.join(dataPath, 'servers', server.id, 'server');
}

/**
 * Vérifie si le loader du serveur supporte Geyser + Floodgate.
 * @param {{ loader_type?: string | null }} server
 * @returns {{ supported: boolean, reason: string | null }}
 */
function checkSupport(server) {
  const loader = String(server?.loader_type || '').trim().toLowerCase();
  if (SUPPORTED_LOADERS.has(loader)) {
    return { supported: true, reason: null };
  }
  if (!loader || loader === 'vanilla') {
    return {
      supported: false,
      reason: 'Geyser nécessite un serveur Fabric, NeoForge, Paper ou Purpur (non disponible sur vanilla).',
    };
  }
  return {
    supported: false,
    reason: `Geyser ne supporte pas le loader « ${server.loader_type} » (loaders supportés : Fabric, NeoForge, Paper, Purpur).`,
  };
}

/**
 * Chemin absolu du fichier config.yml de Geyser selon le loader du serveur, ou null si non supporté.
 * @param {{ id: string, loader_type?: string | null }} server
 * @returns {string | null}
 */
function configPathFor(server) {
  const loader = String(server?.loader_type || '').trim().toLowerCase();
  let rel = null;
  if (loader === 'fabric') rel = path.join('config', 'Geyser-Fabric', 'config.yml');
  else if (loader === 'neoforge') rel = path.join('config', 'Geyser-NeoForge', 'config.yml');
  else if (loader === 'paper' || loader === 'purpur') rel = path.join('plugins', 'Geyser-Spigot', 'config.yml');
  return rel ? path.join(serverDirOf(server), rel) : null;
}

/**
 * Modifie ou insère `section -> key: value` dans un fichier YAML en préservant commentaires et autres clés.
 * @param {string} content
 * @param {string} section
 * @param {string} key
 * @param {string | number} value
 * @returns {string}
 */
function setYamlSectionKey(content, section, key, value) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content ? content.split(/\r?\n/) : [];
  const secRe = new RegExp(`^${section}:(?:\\s*(?:#.*)?)?$`);
  const emptyMapRe = new RegExp(`^${section}:\\s*\\{\\s*\\}(?:\\s*(#.*))?$`);

  let inSection = false;
  let sectionStart = -1;
  let sectionIndent = null;
  let lastContentIdx = -1;
  let replaced = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inSection) {
      const emptyMatch = line.match(emptyMapRe);
      if (emptyMatch) {
        lines[i] = `${section}:${emptyMatch[1] ? ' ' + emptyMatch[1] : ''}`;
        lines.splice(i + 1, 0, `  ${key}: ${value}`);
        replaced = true;
        break;
      }
      if (secRe.test(line)) {
        inSection = true;
        sectionStart = i;
        lastContentIdx = i;
      }
      continue;
    }

    if (/^\s*(?:#.*)?$/.test(line)) continue;

    // Retour en colonne 0 : début d'une autre section racine
    if (/^\S/.test(line)) {
      if (!replaced) {
        const indent = sectionIndent || '  ';
        lines.splice(lastContentIdx + 1, 0, `${indent}${key}: ${value}`);
        replaced = true;
      }
      inSection = false;
      break;
    }

    const kvMatch = line.match(/^(\s+)([A-Za-z0-9_-]+)\s*:(.*)$/);
    if (kvMatch) {
      const indentStr = kvMatch[1];
      if (sectionIndent === null || indentStr.length < sectionIndent.length) {
        sectionIndent = indentStr;
      }
      if (indentStr.length === sectionIndent.length && kvMatch[2] === key) {
        const commentMatch = kvMatch[3].match(/^(?:[^"'#]*|"[^"]*"|'[^']*')\s+(#.*)$/);
        const suffix = commentMatch ? ` ${commentMatch[1]}` : '';
        lines[i] = `${indentStr}${key}: ${value}${suffix}`;
        replaced = true;
        break;
      }
    }
    lastContentIdx = i;
  }

  if (inSection && !replaced) {
    const indent = sectionIndent || '  ';
    lines.splice(lastContentIdx + 1, 0, `${indent}${key}: ${value}`);
    replaced = true;
  }

  if (!replaced && sectionStart === -1) {
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    lines.push(`${section}:`, `  ${key}: ${value}`);
  }

  let out = lines.join(eol);
  if (!out.endsWith(eol)) out += eol;
  return out;
}

/**
 * Crée ou met à jour config.yml avec bedrock.port = 19132 et remote.auth-type = floodgate|online.
 * @param {{ id: string, loader_type?: string | null }} server
 * @param {boolean} floodgate
 * @returns {string | null}
 */
function writeGeyserConfig(server, floodgate) {
  const file = configPathFor(server);
  if (!file) return null;
  let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  content = setYamlSectionKey(content, 'bedrock', 'port', DEFAULT_GEYSER_PORT);
  content = setYamlSectionKey(content, 'remote', 'auth-type', floodgate ? 'floodgate' : 'online');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

/**
 * Premier port UDP libre à partir de 19132, unique entre serveurs.
 * @param {any} db
 * @param {string | null} [excludeServerId=null]
 * @returns {number}
 */
function findFreeGeyserPort(db, excludeServerId = null) {
  const rows = db.prepare('SELECT geyser_port FROM servers WHERE geyser_port IS NOT NULL AND id != ?')
    .all(excludeServerId || '');
  const used = new Set(rows.map(r => Number(r.geyser_port)));
  let port = DEFAULT_GEYSER_PORT;
  while (used.has(port)) port++;
  return port;
}

/**
 * Active Geyser (et Floodgate si demandé) : installe les jars, écrit config.yml, attribue un port UDP et marque needs_recreate.
 * @param {any} server
 * @param {{ floodgate?: boolean }} [opts]
 */
async function enable(server, { floodgate = true } = {}) {
  const support = checkSupport(server);
  if (!support.supported) {
    throw Object.assign(new Error(support.reason), { status: 400 });
  }

  const modrinthInstall = require('../modrinthInstall');
  await modrinthInstall.ensureProject(server, 'geyser');
  if (floodgate) {
    await modrinthInstall.ensureProject(server, 'floodgate');
  } else if (server.geyser_enabled && server.geyser_floodgate) {
    modrinthInstall.removeProject(server, 'floodgate');
  }

  writeGeyserConfig(server, floodgate);

  const db = getDb();
  const usedByOther = server.geyser_port
    ? db.prepare('SELECT id FROM servers WHERE geyser_port = ? AND id != ?').get(server.geyser_port, server.id)
    : true;
  const port = (server.geyser_port && !usedByOther) ? server.geyser_port : findFreeGeyserPort(db, server.id);

  db.prepare(`
    UPDATE servers
    SET geyser_enabled = 1,
        geyser_port = ?,
        geyser_floodgate = ?,
        needs_recreate = 1
    WHERE id = ?
  `).run(port, floodgate ? 1 : 0, server.id);

  return db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);
}

/**
 * Désactive Geyser : supprime les jars Geyser/Floodgate, remet les champs Geyser à zéro et marque needs_recreate si actif.
 * @param {any} server
 */
function disable(server) {
  const modrinthInstall = require('../modrinthInstall');
  modrinthInstall.removeProject(server, 'geyser');
  modrinthInstall.removeProject(server, 'floodgate');

  const db = getDb();
  const wasActive = !!server.geyser_enabled || server.geyser_port !== null;
  db.prepare(`
    UPDATE servers
    SET geyser_enabled = 0,
        geyser_port = NULL,
        geyser_floodgate = 1,
        needs_recreate = CASE WHEN ? THEN 1 ELSE needs_recreate END
    WHERE id = ?
  `).run(wasActive ? 1 : 0, server.id);

  return db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);
}

/**
 * État Geyser formaté pour l'API GET /api/servers/:id/geyser.
 * @param {any} server
 */
function getStatus(server) {
  const { supported, reason } = checkSupport(server);
  return {
    enabled: !!server.geyser_enabled,
    port: server.geyser_port || null,
    floodgate: server.geyser_floodgate !== 0,
    supported,
    reason,
  };
}

/** Hook extension : expose 19132/udp → HostPort geyser_port lorsque Geyser est activé. */
function ports(server) {
  if (!server?.geyser_enabled || !server?.geyser_port) {
    return { exposed: {}, bindings: {} };
  }
  return {
    exposed: { '19132/udp': {} },
    bindings: { '19132/udp': [{ HostPort: String(server.geyser_port) }] },
  };
}

/** Hook extension : ajoute les champs Geyser normalisés à la réponse JSON d'un serveur. */
function decorate(row) {
  return {
    geyser_enabled: !!row.geyser_enabled,
    geyser_port: row.geyser_port || null,
    geyser_floodgate: row.geyser_floodgate !== 0,
  };
}

module.exports = {
  name: 'geyser',
  ports,
  decorate,
  checkSupport,
  configPathFor,
  setYamlSectionKey,
  writeGeyserConfig,
  findFreeGeyserPort,
  enable,
  disable,
  getStatus,
};
