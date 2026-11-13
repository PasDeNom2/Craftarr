const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { useTempDataPath, src } = require('./helpers');

useTempDataPath();

const { initDb, getDb } = require(src('config/database'));
const { loadOrCreateSecrets, signUserToken } = require(src('config/secrets'));
const appSettings = require(src('services/appSettings'));
const dockerService = require(src('services/docker'));
const extensions = require(src('services/extensions'));
const routerSleep = require(src('services/extensions/router-sleep'));
const errorHandler = require(src('middleware/errorHandler'));

const S1 = '11111111-1111-1111-1111-111111111111';
const S2 = '22222222-2222-2222-2222-222222222222';

let db;
let httpServer;
let baseUrl;
let token;
let mockContainers = [];
let lastCreateOpts = null;

// Sauvegarde des méthodes dockerode d'origine pour restauration en fin de suite
const origDockerMethods = {
  listNetworks: dockerService.docker.listNetworks,
  listContainers: dockerService.docker.listContainers,
  listImages: dockerService.docker.listImages,
  info: dockerService.docker.info,
  createContainer: dockerService.docker.createContainer,
  getContainer: dockerService.docker.getContainer,
};

function encodeDockerLogs(lines) {
  const payload = Buffer.from(lines.join('\n') + '\n', 'utf8');
  const header = Buffer.alloc(8);
  header[0] = 1; // stdout
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

let mockLogLines = [];

before(async () => {
  initDb();
  db = getDb();
  loadOrCreateSecrets();

  dockerService.docker.listNetworks = async () => [{ Name: 'craftarr' }];
  dockerService.docker.listContainers = async () => mockContainers;
  dockerService.docker.listImages = async () => [{ Id: 'img-mc' }];
  dockerService.docker.info = async () => ({ MemTotal: 16 * 1024 * 1024 * 1024 });
  dockerService.docker.createContainer = async (opts) => {
    lastCreateOpts = opts;
    return { id: 'created-ctr-1' };
  };
  dockerService.docker.getContainer = () => ({
    logs: (opts, cb) => cb(null, encodeDockerLogs(mockLogLines)),
    stop: async () => {},
    remove: async () => {},
  });

  db.prepare(`
    INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, port, rcon_port, rcon_password, ram_mb, max_players, status, loader_type)
    VALUES (?, 'Mon Serveur Élite !', 'vanilla-1.21.1', 'Vanilla', 'vanilla', 25565, 25575, 'pass1', 4096, 20, 'stopped', 'vanilla')
  `).run(S1);
  db.prepare(`
    INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, port, rcon_port, rcon_password, ram_mb, max_players, status, loader_type)
    VALUES (?, 'Second Server', 'vanilla-1.21.1', 'Vanilla', 'vanilla', 25566, 25576, 'pass2', 4096, 20, 'stopped', 'vanilla')
  `).run(S2);

  db.prepare("INSERT INTO users (id, username, password_hash) VALUES ('u1', 'admin', 'x')").run();
  token = signUserToken({ id: 'u1', username: 'admin', token_version: 0 });

  const app = express();
  app.use(express.json());
  const routerFeature = require(src('routes/features/router'));
  app.use(routerFeature.mount, routerFeature.router);
  app.use('/api/servers', require(src('routes/servers/lifecycle')));
  app.use(errorHandler);

  httpServer = app.listen(0);
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(() => {
  httpServer?.close();
  Object.assign(dockerService.docker, origDockerMethods);
});

async function apiReq(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

test('migration 50-router-sleep : colonnes, défauts et unicité partielle sur hostname', () => {
  const s1 = db.prepare('SELECT sleep_mode, sleep_after_minutes, hostname FROM servers WHERE id = ?').get(S1);
  assert.strictEqual(s1.sleep_mode, 'off');
  assert.strictEqual(s1.sleep_after_minutes, 10);
  assert.strictEqual(s1.hostname, null);

  // Plusieurs hostname NULL autorisés ; deux hostname identiques refusés
  db.prepare("UPDATE servers SET hostname = 'unique-one' WHERE id = ?").run(S1);
  assert.throws(() => {
    db.prepare("UPDATE servers SET hostname = 'unique-one' WHERE id = ?").run(S2);
  }, /UNIQUE constraint failed/);
  db.prepare('UPDATE servers SET hostname = NULL WHERE id = ?').run(S1);
});

test('env et hostConfig : off, pause, stop et désactivation si pregen actif', () => {
  assert.deepStrictEqual(routerSleep.env({ sleep_mode: 'off', sleep_after_minutes: 10, pregen_enabled: 0 }), []);
  assert.deepStrictEqual(routerSleep.hostConfig({ sleep_mode: 'off', pregen_enabled: 0 }), {});

  const pauseEnv = routerSleep.env({ sleep_mode: 'pause', sleep_after_minutes: 15, pregen_enabled: 0 });
  assert.deepStrictEqual(pauseEnv, [
    'ENABLE_AUTOPAUSE=TRUE',
    'AUTOPAUSE_TIMEOUT_EST=900',
    'AUTOPAUSE_TIMEOUT_INIT=900',
    'MAX_TICK_TIME=-1',
  ]);
  assert.deepStrictEqual(routerSleep.hostConfig({ sleep_mode: 'pause', pregen_enabled: 0 }), {});

  const stopEnv = routerSleep.env({ sleep_mode: 'stop', sleep_after_minutes: 5, pregen_enabled: 0 });
  assert.deepStrictEqual(stopEnv, [
    'ENABLE_AUTOSTOP=TRUE',
    'AUTOSTOP_TIMEOUT_EST=300',
    'AUTOSTOP_TIMEOUT_INIT=300',
  ]);
  assert.deepStrictEqual(routerSleep.hostConfig({ sleep_mode: 'stop', pregen_enabled: 0 }), {
    RestartPolicy: { Name: 'on-failure' },
  });

  // Quand la pré-génération est active, aucune variable de veille et RestartPolicy non surchargée
  assert.deepStrictEqual(routerSleep.env({ sleep_mode: 'pause', sleep_after_minutes: 10, pregen_enabled: 1 }), []);
  assert.deepStrictEqual(routerSleep.env({ sleep_mode: 'stop', sleep_after_minutes: 10, pregen_enabled: 1 }), []);
  assert.deepStrictEqual(routerSleep.hostConfig({ sleep_mode: 'stop', pregen_enabled: 1 }), {});
});

test('routeur activé vs désactivé : labels mc-router, publishGamePort et join_address', () => {
  const srv = { id: S1, name: 'Mon Serveur Élite !', hostname: null, status: 'stopped', sleep_mode: 'off' };

  appSettings.set('router_enabled', '0');
  appSettings.set('router_domain', '');
  assert.deepStrictEqual(routerSleep.labels(srv), {});
  assert.strictEqual(routerSleep.publishGamePort(srv), true);
  assert.strictEqual(routerSleep.decorate(srv).join_address, undefined);

  appSettings.set('router_enabled', '1');
  appSettings.set('router_domain', 'mc.exemple.fr');
  assert.deepStrictEqual(routerSleep.labels(srv), {
    'mc-router.host': 'mon-serveur-elite.mc.exemple.fr',
    'mc-router.port': '25565',
  });
  assert.strictEqual(routerSleep.publishGamePort(srv), false);
  assert.strictEqual(routerSleep.decorate(srv).join_address, 'mon-serveur-elite.mc.exemple.fr');

  const customSrv = { ...srv, hostname: 'survie' };
  assert.deepStrictEqual(routerSleep.labels(customSrv), {
    'mc-router.host': 'survie.mc.exemple.fr',
    'mc-router.port': '25565',
  });
  assert.strictEqual(routerSleep.decorate(customSrv).join_address, 'survie.mc.exemple.fr');
});

test('createServerContainer applique hostConfig, labels et publishGamePort via extensions', async () => {
  extensions._reset();
  appSettings.set('router_enabled', '1');
  appSettings.set('router_domain', 'mc.exemple.fr');

  lastCreateOpts = null;
  await dockerService.createServerContainer({
    id: S1,
    name: 'Survie',
    hostname: 'survie',
    port: 25565,
    ram_mb: 2048,
    max_players: 20,
    rcon_password: 'secret',
    mc_version: '1.21.1',
    loader_type: 'vanilla',
    sleep_mode: 'stop',
    sleep_after_minutes: 10,
    pregen_enabled: 0,
  });

  assert.strictEqual(lastCreateOpts.HostConfig.RestartPolicy.Name, 'on-failure');
  assert.deepStrictEqual(lastCreateOpts.HostConfig.PortBindings, {});
  assert.strictEqual(lastCreateOpts.Labels['mc-router.host'], 'survie.mc.exemple.fr');
  assert.strictEqual(lastCreateOpts.Labels['mc-router.port'], '25565');
  assert.ok(lastCreateOpts.Env.includes('ENABLE_AUTOSTOP=TRUE'));

  // Routeur désactivé + veille off → port publié, RestartPolicy unless-stopped, aucun label mc-router
  appSettings.set('router_enabled', '0');
  lastCreateOpts = null;
  await dockerService.createServerContainer({
    id: S1,
    name: 'Survie',
    hostname: 'survie',
    port: 25565,
    ram_mb: 2048,
    max_players: 20,
    rcon_password: 'secret',
    mc_version: '1.21.1',
    loader_type: 'vanilla',
    sleep_mode: 'off',
    sleep_after_minutes: 10,
    pregen_enabled: 0,
  });

  assert.strictEqual(lastCreateOpts.HostConfig.RestartPolicy.Name, 'unless-stopped');
  assert.deepStrictEqual(lastCreateOpts.HostConfig.PortBindings['25565/tcp'], [{ HostPort: '25565' }]);
  assert.strictEqual(lastCreateOpts.Labels['mc-router.host'], undefined);
});

test('decorate : détection autopause via getRecentLogs avec cache 30 s', async () => {
  const { sleepCache, refreshSleepCache } = routerSleep._internals;
  sleepCache.clear();

  const row = { id: S1, name: 'S1', container_id: 'ctr-pause', status: 'running', sleep_mode: 'pause', pregen_enabled: 0 };
  mockLogLines = ['[12:00:00] Done (2.1s)!', '[12:10:00] [Autopause] Pausing Java process'];

  await refreshSleepCache('ctr-pause');
  assert.strictEqual(routerSleep.decorate(row).sleeping, true);

  // Changement de logs, mais le cache (30 s) conserve sleeping: true sans relancer d'appel immédiat
  mockLogLines = ['[12:15:00] [Autopause] Resuming Java process', '[12:15:02] Steve joined the game'];
  assert.strictEqual(routerSleep.decorate(row).sleeping, true);

  // Après expiration du cache, refreshSleepCache repasse à false
  await refreshSleepCache('ctr-pause');
  assert.ok(!routerSleep.decorate(row).sleeping);
});

test('routes /api/router/settings et /api/router/status + validation domaine', async () => {
  // Domaine invalide → 400
  const bad1 = await apiReq('PUT', '/api/router/settings', { enabled: true, domain: 'pas-un-domaine' });
  assert.strictEqual(bad1.status, 400);
  const bad2 = await apiReq('PUT', '/api/router/settings', { enabled: true, domain: 'https://mc.exemple.fr' });
  assert.strictEqual(bad2.status, 400);
  const bad3 = await apiReq('PUT', '/api/router/settings', { enabled: true, domain: '*.mc.exemple.fr' });
  assert.strictEqual(bad3.status, 400);
  const emptyOn = await apiReq('PUT', '/api/router/settings', { enabled: true, domain: '' });
  assert.strictEqual(emptyOn.status, 400);

  // Domaine valide → 200
  // mc-router absent : activation refusée (sinon les ports de jeu ne seraient plus publiés)
  mockContainers = [];
  const noRouter = await apiReq('PUT', '/api/router/settings', { enabled: true, domain: 'mc.exemple.fr' });
  assert.strictEqual(noRouter.status, 409);
  mockContainers = [{ Id: 'abcdef1234567890', Image: 'itzg/mc-router:1.55.0', State: 'running', Status: 'Up 1 minute' }];
  const ok = await apiReq('PUT', '/api/router/settings', { enabled: true, domain: 'MC.EXEMPLE.FR' });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.data.enabled, true);
  assert.strictEqual(ok.data.domain, 'mc.exemple.fr');
  assert.strictEqual(ok.data.composeCommand, 'docker compose --profile router up -d');
  assert.strictEqual(ok.data.wildcardDns, '*.mc.exemple.fr');

  const got = await apiReq('GET', '/api/router/settings');
  assert.strictEqual(got.status, 200);
  assert.strictEqual(got.data.enabled, true);
  assert.strictEqual(got.data.domain, 'mc.exemple.fr');

  // Status mc-router
  mockContainers = [];
  const stDown = await apiReq('GET', '/api/router/status');
  assert.strictEqual(stDown.status, 200);
  assert.strictEqual(stDown.data.running, false);

  mockContainers = [{ Id: 'abcdef1234567890', Image: 'itzg/mc-router:latest', State: 'running', Status: 'Up 2 hours' }];
  const stUp = await apiReq('GET', '/api/router/status');
  assert.strictEqual(stUp.status, 200);
  assert.strictEqual(stUp.data.running, true);
  assert.strictEqual(stUp.data.containerId, 'abcdef123456');
});

test('PATCH /api/servers/:id : hostname invalide (400), doublon (409) et veille valide (200)', async () => {
  await apiReq('PUT', '/api/router/settings', { enabled: true, domain: 'mc.exemple.fr' });

  for (const invalid of ['Bad Host', 'UPPER', '-start', 'end-', 'a_b', 'a.b', '']) {
    const r = await apiReq('PATCH', `/api/servers/${S1}`, { hostname: invalid });
    assert.strictEqual(r.status, 400, `hostname « ${invalid} » aurait dû renvoyer 400`);
  }

  const invalidMode = await apiReq('PATCH', `/api/servers/${S1}`, { sleep_mode: 'hibernate' });
  assert.strictEqual(invalidMode.status, 400);

  const invalidDelay = await apiReq('PATCH', `/api/servers/${S1}`, { sleep_after_minutes: 0 });
  assert.strictEqual(invalidDelay.status, 400);

  const ok = await apiReq('PATCH', `/api/servers/${S1}`, {
    sleep_mode: 'pause',
    sleep_after_minutes: 25,
    hostname: 'skyblock-1',
  });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.data.sleep_mode, 'pause');
  assert.strictEqual(ok.data.sleep_after_minutes, 25);
  assert.strictEqual(ok.data.hostname, 'skyblock-1');
  assert.strictEqual(ok.data.needs_recreate, true);
  assert.strictEqual(ok.data.join_address, 'skyblock-1.mc.exemple.fr');

  // Sous-domaine déjà pris par S1 → 409 sur S2
  const clash = await apiReq('PATCH', `/api/servers/${S2}`, { hostname: 'skyblock-1' });
  assert.strictEqual(clash.status, 409);

  // Renvoyer son propre sous-domaine n'est pas un conflit
  const same = await apiReq('PATCH', `/api/servers/${S1}`, { hostname: 'skyblock-1' });
  assert.strictEqual(same.status, 200);
});
