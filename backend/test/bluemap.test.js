// Tests BlueMap : activation, attribution de port, config HOCON, vanilla 400, désactivation (ensureProject simulé).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempDataPath, src } = require('./helpers');

const DATA = useTempDataPath();

// Simulation de modrinthInstall.ensureProject (pas d'appel réseau Modrinth)
const realModrinth = require(src('services/modrinthInstall'));
const mockPath = require.resolve(src('services/modrinthInstall'));
const ensureCalls = [];
require.cache[mockPath] = {
  id: mockPath,
  filename: mockPath,
  loaded: true,
  exports: {
    ...realModrinth,
    ensureProject: async (server, slug) => {
      ensureCalls.push({ id: server.id, slug });
      const target = realModrinth.targetFor(server);
      if (target.error) throw Object.assign(new Error(target.error), { status: 400 });
      const dir = path.join(realModrinth.serverDirOf(server), target.dir);
      fs.mkdirSync(dir, { recursive: true });
      const filename = `${slug}-5.4.jar`;
      fs.writeFileSync(path.join(dir, filename), 'fake-jar');
      return { installed: true, file: filename, dir: target.dir, version: '5.4' };
    },
  },
};

const { initDb, getDb } = require(src('config/database'));
const extensions = require(src('services/extensions'));
const bluemapExt = require(src('services/extensions/bluemap'));

const srvFabric = 'bbbbbbbb-1111-0000-0000-000000000001';
const srvPaper = 'bbbbbbbb-2222-0000-0000-000000000002';
const srvVanilla = 'bbbbbbbb-3333-0000-0000-000000000003';
const srvCollision = 'bbbbbbbb-4444-0000-0000-000000000004';

let db, server, base, token;

function insertServer(id, name, port, loaderType) {
  db.prepare(`INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, port, rcon_port, rcon_password, ram_mb, max_players, status, mc_version, loader_type)
    VALUES (?, ?, '1', ?, 'modrinth', ?, ?, 'secret', 4096, 20, 'stopped', '1.21.1', ?)`).run(id, name, name, port, port + 10, loaderType);
}

before(() => {
  initDb();
  db = getDb();
  extensions._reset();

  insertServer(srvFabric, 'Fabric', 25565, 'fabric');
  insertServer(srvPaper, 'Paper', 25566, 'paper');
  insertServer(srvVanilla, 'Vanilla', 25567, 'vanilla');
  insertServer(srvCollision, 'GamePort8102', 8102, 'neoforge');

  const express = require('express');
  const app = express();
  app.use(express.json());
  const mod = require(src('routes/features/bluemap'));
  app.use(mod.mount, mod.router);
  app.use(require(src('middleware/errorHandler')));
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/servers`;

  const { getJwtSecret, loadOrCreateSecrets } = require(src('config/secrets'));
  loadOrCreateSecrets?.();
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES ('u1', 'admin', 'x')").run();
  token = require('jsonwebtoken').sign({ id: 'u1', username: 'admin' }, getJwtSecret(), { expiresIn: '5m' });
});

after(() => server?.close());

async function req(method, urlPath) {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, data: await res.json() };
}

test('activation sur Fabric : port 8100 attribué, config HOCON et ports()', async () => {
  const { status, data } = await req('POST', `/${srvFabric}/bluemap/enable`);
  assert.strictEqual(status, 200);
  assert.strictEqual(data.enabled, true);
  assert.strictEqual(data.port, 8100);
  assert.strictEqual(data.installed, true);
  assert.strictEqual(data.needs_recreate, true);
  assert.ok(ensureCalls.some(c => c.id === srvFabric && c.slug === 'bluemap'));

  const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(srvFabric);
  assert.strictEqual(row.bluemap_enabled, 1);
  assert.strictEqual(row.bluemap_port, 8100);
  assert.strictEqual(row.needs_recreate, 1);

  const cfgDir = path.join(DATA, 'servers', srvFabric, 'server', 'config', 'bluemap');
  const coreConf = fs.readFileSync(path.join(cfgDir, 'core.conf'), 'utf8');
  const webConf = fs.readFileSync(path.join(cfgDir, 'webserver.conf'), 'utf8');
  assert.match(coreConf, /^accept-download:\s*true$/m);
  assert.match(webConf, /^port:\s*8100$/m);

  const p = bluemapExt.ports(row);
  assert.deepStrictEqual(p.exposed, { '8100/tcp': {} });
  assert.deepStrictEqual(p.bindings, { '8100/tcp': [{ HostPort: '8100' }] });

  const extPorts = extensions.ports(row, {});
  assert.deepStrictEqual(extPorts.bindings['8100/tcp'], [{ HostPort: '8100' }]);
  assert.deepStrictEqual(bluemapExt.decorate(row), { bluemap_enabled: true, bluemap_port: 8100 });
});

test('activation sur second serveur (Paper) : port 8101, dossier plugins/BlueMap et config existante préservée', async () => {
  const cfgDir = path.join(DATA, 'servers', srvPaper, 'server', 'plugins', 'BlueMap');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'core.conf'), '# config BlueMap\nrender-threads: 4\naccept-download: false\n', 'utf8');
  fs.writeFileSync(path.join(cfgDir, 'webserver.conf'), 'enabled: true\nport: 9999\n', 'utf8');

  const { status, data } = await req('POST', `/${srvPaper}/bluemap/enable`);
  assert.strictEqual(status, 200);
  assert.strictEqual(data.port, 8101);

  const coreConf = fs.readFileSync(path.join(cfgDir, 'core.conf'), 'utf8');
  const webConf = fs.readFileSync(path.join(cfgDir, 'webserver.conf'), 'utf8');
  assert.match(coreConf, /^render-threads:\s*4$/m);
  assert.match(coreConf, /^accept-download:\s*true$/m);
  assert.match(webConf, /^enabled:\s*true$/m);
  assert.match(webConf, /^port:\s*8100$/m);
});

test('attribution de port : évite les ports de jeu existants (8102 pris → 8103)', async () => {
  const { status, data } = await req('POST', `/${srvCollision}/bluemap/enable`);
  assert.strictEqual(status, 200);
  assert.strictEqual(data.port, 8103);
});

test('serveur vanilla → 400 avec message', async () => {
  const { status, data } = await req('POST', `/${srvVanilla}/bluemap/enable`);
  assert.strictEqual(status, 400);
  assert.ok(data.error);
});

test('GET /bluemap et désactivation → jar supprimé et binding absent', async () => {
  const beforeGet = await req('GET', `/${srvFabric}/bluemap`);
  assert.strictEqual(beforeGet.status, 200);
  assert.deepStrictEqual(beforeGet.data, { enabled: true, port: 8100, installed: true });

  const { status, data } = await req('POST', `/${srvFabric}/bluemap/disable`);
  assert.strictEqual(status, 200);
  assert.strictEqual(data.enabled, false);
  assert.strictEqual(data.installed, false);
  assert.strictEqual(data.needs_recreate, true);

  const jarPath = path.join(DATA, 'servers', srvFabric, 'server', 'mods', 'bluemap-5.4.jar');
  assert.strictEqual(fs.existsSync(jarPath), false);

  const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(srvFabric);
  assert.strictEqual(row.bluemap_enabled, 0);
  assert.deepStrictEqual(bluemapExt.ports(row), { exposed: {}, bindings: {} });
  assert.deepStrictEqual(extensions.ports(row, {}).bindings, {});

  const afterGet = await req('GET', `/${srvFabric}/bluemap`);
  assert.strictEqual(afterGet.status, 200);
  assert.strictEqual(afterGet.data.enabled, false);
  assert.strictEqual(afterGet.data.installed, false);
});
