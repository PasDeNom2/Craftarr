// Mise à jour de modpack : succès, échec d'installation, échec après bascule (Docker/installeur simulés).
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempDataPath, src } = require('./helpers');

const DATA = useTempDataPath();
const calls = [];
let installBehavior = 'ok';
let createFailOnce = false;
const mock = (rel, exports) => { const p = require.resolve(src(rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
mock('services/docker.js', {
  stopContainer: async (id) => calls.push(`stop ${id}`),
  removeContainer: async (id) => calls.push(`remove ${id}`),
  createServerContainer: async () => {
    if (createFailOnce) { createFailOnce = false; throw new Error('docker create KO'); }
    calls.push('create');
    return { containerId: 'new-ctr', containerName: 'mc-test' };
  },
  startContainer: async (id) => calls.push(`start ${id}`),
});
mock('services/backup.js', {
  createBackup: async () => ({ id: 'bk1', filename: 'bk.zip', path: '/nope' }),
  cleanOldBackups: async () => {},
  getWorldDirs: () => ['world', 'world_nether', 'world_the_end'],
});
mock('services/installer.js', {
  freshInstallModpack: async (server, dir) => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'mods', 'new-mod.jar'), 'v2');
    if (installBehavior === 'fail') throw new Error('téléchargement KO');
  },
});

const { initDb, getDb } = require(src('config/database'));
let db, updater;
const id = 'aaaaaaaa-0000-0000-0000-000000000000';
const serverDir = path.join(DATA, 'servers', id, 'server');
const info = { latestVersionId: '200', latestVersion: 'v2', changelog: '' };

before(() => { initDb(); db = getDb(); updater = require(src('services/updater')); });

function reset() {
  fs.rmSync(path.join(DATA, 'servers', id), { recursive: true, force: true });
  fs.mkdirSync(path.join(serverDir, 'world'), { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'world', 'level.dat'), 'MON-MONDE');
  fs.mkdirSync(path.join(serverDir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'mods', 'old-mod.jar'), 'v1');
  fs.writeFileSync(path.join(serverDir, 'ops.json'), '["moi"]');
  db.prepare('DELETE FROM servers').run();
  db.prepare(`INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, modpack_version, modpack_version_id,
    port, rcon_port, rcon_password, ram_mb, max_players, status, mc_version, loader_type, container_id)
    VALUES (?, 'T', '1', 'T', 'curseforge', 'v1', '100', 25565, 25575, 'x', 4096, 10, 'running', '1.21.1', 'neoforge', 'old-ctr')`).run(id);
  calls.length = 0;
  return db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
}
const row = () => db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
const read = (rel) => fs.readFileSync(path.join(serverDir, rel), 'utf8');
const noLeftovers = () => ['server.staging', 'server.old'].every(d => !fs.existsSync(path.join(DATA, 'servers', id, d)));
const lastHistory = () => db.prepare('SELECT status FROM update_history ORDER BY rowid DESC LIMIT 1').get().status;

test('succès : nouveaux mods, monde et ops conservés', async () => {
  installBehavior = 'ok';
  await updater.applyUpdate(reset(), info);
  assert.strictEqual(read('world/level.dat'), 'MON-MONDE');
  assert.strictEqual(read('ops.json'), '["moi"]');
  assert.strictEqual(read('mods/new-mod.jar'), 'v2');
  assert.ok(!fs.existsSync(path.join(serverDir, 'mods/old-mod.jar')));
  assert.strictEqual(row().modpack_version, 'v2');
  assert.strictEqual(lastHistory(), 'success');
  assert.ok(noLeftovers());
});

test('échec pendant l\'installation : ancienne version restaurée et relancée', async () => {
  installBehavior = 'fail';
  await updater.applyUpdate(reset(), info);
  assert.strictEqual(read('mods/old-mod.jar'), 'v1');
  assert.strictEqual(read('world/level.dat'), 'MON-MONDE');
  assert.strictEqual(row().modpack_version, 'v1');
  assert.strictEqual(row().status, 'starting');
  assert.ok(calls.includes('create') && calls.includes('start new-ctr'));
  assert.strictEqual(lastHistory(), 'failed');
  assert.ok(noLeftovers());
});

test('échec après la bascule : ancien dossier remis en place', async () => {
  installBehavior = 'ok';
  createFailOnce = true;
  await updater.applyUpdate(reset(), info);
  assert.strictEqual(read('mods/old-mod.jar'), 'v1');
  assert.ok(!fs.existsSync(path.join(serverDir, 'mods/new-mod.jar')));
  assert.strictEqual(read('world/level.dat'), 'MON-MONDE');
  assert.strictEqual(row().modpack_version, 'v1');
  assert.ok(noLeftovers());
});

test('reprise : mise à jour coupée après la bascule → ancienne installation et versions restaurées', () => {
  reset();
  const base = path.join(DATA, 'servers', id);
  // Simule un crash du backend entre la bascule et la reprise des données
  fs.renameSync(serverDir, path.join(base, 'server.old'));
  fs.mkdirSync(path.join(serverDir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'mods', 'new-mod.jar'), 'v2');
  db.prepare("UPDATE servers SET status = 'updating', modpack_version = 'v2', modpack_version_id = '200', mc_version = '1.21.4' WHERE id = ?").run(id);
  fs.writeFileSync(path.join(base, '.update-state.json'), JSON.stringify({
    phase: 'installing',
    previous: { modpack_version_id: '100', modpack_version: 'v1', mc_version: '1.21.1', loader_type: 'neoforge' },
  }));

  assert.deepStrictEqual(updater.recoverInterruptedUpdates(), [id]);
  assert.strictEqual(read('world/level.dat'), 'MON-MONDE');
  assert.ok(fs.existsSync(path.join(serverDir, 'mods', 'old-mod.jar')));
  assert.ok(!fs.existsSync(path.join(base, 'server.old')) && !fs.existsSync(path.join(base, '.update-state.json')));
  assert.strictEqual(row().modpack_version, 'v1');
  assert.strictEqual(row().mc_version, '1.21.1');
  assert.strictEqual(row().status, 'stopped');
});

test('reprise : mise à jour déjà terminée (phase done) → simple nettoyage, rien d\'annulé', () => {
  reset();
  const base = path.join(DATA, 'servers', id);
  fs.mkdirSync(path.join(base, 'server.old'));
  fs.writeFileSync(path.join(base, '.update-state.json'), JSON.stringify({ phase: 'done', previous: { modpack_version: 'v0' } }));
  assert.deepStrictEqual(updater.recoverInterruptedUpdates(), []);
  assert.ok(!fs.existsSync(path.join(base, 'server.old')));
  assert.strictEqual(row().modpack_version, 'v1');
});

test('verrou : une seconde opération sur le même serveur est refusée (409)', async () => {
  const lock = require(src('services/serverLock'));
  const release = lock.acquire(id, 'mise à jour');
  assert.throws(() => lock.acquire(id, 'démarrage'), e => e.status === 409);
  assert.match(lock.busyReason({ id, status: 'running' }), /mise à jour/);
  release();
  assert.strictEqual(lock.busyReason({ id, status: 'running' }), null);
  assert.match(lock.busyReason({ id, status: 'installing' }), /installation/);
  await assert.rejects(updater.applyUpdate(reset(), info).then(() => lock.withLock(id, 'x', async () => { lock.acquire(id, 'y'); })), e => e.status === 409);
});

test('coupe-circuit : 3 redémarrages en 10 min = boucle', () => {
  const { isLooping } = require(src('services/crashGuard'))._internals;
  const now = Date.now();
  assert.strictEqual(isLooping([{ count: 0, at: now - 120000 }, { count: 1, at: now }], now), false);
  assert.strictEqual(isLooping([{ count: 2, at: now - 300000 }, { count: 5, at: now }], now), true);
  assert.strictEqual(isLooping([{ count: 0, at: now - 900000 }, { count: 9, at: now - 700000 }, { count: 9, at: now }], now), false);
});
