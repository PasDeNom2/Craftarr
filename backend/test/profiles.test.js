// Profils de serveur : sauvegarde, bascule, rollback container, renommage, suppression, nouveau depuis modpack et routes API.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempDataPath, src } = require('./helpers');

const DATA = useTempDataPath();
const calls = [];
const installCalls = [];
let createFailOnce = false;
let ctrCounter = 0;

const mock = (rel, exports) => {
  const p = require.resolve(src(rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

mock('services/docker.js', {
  stopContainer: async (cid) => calls.push(`stop:${cid}`),
  removeContainer: async (cid) => calls.push(`remove:${cid}`),
  createServerContainer: async (srv) => {
    if (createFailOnce) {
      createFailOnce = false;
      throw new Error('docker create KO');
    }
    ctrCounter += 1;
    const containerId = `ctr-${ctrCounter}`;
    calls.push(`create:${srv.mc_version}:${srv.loader_type}:${containerId}`);
    return { containerId, containerName: `mc-test-${ctrCounter}` };
  },
  startContainer: async (cid) => calls.push(`start:${cid}`),
});

mock('services/installer.js', {
  installServer: async (srv) => {
    installCalls.push({ id: srv.id, modpack_id: srv.modpack_id, mc_version: srv.mc_version, loader_type: srv.loader_type });
  },
});

const { initDb, getDb } = require(src('config/database'));
const serverLock = require(src('services/serverLock'));

const serverId = 'pppppppp-1111-0000-0000-000000000000';
const serverDir = path.join(DATA, 'servers', serverId, 'server');
const profilesDir = path.join(DATA, 'servers', serverId, 'profiles');

let db, profiles, httpServer, base, token;

before(async () => {
  initDb();
  db = getDb();
  profiles = require(src('services/profiles'));

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });
  const { mount, router } = require(src('routes/features/profiles'));
  app.use(mount, router);
  app.use(require(src('middleware/errorHandler')));

  httpServer = app.listen(0);
  base = `http://127.0.0.1:${httpServer.address().port}/api/servers/${serverId}`;

  const { loadOrCreateSecrets, signUserToken } = require(src('config/secrets'));
  loadOrCreateSecrets();
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES ('u1', 'admin', 'x')").run();
  token = signUserToken({ id: 'u1', username: 'admin', token_version: 0 });
});

after(() => httpServer?.close());

function reset({ status = 'stopped', activeProfileName = null } = {}) {
  fs.rmSync(path.join(DATA, 'servers', serverId), { recursive: true, force: true });
  fs.mkdirSync(path.join(serverDir, 'world'), { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'world', 'level.dat'), 'MONDE-ACTUEL');
  fs.mkdirSync(path.join(serverDir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'mods', 'pack-a.jar'), 'modpack-a');

  db.prepare('DELETE FROM server_profiles').run();
  db.prepare('DELETE FROM servers').run();
  db.prepare(`
    INSERT INTO servers (
      id, name, modpack_id, modpack_name, modpack_source, modpack_version, modpack_version_id,
      port, rcon_port, rcon_password, ram_mb, max_players, status, mc_version, loader_type,
      container_id, active_profile_name
    ) VALUES (?, 'Srv', 'pack-a', 'Pack A', 'curseforge', '1.0', '100', 25565, 25575, 'pw', 4096, 10, ?, '1.20.1', 'forge', 'ctr-0', ?)
  `).run(serverId, status, activeProfileName);

  calls.length = 0;
  installCalls.length = 0;
  profiles._internals.invalidateSizeCache(serverId);
  return db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
}

const srvRow = () => db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
const apiReq = async (method, suffix = '', body) => {
  const res = await fetch(base + suffix, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
};

test('saveCurrentAs puis switchTo (serveur arrêté) : fichiers préservés et échangés, container recréé sans démarrage', async () => {
  const srv = reset({ status: 'stopped', activeProfileName: 'Pack A' });
  const saved = await profiles.saveCurrentAs(srv, 'Sauvegarde B');
  assert.ok(saved.id);
  assert.strictEqual(saved.name, 'Sauvegarde B');
  assert.strictEqual(saved.modpack_id, 'pack-a');

  // Modifier les fichiers du profil sauvegardé pour distinguer les deux installations
  const savedDir = path.join(profilesDir, saved.id);
  fs.writeFileSync(path.join(savedDir, 'world', 'level.dat'), 'MONDE-B');
  fs.rmSync(path.join(savedDir, 'mods', 'pack-a.jar'));
  fs.writeFileSync(path.join(savedDir, 'mods', 'pack-b.jar'), 'modpack-b');
  db.prepare("UPDATE server_profiles SET modpack_id = 'pack-b', modpack_name = 'Pack B', modpack_source = 'modrinth', modpack_version = '2.0', modpack_version_id = '200', mc_version = '1.21.1', loader_type = 'neoforge' WHERE id = ?").run(saved.id);

  const res = await profiles.switchTo(srvRow(), saved.id);
  assert.strictEqual(res.server.modpack_id, 'pack-b');
  assert.strictEqual(res.server.modpack_name, 'Pack B');
  assert.strictEqual(res.server.modpack_source, 'modrinth');
  assert.strictEqual(res.server.modpack_version, '2.0');
  assert.strictEqual(res.server.mc_version, '1.21.1');
  assert.strictEqual(res.server.loader_type, 'neoforge');
  assert.strictEqual(res.server.active_profile_name, 'Sauvegarde B');
  assert.strictEqual(res.server.status, 'stopped');

  // Les fichiers actifs sont maintenant ceux du profil B
  assert.strictEqual(fs.readFileSync(path.join(serverDir, 'world', 'level.dat'), 'utf8'), 'MONDE-B');
  assert.ok(fs.existsSync(path.join(serverDir, 'mods', 'pack-b.jar')));
  assert.ok(!fs.existsSync(path.join(serverDir, 'mods', 'pack-a.jar')));

  // L'ancien dossier actif a été rangé dans profiles/<archivedProfileId>/
  assert.ok(res.archivedProfileId);
  const archivedDir = path.join(profilesDir, res.archivedProfileId);
  assert.strictEqual(fs.readFileSync(path.join(archivedDir, 'world', 'level.dat'), 'utf8'), 'MONDE-ACTUEL');
  assert.ok(fs.existsSync(path.join(archivedDir, 'mods', 'pack-a.jar')));

  const archivedRow = db.prepare('SELECT * FROM server_profiles WHERE id = ?').get(res.archivedProfileId);
  assert.strictEqual(archivedRow.name, 'Pack A');
  assert.strictEqual(archivedRow.modpack_id, 'pack-a');
  assert.strictEqual(db.prepare('SELECT * FROM server_profiles WHERE id = ?').get(saved.id), undefined);

  // Container recréé mais PAS démarré car le serveur était arrêté
  assert.ok(calls.some(c => c.startsWith('remove:ctr-0')));
  assert.ok(calls.some(c => c.startsWith('create:1.21.1:neoforge:')));
  assert.ok(!calls.some(c => c.startsWith('start:')), `ne devait pas démarrer : ${calls.join(', ')}`);
});

test('switchTo sur serveur actif : arrête l\'ancien container, recrée et redémarre', async () => {
  const srvStopped = reset({ status: 'stopped' });
  const p = await profiles.saveCurrentAs(srvStopped, 'Autre');
  db.prepare("UPDATE servers SET status = 'running' WHERE id = ?").run(serverId);
  db.prepare("UPDATE server_profiles SET mc_version = '1.21.4', loader_type = 'fabric' WHERE id = ?").run(p.id);
  calls.length = 0;

  const res = await profiles.switchTo(srvRow(), p.id);
  assert.strictEqual(res.server.status, 'starting');
  assert.strictEqual(res.server.mc_version, '1.21.4');
  assert.strictEqual(res.server.loader_type, 'fabric');

  assert.strictEqual(calls[0], 'stop:ctr-0');
  assert.ok(calls.some(c => c.startsWith('create:1.21.4:fabric:')));
  assert.ok(calls.some(c => c.startsWith('start:')));

  // Le profil archivé sans active_profile_name prend le nom « Profil précédent »
  const archived = db.prepare('SELECT * FROM server_profiles WHERE id = ?').get(res.archivedProfileId);
  assert.strictEqual(archived.name, 'Profil précédent');
});

test('échec de recréation du container → dossiers et métadonnées remis dans l\'état initial', async () => {
  const srv = reset({ status: 'stopped', activeProfileName: 'Initial' });
  const p = await profiles.saveCurrentAs(srv, 'Cible');
  const pDir = path.join(profilesDir, p.id);
  fs.writeFileSync(path.join(pDir, 'world', 'level.dat'), 'MONDE-CIBLE');
  db.prepare("UPDATE server_profiles SET modpack_id = 'pack-cible', mc_version = '1.21.1' WHERE id = ?").run(p.id);

  createFailOnce = true;
  await assert.rejects(() => profiles.switchTo(srvRow(), p.id), /docker create KO/);

  // Dossiers remis à l'état initial
  assert.strictEqual(fs.readFileSync(path.join(serverDir, 'world', 'level.dat'), 'utf8'), 'MONDE-ACTUEL');
  assert.strictEqual(fs.readFileSync(path.join(pDir, 'world', 'level.dat'), 'utf8'), 'MONDE-CIBLE');

  // Métadonnées restaurées et liste de profils inchangée
  const afterSrv = srvRow();
  assert.strictEqual(afterSrv.modpack_id, 'pack-a');
  assert.strictEqual(afterSrv.mc_version, '1.20.1');
  assert.strictEqual(afterSrv.active_profile_name, 'Initial');
  // Le container de l'installation d'origine est recréé (best effort)
  assert.ok(calls.some(c => c.startsWith('create:1.20.1:forge:')), calls.join(', '));
  assert.ok(afterSrv.container_id);
  const all = db.prepare('SELECT * FROM server_profiles WHERE server_id = ?').all(serverId);
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].id, p.id);
});

test('saveCurrentAs refusé si le serveur tourne (409)', async () => {
  const srv = reset({ status: 'running' });
  await assert.rejects(() => profiles.saveCurrentAs(srv, 'Test'), err => err.status === 409);
});

test('routes API : liste, création, renommage, suppression du profil actif refusée, verrou 409 et nom vide 400', async () => {
  reset({ status: 'stopped', activeProfileName: 'Actif' });

  // Nom vide ou trop long -> 400
  const badEmpty = await apiReq('POST', '/profiles', { name: '   ' });
  assert.strictEqual(badEmpty.status, 400);
  const badLong = await apiReq('POST', '/profiles', { name: 'a'.repeat(49) });
  assert.strictEqual(badLong.status, 400);

  // Sauvegarde du profil actuel -> 201
  const created = await apiReq('POST', '/profiles', { name: 'Mon Profil' });
  assert.strictEqual(created.status, 201);
  assert.strictEqual(created.data.name, 'Mon Profil');
  assert.ok(typeof created.data.size_bytes === 'number' && created.data.size_bytes > 0);

  // Liste -> profil actif + liste avec taille disque
  const list = await apiReq('GET', '/profiles');
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.data.active.name, 'Actif');
  assert.ok(list.data.active.size_bytes > 0);
  assert.strictEqual(list.data.profiles.length, 1);

  // Renommer -> 200 (et nom vide -> 400)
  const badRename = await apiReq('PATCH', `/profiles/${created.data.id}`, { name: '' });
  assert.strictEqual(badRename.status, 400);
  const renamed = await apiReq('PATCH', `/profiles/${created.data.id}`, { name: 'Profil Renommé' });
  assert.strictEqual(renamed.status, 200);
  assert.strictEqual(renamed.data.name, 'Profil Renommé');

  // Suppression du profil actif refusée
  const delActive = await apiReq('DELETE', '/profiles/active');
  assert.strictEqual(delActive.status, 400);

  // Serveur occupé (verrou) -> 409
  const release = serverLock.acquire(serverId, 'sauvegarde');
  try {
    const locked = await apiReq('POST', `/profiles/${created.data.id}/activate`);
    assert.strictEqual(locked.status, 409);
    const lockedDel = await apiReq('DELETE', `/profiles/${created.data.id}`);
    assert.strictEqual(lockedDel.status, 409);
  } finally {
    release();
  }

  // Suppression d'un profil inactif -> 200 + dossier supprimé
  const delOk = await apiReq('DELETE', `/profiles/${created.data.id}`);
  assert.strictEqual(delOk.status, 200);
  assert.ok(!fs.existsSync(path.join(profilesDir, created.data.id)));
});

test('newFromModpack : archive l\'actuel, crée un server/ vide sans copier le monde et lance l\'installation', async () => {
  reset({ status: 'running', activeProfileName: 'Ancien Pack' });

  const res = await apiReq('POST', '/profiles/new', {
    name: 'Nouveau Pack',
    modpack_id: 'atm10',
    modpack_name: 'All the Mods 10',
    modpack_source: 'curseforge',
    modpack_version: '2.1',
    modpack_version_id: '999',
    mc_version: '1.21.1',
    loader_type: 'neoforge',
  });

  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.data.status, 'installing');
  assert.strictEqual(res.data.active_profile_name, 'Nouveau Pack');
  assert.strictEqual(res.data.modpack_id, 'atm10');
  assert.strictEqual(res.data.loader_type, 'neoforge');

  // Le monde de l'ancien profil n'a PAS été copié dans server/
  assert.ok(fs.existsSync(serverDir));
  assert.ok(!fs.existsSync(path.join(serverDir, 'world', 'level.dat')));

  // L'ancien profil est archivé avec son monde
  const list = db.prepare('SELECT * FROM server_profiles WHERE server_id = ?').all(serverId);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, 'Ancien Pack');
  assert.strictEqual(fs.readFileSync(path.join(profilesDir, list[0].id, 'world', 'level.dat'), 'utf8'), 'MONDE-ACTUEL');

  // installer.installServer a bien été appelé
  assert.strictEqual(installCalls.length, 1);
  assert.strictEqual(installCalls[0].modpack_id, 'atm10');
});

test('extension decorate : ajoute active_profile_name à la représentation serveur', () => {
  const ext = require(src('services/extensions/profiles'));
  assert.deepStrictEqual(ext.decorate({ active_profile_name: 'Mon Profil' }), { active_profile_name: 'Mon Profil' });
  assert.deepStrictEqual(ext.decorate({}), { active_profile_name: null });
});

test('newFromModpack : entrées invalides → 400 sans toucher aux dossiers ni au container', async () => {
  reset({ status: 'stopped' });
  const bad = [
    { name: 'X', modpack_id: 'p', modpack_source: 'inconnue', loader_type: 'forge' },
    { name: 'X', modpack_id: 'p', modpack_source: 'curseforge', loader_type: 'FORGE\nX=1' },
    { name: '', modpack_id: 'p', modpack_source: 'curseforge', loader_type: 'forge' },
  ];
  for (const body of bad) {
    const res = await apiReq('POST', '/profiles/new', body);
    assert.strictEqual(res.status, 400, JSON.stringify(body));
  }
  assert.strictEqual(fs.readFileSync(path.join(serverDir, 'world', 'level.dat'), 'utf8'), 'MONDE-ACTUEL');
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(installCalls.length, 0);
});
