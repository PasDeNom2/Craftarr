// Gestion des profils de serveur (multi-modpacks/mondes sur un même serveur).
// Le dossier actif reste <DATA>/servers/<id>/server ; les profils inactifs vivent dans
// <DATA>/servers/<id>/profiles/<profileId>/ afin que la bascule soit un renommage atomique.
const fs = require('fs');
const path = require('path');
const { randomUUID: uuidv4 } = require('crypto');
const { getDb } = require('../config/database');
const serverLock = require('./serverLock');
const validate = require('./validate');
const { isMcVersion } = require('./mcVersion');

const SIZE_CACHE_TTL_MS = 60_000;
const sizeCache = new Map(); // dir -> { bytes, at }

const dataPath = () => process.env.DATA_PATH || '/data';
const serverRoot = (serverId) => path.join(dataPath(), 'servers', serverId);
const serverDir = (serverId) => path.join(serverRoot(serverId), 'server');
const profilesRoot = (serverId) => path.join(serverRoot(serverId), 'profiles');
const profileDir = (serverId, profileId) => path.join(profilesRoot(serverId), profileId);

function validateName(name) {
  return validate.str(name, { max: 48, field: 'name', noNewlines: true });
}

function assertValidProfileId(profileId) {
  if (typeof profileId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(profileId)) {
    throw Object.assign(new Error('Identifiant de profil invalide'), { status: 400 });
  }
}

async function dirSizeAsync(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += await dirSizeAsync(full);
      } else if (entry.isFile()) {
        const st = await fs.promises.lstat(full);
        total += st.size;
      }
    } catch {}
  }
  return total;
}

async function getDirSize(dir) {
  const cached = sizeCache.get(dir);
  if (cached && Date.now() - cached.at < SIZE_CACHE_TTL_MS) {
    return cached.bytes;
  }
  const bytes = await dirSizeAsync(dir);
  sizeCache.set(dir, { bytes, at: Date.now() });
  return bytes;
}

function invalidateSizeCache(serverId) {
  const prefix = serverRoot(serverId);
  for (const key of sizeCache.keys()) {
    if (key.startsWith(prefix)) sizeCache.delete(key);
  }
}

/** Exécute fn sous verrou serveur après avoir vérifié que le serveur n'est pas occupé. */
async function withServerLock(server, op, fn) {
  const busy = serverLock.busyReason(server);
  if (busy) throw Object.assign(new Error(busy), { status: 409 });

  return serverLock.withLock(server.id, op, async () => {
    const db = getDb();
    const fresh = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);
    if (!fresh) throw Object.assign(new Error('Serveur introuvable'), { status: 404 });
    if (['installing', 'updating'].includes(fresh.status)) {
      throw Object.assign(new Error(serverLock.busyReason(fresh) || 'Serveur occupé'), { status: 409 });
    }
    return fn(db, fresh);
  });
}

/** Même logique que recreateContainer dans routes/servers/lifecycle.js. */
async function recreateContainer(db, server) {
  const dockerService = require('./docker');
  if (server.container_id) {
    await dockerService.removeContainer(server.container_id).catch(() => {});
  }

  db.prepare("UPDATE servers SET container_id = NULL, container_name = NULL, status = 'stopped' WHERE id = ?").run(server.id);
  const fresh = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);

  let created;
  try {
    created = await dockerService.createServerContainer(fresh);
  } catch (err) {
    err.expose = true;
    db.prepare("UPDATE servers SET status = 'error' WHERE id = ?").run(server.id);
    throw err;
  }

  db.prepare('UPDATE servers SET container_id = ?, container_name = ?, needs_recreate = 0 WHERE id = ?')
    .run(created.containerId, created.containerName, server.id);
  return { ...created, server: fresh };
}

const META_COLS = [
  'modpack_id', 'modpack_name', 'modpack_source', 'modpack_version',
  'modpack_version_id', 'modpack_download_url', 'mc_version', 'loader_type',
];

/** Enregistre un profil inactif avec les métadonnées d'installation fournies. */
function insertProfile(db, id, serverId, name, meta) {
  db.prepare(`
    INSERT INTO server_profiles (id, server_id, name, ${META_COLS.join(', ')}, last_used_at)
    VALUES (?, ?, ?, ${META_COLS.map(() => '?').join(', ')}, datetime('now'))
  `).run(id, serverId, name, ...META_COLS.map(c => meta[c] ?? null));
}

function buildActiveSummary(server, sizeBytes) {
  return {
    id: 'active',
    name: server.active_profile_name || null,
    modpack_id: server.modpack_id,
    modpack_name: server.modpack_name,
    modpack_source: server.modpack_source,
    modpack_version: server.modpack_version,
    modpack_version_id: server.modpack_version_id,
    mc_version: server.mc_version,
    loader_type: server.loader_type,
    size_bytes: sizeBytes,
  };
}

/** Liste le profil actif et les profils inactifs d'un serveur (avec taille disque en cache). */
async function listProfiles(server) {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM server_profiles WHERE server_id = ? ORDER BY COALESCE(last_used_at, created_at) DESC, created_at DESC'
  ).all(server.id);

  const [activeSize, ...profileSizes] = await Promise.all([
    getDirSize(serverDir(server.id)),
    ...rows.map(p => getDirSize(profileDir(server.id, p.id))),
  ]);

  return {
    active: buildActiveSummary(server, activeSize),
    profiles: rows.map((p, i) => ({ ...p, size_bytes: profileSizes[i] })),
  };
}

/** Sauvegarde l'installation active comme un nouveau profil (copie récursive, serveur arrêté). */
async function saveCurrentAs(server, name) {
  const validName = validateName(name);

  return withServerLock(server, 'sauvegarde du profil', async (db, fresh) => {
    if (!['stopped', 'error'].includes(fresh.status)) {
      throw Object.assign(new Error('Le serveur doit être arrêté pour sauvegarder le profil actuel'), { status: 409 });
    }

    const src = serverDir(fresh.id);
    if (!fs.existsSync(src)) {
      throw Object.assign(new Error('Dossier du serveur introuvable'), { status: 400 });
    }

    const id = uuidv4();
    const dest = profileDir(fresh.id, id);
    fs.mkdirSync(profilesRoot(fresh.id), { recursive: true });

    try {
      fs.cpSync(src, dest, { recursive: true });
    } catch (err) {
      fs.rmSync(dest, { recursive: true, force: true });
      throw err;
    }

    insertProfile(db, id, fresh.id, validName, fresh);

    invalidateSizeCache(fresh.id);
    const created = db.prepare('SELECT * FROM server_profiles WHERE id = ?').get(id);
    const sizeBytes = await getDirSize(dest);
    return { ...created, size_bytes: sizeBytes };
  });
}

/** Bascule l'installation active vers un profil enregistré (renommage + recréation container + rollback). */
async function switchTo(server, profileId, { io } = {}) {
  assertValidProfileId(profileId);
  if (profileId === 'active') {
    throw Object.assign(new Error('Ce profil est déjà actif'), { status: 400 });
  }

  return withServerLock(server, 'changement de profil', async (db, fresh) => {
    const dockerService = require('./docker');
    const profile = db.prepare('SELECT * FROM server_profiles WHERE id = ? AND server_id = ?')
      .get(profileId, fresh.id);
    if (!profile) {
      throw Object.assign(new Error('Profil introuvable'), { status: 404 });
    }

    const targetDir = profileDir(fresh.id, profile.id);
    if (!fs.existsSync(targetDir)) {
      throw Object.assign(new Error('Dossier du profil introuvable sur le disque'), { status: 404 });
    }

    const wasRunning = ['running', 'starting'].includes(fresh.status);
    if (fresh.container_id && wasRunning) {
      await dockerService.stopContainer(fresh.container_id);
      db.prepare("UPDATE servers SET status = 'stopped' WHERE id = ?").run(fresh.id);
      try { db.prepare('UPDATE players SET is_online = 0 WHERE server_id = ?').run(fresh.id); } catch {}
    }

    const prevMeta = {
      modpack_id: fresh.modpack_id,
      modpack_name: fresh.modpack_name,
      modpack_source: fresh.modpack_source,
      modpack_version: fresh.modpack_version,
      modpack_version_id: fresh.modpack_version_id,
      modpack_download_url: fresh.modpack_download_url,
      mc_version: fresh.mc_version,
      loader_type: fresh.loader_type,
      active_profile_name: fresh.active_profile_name,
    };

    const activeDir = serverDir(fresh.id);
    const archivedId = uuidv4();
    const archivedDir = profileDir(fresh.id, archivedId);
    fs.mkdirSync(profilesRoot(fresh.id), { recursive: true });

    let movedActive = false;
    let movedTarget = false;
    let containerTouched = false;

    try {
      if (fs.existsSync(activeDir)) {
        fs.renameSync(activeDir, archivedDir);
        movedActive = true;
      }
      fs.renameSync(targetDir, activeDir);
      movedTarget = true;

      db.prepare(`
        UPDATE servers SET
          modpack_id = ?, modpack_name = ?, modpack_source = ?,
          modpack_version = ?, modpack_version_id = ?, modpack_download_url = ?,
          mc_version = ?, loader_type = ?, active_profile_name = ?
        WHERE id = ?
      `).run(
        profile.modpack_id ?? fresh.modpack_id,
        profile.modpack_name ?? fresh.modpack_name,
        profile.modpack_source ?? fresh.modpack_source,
        profile.modpack_version ?? null,
        profile.modpack_version_id ?? null,
        profile.modpack_download_url ?? null,
        profile.mc_version ?? null,
        profile.loader_type ?? fresh.loader_type,
        profile.name,
        fresh.id,
      );

      containerTouched = true;
      const { containerId, server: recreatedServer } = await recreateContainer(db, fresh);

      if (wasRunning) {
        try {
          await dockerService.startContainer(containerId, recreatedServer);
          db.prepare("UPDATE servers SET status = 'starting' WHERE id = ?").run(fresh.id);
          if (io) {
            try { require('../websocket/logs').startLogStream(io, fresh.id); } catch {}
          }
        } catch (startErr) {
          startErr.expose = true;
          db.prepare("UPDATE servers SET status = 'error' WHERE id = ?").run(fresh.id);
          throw startErr;
        }
      }

      db.transaction(() => {
        if (movedActive) {
          insertProfile(db, archivedId, fresh.id, prevMeta.active_profile_name || 'Profil précédent', prevMeta);
        }
        db.prepare('DELETE FROM server_profiles WHERE id = ? AND server_id = ?').run(profile.id, fresh.id);
      })();

      invalidateSizeCache(fresh.id);
      const updated = db.prepare('SELECT * FROM servers WHERE id = ?').get(fresh.id);
      return { server: updated, archivedProfileId: movedActive ? archivedId : null };
    } catch (err) {
      // Rollback en cas d'échec : 1) libérer le dossier actif (container du profil cible),
      // 2) remettre les dossiers en place sans jamais écraser un dossier existant,
      // 3) restaurer les métadonnées, 4) recréer le container de l'installation d'origine.
      if (containerTouched) {
        const cur = db.prepare('SELECT container_id FROM servers WHERE id = ?').get(fresh.id);
        if (cur?.container_id) {
          await dockerService.stopContainer(cur.container_id).catch(() => {});
          await dockerService.removeContainer(cur.container_id).catch(() => {});
          db.prepare('UPDATE servers SET container_id = NULL, container_name = NULL WHERE id = ?').run(fresh.id);
        }
      }
      try {
        if (movedTarget && fs.existsSync(activeDir) && !fs.existsSync(targetDir)) {
          fs.renameSync(activeDir, targetDir);
        }
        if (movedActive && fs.existsSync(archivedDir) && !fs.existsSync(activeDir)) {
          fs.renameSync(archivedDir, activeDir);
        }
      } catch (rbErr) {
        console.error(`[Profiles] Rollback dossier échoué pour ${fresh.id}:`, rbErr.message);
      }
      try {
        db.prepare(`
          UPDATE servers SET
            modpack_id = ?, modpack_name = ?, modpack_source = ?,
            modpack_version = ?, modpack_version_id = ?, modpack_download_url = ?,
            mc_version = ?, loader_type = ?, active_profile_name = ?
          WHERE id = ?
        `).run(
          prevMeta.modpack_id,
          prevMeta.modpack_name,
          prevMeta.modpack_source,
          prevMeta.modpack_version,
          prevMeta.modpack_version_id,
          prevMeta.modpack_download_url,
          prevMeta.mc_version,
          prevMeta.loader_type,
          prevMeta.active_profile_name,
          fresh.id,
        );
      } catch {}
      if (containerTouched) {
        // Best effort : le serveur retrouve un container pour son installation d'origine
        try {
          const restored = db.prepare('SELECT * FROM servers WHERE id = ?').get(fresh.id);
          const { containerId } = await recreateContainer(db, restored);
          if (wasRunning) {
            await dockerService.startContainer(containerId, restored);
            db.prepare("UPDATE servers SET status = 'starting' WHERE id = ?").run(fresh.id);
          }
        } catch (rcErr) {
          console.error(`[Profiles] Recréation du container d'origine échouée pour ${fresh.id}:`, rcErr.message);
        }
      }
      invalidateSizeCache(fresh.id);
      err.expose = true;
      throw err;
    }
  });
}

/** Renomme un profil (inactif ou actif). */
async function rename(server, profileId, name) {
  assertValidProfileId(profileId);
  const validName = validateName(name);

  return withServerLock(server, 'renommage du profil', async (db, fresh) => {
    if (profileId === 'active') {
      db.prepare('UPDATE servers SET active_profile_name = ? WHERE id = ?').run(validName, fresh.id);
      const updated = db.prepare('SELECT * FROM servers WHERE id = ?').get(fresh.id);
      const sizeBytes = await getDirSize(serverDir(fresh.id));
      return buildActiveSummary(updated, sizeBytes);
    }

    const existing = db.prepare('SELECT * FROM server_profiles WHERE id = ? AND server_id = ?')
      .get(profileId, fresh.id);
    if (!existing) {
      throw Object.assign(new Error('Profil introuvable'), { status: 404 });
    }

    db.prepare('UPDATE server_profiles SET name = ? WHERE id = ? AND server_id = ?')
      .run(validName, profileId, fresh.id);
    const updated = db.prepare('SELECT * FROM server_profiles WHERE id = ?').get(profileId);
    const sizeBytes = await getDirSize(profileDir(fresh.id, profileId));
    return { ...updated, size_bytes: sizeBytes };
  });
}

/** Supprime un profil inactif et son dossier sur disque (refusé pour le profil actif). */
async function remove(server, profileId) {
  assertValidProfileId(profileId);

  return withServerLock(server, 'suppression du profil', async (db, fresh) => {
    if (profileId === 'active') {
      throw Object.assign(new Error('Impossible de supprimer le profil actif'), { status: 400 });
    }

    const existing = db.prepare('SELECT * FROM server_profiles WHERE id = ? AND server_id = ?')
      .get(profileId, fresh.id);
    if (!existing) {
      throw Object.assign(new Error('Profil introuvable'), { status: 404 });
    }

    fs.rmSync(profileDir(fresh.id, profileId), { recursive: true, force: true });
    db.prepare('DELETE FROM server_profiles WHERE id = ? AND server_id = ?').run(profileId, fresh.id);
    invalidateSizeCache(fresh.id);
    return { ok: true };
  });
}

/**
 * Archive l'installation actuelle en profil puis installe un nouveau modpack dans un
 * dossier server/ vide (sans copier le monde).
 */
async function newFromModpack(server, body = {}) {
  let {
    name, modpack_id, modpack_name, modpack_source, modpack_version, modpack_version_id, mc_version, loader_type = 'forge',
  } = body;
  const validName = validateName(name);
  if (typeof loader_type !== 'string' || !/^[a-z]{2,20}$/.test(loader_type)) {
    throw Object.assign(new Error('loader_type invalide'), { status: 400 });
  }
  const isVanilla = loader_type === 'vanilla';
  if (!isVanilla && (!modpack_id || !modpack_source)) {
    throw Object.assign(new Error('modpack_id et modpack_source sont requis'), { status: 400 });
  }
  const optStr = (v, field) => (v === undefined || v === null || v === '')
    ? null
    : validate.str(String(v), { max: 128, field, noNewlines: true });
  modpack_id = optStr(modpack_id, 'modpack_id');
  modpack_name = optStr(modpack_name, 'modpack_name');
  modpack_version = optStr(modpack_version, 'modpack_version');
  modpack_version_id = optStr(modpack_version_id, 'modpack_version_id');
  if (!isVanilla && !getDb().prepare('SELECT 1 FROM api_sources WHERE id = ?').get(String(modpack_source))) {
    throw Object.assign(new Error('modpack_source inconnue'), { status: 400 });
  }

  const effectiveModpackId = isVanilla ? (modpack_id || `vanilla-${mc_version || 'latest'}`) : String(modpack_id);
  const effectiveModpackSource = isVanilla ? 'vanilla' : String(modpack_source);
  const validMcVersion = isMcVersion(mc_version) ? mc_version : null;

  const updatedServer = await withServerLock(server, 'création de profil', async (db, fresh) => {
    const dockerService = require('./docker');

    // Arrêt seulement : le container n'est supprimé qu'une fois les dossiers basculés
    if (fresh.container_id && ['running', 'starting'].includes(fresh.status)) {
      await dockerService.stopContainer(fresh.container_id);
      db.prepare("UPDATE servers SET status = 'stopped' WHERE id = ?").run(fresh.id);
      try { db.prepare('UPDATE players SET is_online = 0 WHERE server_id = ?').run(fresh.id); } catch {}
    }

    const activeDir = serverDir(fresh.id);
    const archivedId = uuidv4();
    const archivedDir = profileDir(fresh.id, archivedId);
    fs.mkdirSync(profilesRoot(fresh.id), { recursive: true });

    let movedActive = false;
    try {
      if (fs.existsSync(activeDir)) {
        fs.renameSync(activeDir, archivedDir);
        movedActive = true;
      } else {
        fs.mkdirSync(archivedDir, { recursive: true });
      }
      fs.mkdirSync(activeDir, { recursive: true });

      db.transaction(() => {
      insertProfile(db, archivedId, fresh.id, fresh.active_profile_name || 'Profil précédent', fresh);

      db.prepare(`
        UPDATE servers SET
          modpack_id = ?, modpack_name = ?, modpack_source = ?,
          modpack_version = ?, modpack_version_id = ?, modpack_download_url = NULL,
          mc_version = ?, loader_type = ?, active_profile_name = ?,
          status = 'installing', container_id = NULL, container_name = NULL, needs_recreate = 0
        WHERE id = ?
      `).run(
        effectiveModpackId,
        modpack_name || effectiveModpackId,
        effectiveModpackSource,
        modpack_version || null,
        modpack_version_id ? String(modpack_version_id) : null,
        validMcVersion,
        loader_type || 'forge',
        validName,
        fresh.id,
      );
      })();
    } catch (err) {
      // Rollback : le dossier server/ (vide, créé ici) est retiré et l'installation d'origine remise en place
      try {
        if (movedActive && fs.existsSync(archivedDir)) {
          if (fs.existsSync(activeDir) && fs.readdirSync(activeDir).length === 0) fs.rmdirSync(activeDir);
          if (!fs.existsSync(activeDir)) fs.renameSync(archivedDir, activeDir);
        } else if (!movedActive) {
          fs.rmSync(archivedDir, { recursive: true, force: true });
        }
      } catch (rbErr) {
        console.error(`[Profiles] Rollback dossier échoué pour ${fresh.id}:`, rbErr.message);
      }
      invalidateSizeCache(fresh.id);
      throw err;
    }

    if (fresh.container_id) {
      await dockerService.removeContainer(fresh.container_id).catch(() => {});
    }
    invalidateSizeCache(fresh.id);
    return db.prepare('SELECT * FROM servers WHERE id = ?').get(fresh.id);
  });

  // Lancement asynchrone hors du verrou (installer.installServer prend son propre verrou 'installation')
  const installer = require('./installer');
  installer.installServer(updatedServer).catch(err => {
    console.error(`[Profiles] Erreur installation nouveau profil pour ${updatedServer.id}:`, err.message);
    try {
      getDb().prepare("UPDATE servers SET status = 'error' WHERE id = ?").run(updatedServer.id);
    } catch {}
  });

  return updatedServer;
}

module.exports = {
  listProfiles,
  saveCurrentAs,
  switchTo,
  rename,
  remove,
  newFromModpack,
  _internals: { getDirSize, invalidateSizeCache, sizeCache },
};
