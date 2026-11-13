const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempDataPath, src } = require('./helpers');

const DATA = useTempDataPath();

// Simulation de modrinthInstall avant tout chargement des routes/extensions
const installCalls = [];
const removeCalls = [];
const modrinthPath = require.resolve(src('services/modrinthInstall'));
const originalModrinth = require.cache[modrinthPath];
const PLUGIN_LOADERS = new Set(['paper', 'purpur', 'spigot', 'bukkit', 'folia']);

function fakeDir(server) {
  const loader = (server.loader_type || '').toLowerCase();
  const sub = PLUGIN_LOADERS.has(loader) ? 'plugins' : 'mods';
  return path.join(DATA, 'servers', server.id, 'server', sub);
}

require.cache[modrinthPath] = {
  id: modrinthPath,
  filename: modrinthPath,
  loaded: true,
  exports: {
    ensureProject: async (server, slug) => {
      installCalls.push({ serverId: server.id, slug });
      const dir = fakeDir(server);
      fs.mkdirSync(dir, { recursive: true });
      const filename = `${slug}-1.0.0.jar`;
      fs.writeFileSync(path.join(dir, filename), 'jar');
      return { installed: true, file: filename, dir: path.basename(dir), version: '1.0.0' };
    },
    removeProject: (server, slug) => {
      removeCalls.push({ serverId: server.id, slug });
      const dir = fakeDir(server);
      const filename = `${slug}-1.0.0.jar`;
      const full = path.join(dir, filename);
      if (fs.existsSync(full)) {
        fs.rmSync(full, { force: true });
        return filename;
      }
      return null;
    },
  },
};

const { initDb, getDb } = require(src('config/database'));
const extensions = require(src('services/extensions'));
const serverLock = require(src('services/serverLock'));

let db, appServer, baseUrl, token;

const IDS = {
  fabric1: '11111111-1111-1111-1111-111111111111',
  fabric2: '22222222-2222-2222-2222-222222222222',
  neoforge: '33333333-3333-3333-3333-333333333333',
  paper: '44444444-4444-4444-4444-444444444444',
  forge: '55555555-5555-5555-5555-555555555555',
  quilt: '66666666-6666-6666-6666-666666666666',
  vanilla: '77777777-7777-7777-7777-777777777777',
};

function insertServer(id, loader, port) {
  db.prepare(`
    INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, port, rcon_port, rcon_password, ram_mb, max_players, status, mc_version, loader_type)
    VALUES (?, ?, 'pack', 'Pack', 'modrinth', ?, ?, 'secret', 4096, 20, 'stopped', '1.21.1', ?)
  `).run(id, `Srv-${loader}`, port, port + 100, loader);
}

async function req(method, urlPath, body, withAuth = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (withAuth) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

before(async () => {
  initDb();
  extensions._reset();
  db = getDb();

  insertServer(IDS.fabric1, 'fabric', 25565);
  insertServer(IDS.fabric2, 'fabric', 25566);
  insertServer(IDS.neoforge, 'neoforge', 25567);
  insertServer(IDS.paper, 'paper', 25568);
  insertServer(IDS.forge, 'forge', 25569);
  insertServer(IDS.quilt, 'quilt', 25570);
  insertServer(IDS.vanilla, 'vanilla', 25571);

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((rq, rs, next) => { if (rq.body === undefined) rq.body = {}; next(); });
  // Montage identique à src/index.js : routes cœur avant routes/features/*
  app.use('/api/servers', require(src('routes/servers')));
  const geyserFeature = require(src('routes/features/geyser'));
  app.use(geyserFeature.mount, geyserFeature.router);
  app.use(require(src('middleware/errorHandler')));

  appServer = app.listen(0);
  baseUrl = `http://127.0.0.1:${appServer.address().port}/api/servers`;

  const { getJwtSecret, loadOrCreateSecrets } = require(src('config/secrets'));
  loadOrCreateSecrets();
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES ('u1', 'admin', 'x')").run();
  token = require('jsonwebtoken').sign({ id: 'u1', username: 'admin' }, getJwtSecret(), { expiresIn: '5m' });
});

after(() => {
  appServer?.close();
  if (originalModrinth) require.cache[modrinthPath] = originalModrinth;
  else delete require.cache[modrinthPath];
});

test('authentification requise sur les routes Geyser', async () => {
  const r = await req('GET', `/${IDS.fabric1}/geyser`, undefined, false);
  assert.strictEqual(r.status, 401);
});

test('Fabric : installation geyser + floodgate, config.yml et binding UDP 19132 puis 19133', async () => {
  const beforeStatus = await req('GET', `/${IDS.fabric1}/geyser`);
  assert.strictEqual(beforeStatus.status, 200);
  assert.deepStrictEqual(beforeStatus.data, {
    enabled: false,
    port: null,
    floodgate: true,
    supported: true,
    reason: null,
  });

  installCalls.length = 0;
  const en1 = await req('POST', `/${IDS.fabric1}/geyser/enable`, { floodgate: true });
  assert.strictEqual(en1.status, 200);
  assert.strictEqual(en1.data.enabled, true);
  assert.strictEqual(en1.data.port, 19132);
  assert.strictEqual(en1.data.floodgate, true);
  assert.strictEqual(en1.data.needs_recreate, true);

  assert.deepStrictEqual(
    installCalls.map(c => `${c.serverId}:${c.slug}`),
    [`${IDS.fabric1}:geyser`, `${IDS.fabric1}:floodgate`],
  );

  const cfg1 = fs.readFileSync(path.join(DATA, 'servers', IDS.fabric1, 'server', 'config', 'Geyser-Fabric', 'config.yml'), 'utf8');
  assert.match(cfg1, /^bedrock:\s*\n\s+port: 19132/m);
  assert.match(cfg1, /^remote:\s*\n\s+auth-type: floodgate/m);

  const row1 = db.prepare('SELECT * FROM servers WHERE id = ?').get(IDS.fabric1);
  const ports1 = extensions.ports(row1, {});
  assert.deepStrictEqual(ports1.exposed['19132/udp'], {});
  assert.deepStrictEqual(ports1.bindings['19132/udp'], [{ HostPort: '19132' }]);

  // Vérification de la décoration via GET /:id (uniquement les champs geyser)
  const detail1 = await req('GET', `/${IDS.fabric1}`);
  assert.strictEqual(detail1.status, 200);
  assert.strictEqual(detail1.data.geyser_enabled, true);
  assert.strictEqual(detail1.data.geyser_port, 19132);
  assert.strictEqual(detail1.data.geyser_floodgate, true);

  // Second serveur Fabric sans Floodgate → port 19133 et auth-type: online
  installCalls.length = 0;
  const en2 = await req('POST', `/${IDS.fabric2}/geyser/enable`, { floodgate: false });
  assert.strictEqual(en2.status, 200);
  assert.strictEqual(en2.data.port, 19133);
  assert.strictEqual(en2.data.floodgate, false);
  assert.deepStrictEqual(installCalls.map(c => c.slug), ['geyser']);

  const cfg2 = fs.readFileSync(path.join(DATA, 'servers', IDS.fabric2, 'server', 'config', 'Geyser-Fabric', 'config.yml'), 'utf8');
  assert.match(cfg2, /^bedrock:\s*\n\s+port: 19132/m);
  assert.match(cfg2, /^remote:\s*\n\s+auth-type: online/m);

  const row2 = db.prepare('SELECT * FROM servers WHERE id = ?').get(IDS.fabric2);
  const ports2 = extensions.ports(row2, {});
  assert.deepStrictEqual(ports2.bindings['19132/udp'], [{ HostPort: '19133' }]);
});

test('NeoForge : édition YAML ciblée en préservant commentaires et autres clés', async () => {
  const cfgPath = path.join(DATA, 'servers', IDS.neoforge, 'server', 'config', 'Geyser-NeoForge', 'config.yml');
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, [
    '# Configuration existante',
    'bedrock:',
    '  address: 0.0.0.0',
    '  port: 25565',
    '  motd1: "Mon serveur"',
    'remote:',
    '  address: auto',
    '  port: 25565',
    '  auth-type: offline',
    '',
  ].join('\n'));

  const res = await req('POST', `/${IDS.neoforge}/geyser/enable`, { floodgate: true });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.port, 19134);

  const updated = fs.readFileSync(cfgPath, 'utf8');
  assert.match(updated, /# Configuration existante/);
  assert.match(updated, /motd1: "Mon serveur"/);
  assert.match(updated, /^bedrock:\n  address: 0\.0\.0\.0\n  port: 19132\n  motd1: "Mon serveur"/m);
  assert.match(updated, /^remote:\n  address: auto\n  port: 25565\n  auth-type: floodgate/m);
});

test('Paper : chemin plugins/Geyser-Spigot/config.yml', async () => {
  const res = await req('POST', `/${IDS.paper}/geyser/enable`, { floodgate: true });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.port, 19135);

  const cfgPath = path.join(DATA, 'servers', IDS.paper, 'server', 'plugins', 'Geyser-Spigot', 'config.yml');
  assert.ok(fs.existsSync(cfgPath));
  const content = fs.readFileSync(cfgPath, 'utf8');
  assert.match(content, /port: 19132/);
  assert.match(content, /auth-type: floodgate/);
});

test('Loaders non supportés (Forge, Quilt, Vanilla) → 400 à l\'activation et supported=false sur GET', async () => {
  for (const id of [IDS.forge, IDS.quilt, IDS.vanilla]) {
    const statusRes = await req('GET', `/${id}/geyser`);
    assert.strictEqual(statusRes.status, 200);
    assert.strictEqual(statusRes.data.supported, false);
    assert.ok(typeof statusRes.data.reason === 'string' && statusRes.data.reason.length > 0);

    const enableRes = await req('POST', `/${id}/geyser/enable`, { floodgate: true });
    assert.strictEqual(enableRes.status, 400);
    assert.ok(enableRes.data?.error);
  }
});

test('Désactivation : jars retirés, champs remis à zéro et binding UDP absent', async () => {
  removeCalls.length = 0;
  const dis = await req('POST', `/${IDS.fabric1}/geyser/disable`);
  assert.strictEqual(dis.status, 200);
  assert.strictEqual(dis.data.enabled, false);
  assert.strictEqual(dis.data.port, null);

  assert.deepStrictEqual(
    removeCalls.filter(c => c.serverId === IDS.fabric1).map(c => c.slug),
    ['geyser', 'floodgate'],
  );
  const modsDir = path.join(DATA, 'servers', IDS.fabric1, 'server', 'mods');
  assert.ok(!fs.existsSync(path.join(modsDir, 'geyser-1.0.0.jar')));
  assert.ok(!fs.existsSync(path.join(modsDir, 'floodgate-1.0.0.jar')));

  const rowAfter = db.prepare('SELECT * FROM servers WHERE id = ?').get(IDS.fabric1);
  assert.strictEqual(rowAfter.geyser_enabled, 0);
  assert.strictEqual(rowAfter.geyser_port, null);

  const portsAfter = extensions.ports(rowAfter, {});
  assert.strictEqual(portsAfter.exposed['19132/udp'], undefined);
  assert.strictEqual(portsAfter.bindings['19132/udp'], undefined);

  // Le port 19132 libéré peut être réattribué
  const reenable = await req('POST', `/${IDS.fabric1}/geyser/enable`, { floodgate: true });
  assert.strictEqual(reenable.status, 200);
  assert.strictEqual(reenable.data.port, 19132);
});

test('Conflit de verrou serveur → 409', async () => {
  const release = serverLock.acquire(IDS.fabric1, 'test');
  try {
    const res = await req('POST', `/${IDS.fabric1}/geyser/enable`, { floodgate: true });
    assert.strictEqual(res.status, 409);
  } finally {
    release();
  }
});
