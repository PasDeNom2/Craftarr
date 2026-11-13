// Tests du planificateur : parser cron, API CRUD, exécution ordonnée, arrêt sur erreur, conditions et événements.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { useTempDataPath, src } = require('./helpers');

useTempDataPath();

const calls = [];
let rconFail = false;
let backupFail = false;
let onlinePlayers = 0;

const mock = (rel, exports) => {
  const p = require.resolve(src(rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

mock('services/rcon.js', {
  sendCommand: async (server, command) => {
    calls.push(`rcon:${command}`);
    if (rconFail) throw new Error('RCON indisponible');
    return 'OK';
  },
  getPlayerList: async (server) => {
    calls.push(`rcon:list:${server.id}`);
    return { online: onlinePlayers, max: server.max_players, names: [] };
  },
});

mock('services/backup.js', {
  createBackup: async (server, trigger) => {
    calls.push(`backup:${server.id}:${trigger}`);
    if (backupFail) throw new Error('Disque plein');
    return { id: 'bk-1', filename: 'bk.zip', trigger };
  },
  cleanOldBackups: async () => {},
  getWorldDirs: () => ['world'],
  backupsDirFor: () => '/tmp',
  migrateBackupLocation: () => {},
  scheduleBackups: () => {},
});

mock('services/docker.js', {
  startContainer: async (cid) => calls.push(`docker:start:${cid}`),
  stopContainer: async (cid) => calls.push(`docker:stop:${cid}`),
  restartContainer: async (cid) => calls.push(`docker:restart:${cid}`),
  removeContainer: async (cid) => calls.push(`docker:remove:${cid}`),
  createServerContainer: async () => ({ containerId: 'new-ctr', containerName: 'mc-test' }),
});

const { initDb, getDb } = require(src('config/database'));
const scheduler = require(src('services/scheduler'));
const events = require(src('services/events'));
const extensions = require(src('services/extensions'));
const errorHandler = require(src('middleware/errorHandler'));

const serverId = '11111111-2222-3333-4444-555555555555';
let db, httpServer, base, token;

before(() => {
  initDb();
  db = getDb();
  db.prepare(`
    INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, port, rcon_port, rcon_password, ram_mb, max_players, status, container_id, container_name)
    VALUES (?, 'Srv', '1', 'Srv', 'vanilla', 25565, 25575, 'secret', 4096, 20, 'running', 'ctr-1', 'mc-srv')
  `).run(serverId);

  db.prepare("INSERT INTO users (id, username, password_hash) VALUES ('u1', 'admin', 'x')").run();
  const { getJwtSecret, loadOrCreateSecrets } = require(src('config/secrets'));
  loadOrCreateSecrets?.();
  token = require('jsonwebtoken').sign({ id: 'u1', username: 'admin' }, getJwtSecret(), { expiresIn: '5m' });

  extensions._reset();
  extensions.init({ events });

  const express = require('express');
  const app = express();
  app.use(express.json());
  for (const { mount, router } of [].concat(require(src('routes/features/scheduler')))) app.use(mount, router);
  app.use(errorHandler);
  httpServer = app.listen(0);
  base = `http://127.0.0.1:${httpServer.address().port}/api/servers`;
});

after(() => {
  scheduler.stop();
  httpServer?.close();
});

async function api(method, path, body) {
  const url = path === '/schedule-presets' ? base.replace('/api/servers', '/api/schedule-presets') : base + path;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

test('cron nextRun : mardi 03:30, */15, plages, listes et expressions invalides', () => {
  const monday = new Date(2026, 10, 9, 10, 0, 0, 0); // Lundi 9 nov 2026 10:00
  assert.strictEqual(monday.getDay(), 1);
  const tue = scheduler.nextRun('30 3 * * 2', monday);
  assert.strictEqual(tue.getFullYear(), 2026);
  assert.strictEqual(tue.getMonth(), 10);
  assert.strictEqual(tue.getDate(), 10);
  assert.strictEqual(tue.getDay(), 2);
  assert.strictEqual(tue.getHours(), 3);
  assert.strictEqual(tue.getMinutes(), 30);

  // */15 * * * *
  const d15a = scheduler.nextRun('*/15 * * * *', new Date(2026, 10, 9, 10, 7, 0, 0));
  assert.strictEqual(d15a.getHours(), 10);
  assert.strictEqual(d15a.getMinutes(), 15);
  const d15b = scheduler.nextRun('*/15 * * * *', new Date(2026, 10, 9, 10, 15, 0, 0));
  assert.strictEqual(d15b.getHours(), 10);
  assert.strictEqual(d15b.getMinutes(), 30);

  // Plages et listes (9h-11h, minutes 0 et 30, lun-ven)
  const listRange = scheduler.nextRun('0,30 9-11 * * 1-5', new Date(2026, 10, 9, 9, 10, 0, 0));
  assert.strictEqual(listRange.getHours(), 9);
  assert.strictEqual(listRange.getMinutes(), 30);

  // Dimanche via 7
  const sun = scheduler.nextRun('0 12 * * 7', monday);
  assert.strictEqual(sun.getDay(), 0);
  assert.strictEqual(sun.getHours(), 12);
  assert.strictEqual(sun.getMinutes(), 0);

  // Expressions invalides
  for (const bad of ['', '0 0 * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '*/0 * * * *', '5-2 * * * *', '0 0 31 2 *']) {
    assert.throws(() => scheduler.nextRun(bad, monday), /./, `Devrait rejeter « ${bad} »`);
  }
});

test('API : préréglages, validation stricte (400), création (201), liste et exécution immédiate', async () => {
  const presets = await api('GET', '/schedule-presets');
  assert.strictEqual(presets.status, 200);
  assert.ok(presets.data.some(p => p.id === 'announced-restart' && p.steps.length === 5));

  // Cron invalide -> 400
  const badCron = await api('POST', `/${serverId}/schedules`, {
    name: 'Mauvais cron',
    trigger_type: 'cron',
    cron: '99 * * * *',
    steps: [{ type: 'backup' }],
  });
  assert.strictEqual(badCron.status, 400);

  // Commande avec retour à la ligne -> 400
  const badCmd = await api('POST', `/${serverId}/schedules`, {
    name: 'Cmd multiligne',
    trigger_type: 'interval',
    interval_minutes: 60,
    steps: [{ type: 'command', command: 'say hello\nstop' }],
  });
  assert.strictEqual(badCmd.status, 400);

  // Trop d'étapes (>20) -> 400
  const tooMany = await api('POST', `/${serverId}/schedules`, {
    name: 'Trop long',
    trigger_type: 'interval',
    interval_minutes: 10,
    steps: Array.from({ length: 21 }, () => ({ type: 'backup' })),
  });
  assert.strictEqual(tooMany.status, 400);

  // Création valide -> 201
  const created = await api('POST', `/${serverId}/schedules`, {
    name: 'Sauvegarde annoncée',
    trigger_type: 'cron',
    cron: '0 4 * * *',
    steps: [
      { type: 'say', message: 'Backup imminent' },
      { type: 'backup' },
    ],
  });
  assert.strictEqual(created.status, 201);
  assert.strictEqual(created.data.name, 'Sauvegarde annoncée');
  assert.ok(created.data.next_run_at);

  const listed = await api('GET', `/${serverId}/schedules`);
  assert.strictEqual(listed.status, 200);
  assert.strictEqual(listed.data.length, 1);

  // Exécution immédiate [say, backup] -> success et appels dans l'ordre
  calls.length = 0;
  rconFail = false;
  backupFail = false;
  const run = await api('POST', `/${serverId}/schedules/${created.data.id}/run`);
  assert.strictEqual(run.status, 200);
  assert.strictEqual(run.data.status, 'success');
  assert.deepStrictEqual(calls, [
    'rcon:say Backup imminent',
    `backup:${serverId}:scheduled`,
  ]);

  const runs = await api('GET', `/${serverId}/schedules/${created.data.id}/runs`);
  assert.strictEqual(runs.status, 200);
  assert.strictEqual(runs.data.length, 1);
  assert.strictEqual(runs.data[0].status, 'success');

  // Étape en échec -> failed et étapes suivantes non exécutées
  calls.length = 0;
  rconFail = true;
  const failedRun = await api('POST', `/${serverId}/schedules/${created.data.id}/run`);
  assert.strictEqual(failedRun.status, 200);
  assert.strictEqual(failedRun.data.status, 'failed');
  assert.deepStrictEqual(calls, ['rcon:say Backup imminent']);
  rconFail = false;
});

test('condition only_if_players et étape power', async () => {
  const created = await api('POST', `/${serverId}/schedules`, {
    name: 'Restart si joueurs en ligne',
    trigger_type: 'interval',
    interval_minutes: 30,
    only_if_players: 'online',
    steps: [{ type: 'power', action: 'restart' }],
  });
  assert.strictEqual(created.status, 201);

  // 0 joueur en ligne -> skipped
  calls.length = 0;
  onlinePlayers = 0;
  const skipped = await api('POST', `/${serverId}/schedules/${created.data.id}/run`);
  assert.strictEqual(skipped.status, 200);
  assert.strictEqual(skipped.data.status, 'skipped');
  assert.deepStrictEqual(calls, [`rcon:list:${serverId}`]);

  // 2 joueurs en ligne -> exécuté
  calls.length = 0;
  onlinePlayers = 2;
  const ran = await api('POST', `/${serverId}/schedules/${created.data.id}/run`);
  assert.strictEqual(ran.status, 200);
  assert.strictEqual(ran.data.status, 'success');
  assert.deepStrictEqual(calls, [`rcon:list:${serverId}`, 'docker:restart:ctr-1']);
  assert.strictEqual(db.prepare('SELECT status FROM servers WHERE id = ?').get(serverId).status, 'starting');
});

test('déclencheur événementiel server:crashed et server:empty', async () => {
  const crashTask = await api('POST', `/${serverId}/schedules`, {
    name: 'Backup post-crash',
    trigger_type: 'event',
    event: 'server:crashed',
    steps: [{ type: 'backup' }],
  });
  assert.strictEqual(crashTask.status, 201);

  calls.length = 0;
  events.emit('server:crashed', { serverId, restarts: 3 });
  await new Promise(r => setTimeout(r, 30));

  assert.deepStrictEqual(calls, [`backup:${serverId}:scheduled`]);
  const runs = await api('GET', `/${serverId}/schedules/${crashTask.data.id}/runs`);
  assert.strictEqual(runs.data.length, 1);
  assert.strictEqual(runs.data[0].status, 'success');

  // server:empty sur dernier player:leave quand players.is_online = 0
  const emptyTask = await api('POST', `/${serverId}/schedules`, {
    name: 'Backup serveur vide',
    trigger_type: 'event',
    event: 'server:empty',
    steps: [{ type: 'backup' }],
  });
  assert.strictEqual(emptyTask.status, 201);

  calls.length = 0;
  events.emit('player:leave', { serverId, username: 'Steve', reason: 'Quit' });
  await new Promise(r => setTimeout(r, 30));
  assert.deepStrictEqual(calls, [`backup:${serverId}:scheduled`]);
});

test('rétention des 50 dernières exécutions, PATCH et DELETE', async () => {
  const created = await api('POST', `/${serverId}/schedules`, {
    name: 'Rétention',
    trigger_type: 'interval',
    interval_minutes: 15,
    steps: [{ type: 'say', message: 'ping' }],
  });
  assert.strictEqual(created.status, 201);
  const sid = created.data.id;

  for (let i = 0; i < 55; i++) {
    await scheduler.executeSchedule(db.prepare('SELECT * FROM schedules WHERE id = ?').get(sid));
  }
  const runs = await api('GET', `/${serverId}/schedules/${sid}/runs`);
  assert.strictEqual(runs.data.length, 50);

  const patched = await api('PATCH', `/${serverId}/schedules/${sid}`, { enabled: false, name: 'Rétention OFF' });
  assert.strictEqual(patched.status, 200);
  assert.strictEqual(patched.data.enabled, false);
  assert.strictEqual(patched.data.next_run_at, null);

  const deleted = await api('DELETE', `/${serverId}/schedules/${sid}`);
  assert.strictEqual(deleted.status, 200);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM schedule_runs WHERE schedule_id = ?').get(sid).n, 0);
});
