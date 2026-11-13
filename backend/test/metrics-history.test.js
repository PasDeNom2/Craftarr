const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { useTempDataPath, src } = require('./helpers');

useTempDataPath();
const { initDb, getDb } = require(src('config/database'));
const docker = require(src('services/docker'));
const rcon = require(src('services/rcon'));
const metricsHistory = require(src('services/metricsHistory'));
const events = require(src('services/events'));
const metricsHistoryExt = require(src('services/extensions/metrics-history'));

let db;
let httpServer;
let baseUrl;
let token;
let origGetContainerStats;
let origGetServerStats;

function insertServer({
  id,
  status = 'running',
  containerId = `cid-${id}`,
  port = 25565,
  rconPort = 25575,
}) {
  db.prepare(`INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, container_id, container_name, port, rcon_port, rcon_password, ram_mb, max_players, status, loader_type)
    VALUES (?, ?, '1', 'Pack', 'curseforge', ?, ?, ?, ?, 'secret', 4096, 20, ?, 'neoforge')`)
    .run(id, `Serveur-${id}`, containerId, `mc-${id}`, port, rconPort, status);
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

before(async () => {
  initDb();
  db = getDb();
  origGetContainerStats = docker.getContainerStats;
  origGetServerStats = rcon.getServerStats;

  const express = require('express');
  const app = express();
  app.use(express.json());
  const routeMod = require(src('routes/features/metrics-history'));
  app.use(routeMod.mount, routeMod.router);
  app.use(require(src('middleware/errorHandler')));

  httpServer = app.listen(0);
  baseUrl = `http://127.0.0.1:${httpServer.address().port}/api/servers`;

  const { getJwtSecret, loadOrCreateSecrets } = require(src('config/secrets'));
  loadOrCreateSecrets?.();
  db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash) VALUES ('u1', 'admin', 'x')").run();
  token = require('jsonwebtoken').sign({ id: 'u1', username: 'admin' }, getJwtSecret(), { expiresIn: '5m' });
});

beforeEach(() => {
  db.prepare('DELETE FROM metrics_samples').run();
  db.prepare('DELETE FROM metrics_hourly').run();
  db.prepare('DELETE FROM servers').run();
});

afterEach(() => {
  metricsHistory.stop();
  docker.getContainerStats = origGetContainerStats;
  rcon.getServerStats = origGetServerStats;
});

after(() => {
  metricsHistory.stop();
  docker.getContainerStats = origGetContainerStats;
  rcon.getServerStats = origGetServerStats;
  httpServer?.close();
});

test('échantillonnage parallèle : 2 running + 1 stopped insère 2 lignes ; échec stats pour un serveur → l\'autre enregistré', async () => {
  insertServer({ id: 's1', status: 'running', containerId: 'cid-s1', port: 25565, rconPort: 25575 });
  insertServer({ id: 's2', status: 'running', containerId: 'cid-s2', port: 25566, rconPort: 25576 });
  insertServer({ id: 's-stop', status: 'stopped', containerId: 'cid-stop', port: 25567, rconPort: 25577 });

  let active = 0;
  let maxActive = 0;
  const dockerCalls = [];

  docker.getContainerStats = async (cid) => {
    dockerCalls.push(cid);
    active++;
    if (active > maxActive) maxActive = active;
    await wait(80);
    active--;
    return cid === 'cid-s1'
      ? { cpu: 25.5, memUsed: 2048, memLimit: 4096, memPercent: 50 }
      : { cpu: 42.0, memUsed: 3072, memLimit: 4096, memPercent: 75 };
  };
  rcon.getServerStats = async (srv) => ({
    players: { online: srv.id === 's1' ? 3 : 7, max: 20 },
    tps: { tps1: srv.id === 's1' ? 20.0 : 19.5, tps5: 20, tps15: 20 },
  });

  const tsMs = 1700000000 * 1000;
  const count = await metricsHistory.sampleOnce(tsMs);

  assert.strictEqual(count, 2);
  assert.strictEqual(maxActive, 2, 'Les serveurs running doivent être interrogés en parallèle');
  assert.ok(!dockerCalls.includes('cid-stop'));

  const rows = db.prepare('SELECT * FROM metrics_samples ORDER BY server_id').all();
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(
    rows.map(r => ({ id: r.server_id, ts: r.ts, cpu: r.cpu, mem: r.mem_mb, players: r.players, tps: r.tps })),
    [
      { id: 's1', ts: 1700000000, cpu: 25.5, mem: 2048, players: 3, tps: 20.0 },
      { id: 's2', ts: 1700000000, cpu: 42.0, mem: 3072, players: 7, tps: 19.5 },
    ]
  );

  // Échec Docker sur s1, succès sur s2 (RCON en échec sur s2 → Docker quand même enregistré)
  db.prepare('DELETE FROM metrics_samples').run();
  docker.getContainerStats = async (cid) => {
    if (cid === 'cid-s1') throw new Error('container unreachable');
    return { cpu: 15.2, memUsed: 1500, memLimit: 4096, memPercent: 37 };
  };
  rcon.getServerStats = async () => {
    throw new Error('RCON timeout');
  };

  const countPartial = await metricsHistory.sampleOnce((1700000060) * 1000);
  assert.strictEqual(countPartial, 1);

  const afterFail = db.prepare('SELECT * FROM metrics_samples').all();
  assert.strictEqual(afterFail.length, 1);
  assert.strictEqual(afterFail[0].server_id, 's2');
  assert.strictEqual(afterFail[0].cpu, 15.2);
  assert.strictEqual(afterFail[0].mem_mb, 1500);
  assert.strictEqual(afterFail[0].players, null);
  assert.strictEqual(afterFail[0].tps, null);
});

test('agrégation horaire (moyenne et max) sur 120 échantillons vieux de 3 h et purge > 48 h / > 30 j', () => {
  insertServer({ id: 's1' });
  const nowSec = 1700001000; // 1000 s après le début de l'heure courante
  const currentHourStart = Math.floor(nowSec / 3600) * 3600;
  const hour1 = currentHourStart - 3 * 3600;
  const hour2 = currentHourStart - 2 * 3600;

  const insert = db.prepare('INSERT INTO metrics_samples (server_id, ts, cpu, mem_mb, players, tps) VALUES (?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    // 60 échantillons sur hour1 : cpu alterne 10/30 (moy 20, max 30), mem 1000..1059? Non : pair=1000, impair=2000 (moy 1500, max 2000)
    // players : 59*2 + 1*10 => total 128 => moy 2.13 -> round 2, max 10
    for (let i = 0; i < 60; i++) {
      const cpu = i % 2 === 0 ? 10 : 30;
      const mem = i % 2 === 0 ? 1000 : 2000;
      const players = i === 59 ? 10 : 2;
      const tps = i === 0 ? 18.0 : 20.0;
      insert.run('s1', hour1 + i * 60, cpu, mem, players, tps);
    }
    // 60 échantillons sur hour2 : valeurs constantes sauf un pic
    for (let i = 0; i < 60; i++) {
      const cpu = i === 30 ? 80 : 20; // total 1260 => moy 21, max 80
      const mem = i === 30 ? 3600 : 2400; // total 145200 => moy 2420, max 3600
      const players = i < 30 ? 4 : 6; // moy 5, max 6
      insert.run('s1', hour2 + i * 60, cpu, mem, players, 20.0);
    }
    // Échantillon vieux de 49 h (doit être purgé de metrics_samples)
    insert.run('s1', nowSec - 49 * 3600, 5, 500, 0, 20.0);
  })();

  // Ligne horaire vieille de 31 j (doit être purgée de metrics_hourly)
  db.prepare('INSERT INTO metrics_hourly (server_id, ts, cpu, mem_mb, players, tps, cpu_max, mem_max, players_max) VALUES (?, ?, 1, 100, 0, 20, 1, 100, 0)')
    .run('s1', nowSec - 31 * 86400);

  metricsHistory.aggregateAndPurge(nowSec * 1000);

  // Les 120 échantillons (< 48 h) sont conservés dans metrics_samples, celui de 49 h est purgé
  const remainingSamples = db.prepare('SELECT COUNT(*) AS n, MIN(ts) AS minTs FROM metrics_samples WHERE server_id = ?').get('s1');
  assert.strictEqual(remainingSamples.n, 120);
  assert.strictEqual(remainingSamples.minTs, hour1);

  // Les lignes horaires (hour1, hour2, + celle de 49 h agrégée) sont présentes, celle de 31 j est purgée
  const hourly = db.prepare('SELECT * FROM metrics_hourly WHERE server_id = ? ORDER BY ts ASC').all('s1');
  assert.strictEqual(hourly.length, 3);
  assert.ok(hourly.every(h => h.ts >= nowSec - 30 * 86400));

  const h1 = hourly.find(h => h.ts === hour1);
  assert.strictEqual(h1.cpu, 20);
  assert.strictEqual(h1.cpu_max, 30);
  assert.strictEqual(h1.mem_mb, 1500);
  assert.strictEqual(h1.mem_max, 2000);
  assert.strictEqual(h1.players, 2);
  assert.strictEqual(h1.players_max, 10);

  const h2 = hourly.find(h => h.ts === hour2);
  assert.strictEqual(h2.cpu, 21);
  assert.strictEqual(h2.cpu_max, 80);
  assert.strictEqual(h2.mem_mb, 2420);
  assert.strictEqual(h2.mem_max, 3600);
  assert.strictEqual(h2.players, 5);
  assert.strictEqual(h2.players_max, 6);
  assert.strictEqual(h2.tps, 20);
});

test('route GET /:id/metrics/history : 24h triés et bornés à 800 pts, 7d horaire, range invalide → 400, serveur inconnu → 404', async () => {
  insertServer({ id: 'srv-api' });
  const nowSec = Math.floor(Date.now() / 1000);

  // Insérer 1200 points minute sur les dernières 24 h (dans le désordre pour vérifier le tri ORDER BY ts ASC)
  const insertSample = db.prepare('INSERT INTO metrics_samples (server_id, ts, cpu, mem_mb, players, tps) VALUES (?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    for (let i = 1199; i >= 0; i--) {
      const ts = nowSec - i * 60;
      insertSample.run('srv-api', ts, 10 + (i % 5), 1024 + i, i % 4, 20.0);
    }
  })();

  // Insérer 3 points horaires sur les derniers 7 j
  const insertHourly = db.prepare('INSERT INTO metrics_hourly (server_id, ts, cpu, mem_mb, players, tps, cpu_max, mem_max, players_max) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insertHourly.run('srv-api', nowSec - 3 * 86400, 15.5, 2048, 3, 19.8, 30, 2500, 5);
  insertHourly.run('srv-api', nowSec - 2 * 86400, 22.0, 2200, 4, 19.9, 40, 2600, 6);

  const authHeaders = { Authorization: `Bearer ${token}` };

  // Sans jeton → 401
  const unauthRes = await fetch(`${baseUrl}/srv-api/metrics/history?range=24h`);
  assert.strictEqual(unauthRes.status, 401);

  // 24h → points triés, <= 800 points, timestamps en ms
  const res24 = await fetch(`${baseUrl}/srv-api/metrics/history?range=24h`, { headers: authHeaders });
  assert.strictEqual(res24.status, 200);
  const body24 = await res24.json();
  assert.strictEqual(body24.range, '24h');
  assert.ok(body24.points.length > 0 && body24.points.length <= 800, `Attendu <= 800 points, reçu ${body24.points.length}`);
  for (let i = 1; i < body24.points.length; i++) {
    assert.ok(body24.points[i].t > body24.points[i - 1].t, 'Les points doivent être triés par timestamp croissant');
  }
  const first = body24.points[0];
  assert.strictEqual(first.t, (nowSec - 1199 * 60) * 1000);
  assert.ok('cpu' in first && 'mem' in first && 'players' in first && 'tps' in first);

  // 7d → lit metrics_hourly
  const res7d = await fetch(`${baseUrl}/srv-api/metrics/history?range=7d`, { headers: authHeaders });
  assert.strictEqual(res7d.status, 200);
  const body7d = await res7d.json();
  assert.strictEqual(body7d.range, '7d');
  assert.strictEqual(body7d.points.length, 2);
  assert.strictEqual(body7d.points[0].mem, 2048);
  assert.strictEqual(body7d.points[1].cpu, 22.0);

  // Range invalide → 400
  const badRange = await fetch(`${baseUrl}/srv-api/metrics/history?range=99d`, { headers: authHeaders });
  assert.strictEqual(badRange.status, 400);

  // Serveur inconnu → 404
  const notFound = await fetch(`${baseUrl}/does-not-exist/metrics/history?range=24h`, { headers: authHeaders });
  assert.strictEqual(notFound.status, 404);
});

test('extension : nettoyage sur server:deleted et boucle sans chevauchement avec stop() propre', async () => {
  insertServer({ id: 's-ext' });
  const nowSec = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO metrics_samples (server_id, ts, cpu, mem_mb, players, tps) VALUES (?, ?, 10, 512, 1, 20)').run('s-ext', nowSec);
  db.prepare('INSERT INTO metrics_hourly (server_id, ts, cpu, mem_mb, players, tps, cpu_max, mem_max, players_max) VALUES (?, ?, 10, 512, 1, 20, 10, 512, 1)').run('s-ext', nowSec - 7200);

  let calls = 0;
  docker.getContainerStats = async () => {
    calls++;
    return { cpu: 5, memUsed: 512, memLimit: 2048, memPercent: 25 };
  };
  rcon.getServerStats = async () => ({ players: { online: 0, max: 20 }, tps: null });

  metricsHistoryExt.init({ events });
  events.emit('server:deleted', { serverId: 's-ext' });

  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM metrics_samples WHERE server_id = ?').get('s-ext').n, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM metrics_hourly WHERE server_id = ?').get('s-ext').n, 0);

  metricsHistory.stop();

  // Vérifie start/stop avec un intervalle court
  db.prepare('DELETE FROM servers').run();
  insertServer({ id: 's-loop' });
  metricsHistory.start({ intervalMs: 25, initialDelayMs: 10 });
  const deadline = Date.now() + 1500;
  while (calls < 2 && Date.now() < deadline) await wait(10);
  assert.ok(calls >= 2, 'La boucle doit exécuter plusieurs tours');
  metricsHistory.stop();
  await wait(20);
  const frozen = calls;
  await wait(80);
  assert.strictEqual(calls, frozen, 'Aucun appel ne doit se produire après stop()');
});
