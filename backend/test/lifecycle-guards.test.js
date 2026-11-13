// Tests ciblés des gardes du cycle de vie : icône PNG, recréation sûre, verrous DELETE / world-import, install-mods.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { useTempDataPath, src } = require('./helpers');

const DATA = useTempDataPath();
const { initDb, getDb } = require(src('config/database'));
const serverLock = require(src('services/serverLock'));
const dockerService = require(src('services/docker'));
const installer = require(src('services/installer'));

// Stub Docker AVANT de monter les routes : aucun démon Docker requis
function resetDockerStubs() {
  dockerService.removeContainer = async () => {};
  dockerService.removeContainerAndImage = async () => {};
  dockerService.stopContainer = async () => {};
  dockerService.startContainer = async () => {};
  dockerService.restartContainer = async () => {};
  dockerService.createServerContainer = async (srv) => ({
    containerId: `new-cid-${srv.id.slice(0, 8)}`,
    containerName: `mc-${srv.id.slice(0, 8)}`,
  });
  dockerService.streamContainerLogs = () => () => {};
}
resetDockerStubs();

let db, httpServer, base, token;
let nextPort = 26000;

function insertServer(id, overrides = {}) {
  const port = overrides.port ?? nextPort++;
  const defaults = {
    name: 'TestSrv',
    modpack_id: '1',
    modpack_name: 'TestPack',
    modpack_source: 'curseforge',
    container_id: 'old-cid',
    container_name: 'mc-old',
    port,
    rcon_port: port + 10,
    rcon_password: 'secret',
    ram_mb: 4096,
    max_players: 20,
    status: 'stopped',
    loader_type: 'neoforge',
    needs_recreate: 0,
  };
  const s = { ...defaults, ...overrides };
  db.prepare(`
    INSERT INTO servers (
      id, name, modpack_id, modpack_name, modpack_source,
      container_id, container_name, port, rcon_port, rcon_password,
      ram_mb, max_players, status, loader_type, needs_recreate
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, s.name, s.modpack_id, s.modpack_name, s.modpack_source,
    s.container_id, s.container_name, s.port, s.rcon_port, s.rcon_password,
    s.ram_mb, s.max_players, s.status, s.loader_type, s.needs_recreate
  );
  return db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
}

before(async () => {
  initDb();
  db = getDb();

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/servers', require(src('routes/servers/lifecycle')));
  app.use('/api/servers', require(src('routes/servers/world')));
  app.use(require(src('middleware/errorHandler')));

  httpServer = app.listen(0);
  base = `http://127.0.0.1:${httpServer.address().port}/api/servers`;

  const { getJwtSecret, loadOrCreateSecrets } = require(src('config/secrets'));
  loadOrCreateSecrets();
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES ('u1', 'admin', 'x')").run();
  token = require('jsonwebtoken').sign({ id: 'u1', username: 'admin' }, getJwtSecret(), { expiresIn: '5m' });
});

after(() => httpServer?.close());

test('POST /:id/icon : accepte image/png et écrit server-icon.png, refuse text/plain en 400', async () => {
  const id = '11111111-1111-1111-1111-111111111111';
  insertServer(id);

  // PNG minimal (signature PNG)
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const goodFd = new FormData();
  goodFd.append('icon', new Blob([pngBytes], { type: 'image/png' }), 'icon.png');
  const okRes = await fetch(`${base}/${id}/icon`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: goodFd,
  });
  assert.strictEqual(okRes.status, 200);
  const writtenPath = path.join(DATA, 'servers', id, 'server', 'server-icon.png');
  assert.ok(fs.existsSync(writtenPath));
  assert.deepStrictEqual(fs.readFileSync(writtenPath), pngBytes);

  // Fichier non-PNG refusé avec 400
  const badFd = new FormData();
  badFd.append('icon', new Blob(['pas une image'], { type: 'text/plain' }), 'notes.txt');
  const badRes = await fetch(`${base}/${id}/icon`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: badFd,
  });
  assert.strictEqual(badRes.status, 400);
});

test('POST /:id/start avec needs_recreate = 1 et createServerContainer qui échoue → 500, container_id NULL, status error', async () => {
  resetDockerStubs();
  const id = '22222222-2222-2222-2222-222222222222';
  insertServer(id, { needs_recreate: 1, container_id: 'stale-cid', container_name: 'mc-stale' });

  let removed = null;
  dockerService.removeContainer = async (cid) => { removed = cid; };
  dockerService.createServerContainer = async () => { throw new Error('KO'); };

  const res = await fetch(`${base}/${id}/start`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.strictEqual(res.status, 500);
  assert.strictEqual(removed, 'stale-cid');

  const row = db.prepare('SELECT container_id, container_name, status FROM servers WHERE id = ?').get(id);
  assert.strictEqual(row.container_id, null);
  assert.strictEqual(row.container_name, null);
  assert.strictEqual(row.status, 'error');
});

test('POST /:id/restart avec needs_recreate = 1 et createServerContainer qui échoue → 500, container_id NULL, status error', async () => {
  resetDockerStubs();
  const id = '22222222-3333-3333-3333-333333333333';
  insertServer(id, { needs_recreate: 1, container_id: 'stale-cid-2', container_name: 'mc-stale-2' });

  dockerService.createServerContainer = async () => { throw new Error('KO restart'); };

  const res = await fetch(`${base}/${id}/restart`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.strictEqual(res.status, 500);

  const row = db.prepare('SELECT container_id, container_name, status FROM servers WHERE id = ?').get(id);
  assert.strictEqual(row.container_id, null);
  assert.strictEqual(row.container_name, null);
  assert.strictEqual(row.status, 'error');
});

test('POST /:id/start avec needs_recreate = 1 et succès → met à jour container_id, needs_recreate = 0, status starting', async () => {
  resetDockerStubs();
  const id = '22222222-4444-4444-4444-444444444444';
  insertServer(id, { needs_recreate: 1, container_id: 'old-cid-4', container_name: 'mc-old-4' });

  const res = await fetch(`${base}/${id}/start`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.strictEqual(res.status, 200);

  const row = db.prepare('SELECT container_id, container_name, needs_recreate, status FROM servers WHERE id = ?').get(id);
  assert.strictEqual(row.container_id, `new-cid-${id.slice(0, 8)}`);
  assert.strictEqual(row.container_name, `mc-${id.slice(0, 8)}`);
  assert.strictEqual(row.needs_recreate, 0);
  assert.strictEqual(row.status, 'starting');
});

test('DELETE /:id pendant qu\'un verrou est tenu → 409 et dossier conservé ; libre → 200 et supprimé', async () => {
  resetDockerStubs();
  const id = '33333333-3333-3333-3333-333333333333';
  insertServer(id);
  const srvDir = path.join(DATA, 'servers', id, 'server');
  fs.mkdirSync(srvDir, { recursive: true });
  fs.writeFileSync(path.join(srvDir, 'marker.txt'), 'keep');

  const release = serverLock.acquire(id, 'test');
  try {
    const lockedRes = await fetch(`${base}/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(lockedRes.status, 409);
    assert.ok(fs.existsSync(path.join(srvDir, 'marker.txt')));
    assert.ok(db.prepare('SELECT id FROM servers WHERE id = ?').get(id));
  } finally {
    release();
  }

  const okRes = await fetch(`${base}/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.strictEqual(okRes.status, 200);
  assert.ok(!fs.existsSync(path.join(DATA, 'servers', id)));
  assert.strictEqual(db.prepare('SELECT id FROM servers WHERE id = ?').get(id), undefined);
});

test('POST /:id/world-import sur un serveur status = installing ou verrouillé → 409 et upload nettoyé', async () => {
  const zip = new AdmZip();
  zip.addFile('world/level.dat', Buffer.from('DATA'));
  const zipBuf = zip.toBuffer();

  // Cas 1 : serveur en cours d'installation
  const idInstalling = '44444444-4444-4444-4444-444444444444';
  insertServer(idInstalling, { status: 'installing' });
  const fd1 = new FormData();
  fd1.append('world', new Blob([zipBuf], { type: 'application/zip' }), 'world.zip');
  const res1 = await fetch(`${base}/${idInstalling}/world-import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd1,
  });
  assert.strictEqual(res1.status, 409);
  assert.ok(!fs.existsSync(path.join(DATA, 'servers', idInstalling, 'uploads', 'world-import.zip')));

  // Cas 2 : verrou actif sur le serveur
  const idLocked = '44444444-5555-5555-5555-555555555555';
  insertServer(idLocked, { status: 'stopped' });
  const release = serverLock.acquire(idLocked, 'test-import');
  try {
    const fd2 = new FormData();
    fd2.append('world', new Blob([zipBuf], { type: 'application/zip' }), 'world.zip');
    const res2 = await fetch(`${base}/${idLocked}/world-import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: fd2,
    });
    assert.strictEqual(res2.status, 409);
    assert.ok(!fs.existsSync(path.join(DATA, 'servers', idLocked, 'uploads', 'world-import.zip')));
  } finally {
    release();
  }
});

test('POST /:id/install-mods : répond 200 et passe status = error si la tâche de fond échoue', async () => {
  resetDockerStubs();
  const id = '55555555-5555-5555-5555-555555555555';
  insertServer(id, { status: 'stopped' });

  const origInstallModsOnly = installer.installModsOnly;
  installer.installModsOnly = async () => {
    await new Promise(r => setTimeout(r, 15));
    throw new Error('échec téléchargement mods');
  };

  try {
    const res = await fetch(`${base}/${id}/install-mods`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);

    // Attendre que la tâche de fond mette le statut à 'error'
    const deadline = Date.now() + 1000;
    let status;
    while (Date.now() < deadline) {
      status = db.prepare('SELECT status FROM servers WHERE id = ?').get(id).status;
      if (status === 'error') break;
      await new Promise(r => setTimeout(r, 15));
    }
    assert.strictEqual(status, 'error');
  } finally {
    installer.installModsOnly = origInstallModsOnly;
  }
});
