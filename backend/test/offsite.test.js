const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { useTempDataPath, src } = require('./helpers');

const DATA = useTempDataPath();

// Mocker docker.js et rcon.js avant le chargement des services qui en dépendent
const dockerCalls = [];
const mock = (rel, exports) => {
  const p = require.resolve(src(rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
mock('services/docker.js', {
  stopContainer: async (cid) => { dockerCalls.push(`stop:${cid}`); },
  startContainer: async (cid) => { dockerCalls.push(`start:${cid}`); },
});
mock('services/rcon.js', {
  sendCommand: async () => 'ok',
});

const { loadOrCreateSecrets, signUserToken } = require(src('config/secrets'));
loadOrCreateSecrets();

const { initDb, getDb } = require(src('config/database'));
const appSettings = require(src('services/appSettings'));
const offsite = require(src('services/offsite'));
const offsiteExt = require(src('services/extensions/offsite'));
const extensions = require(src('services/extensions'));
const notify = require(src('services/notify'));
const events = require(src('services/events'));

const originalExecFile = childProcess.execFile;
const originalNotify = notify.notify;

let execHandler = null;
const execCalls = [];
const notifyCalls = [];

childProcess.execFile = (cmd, args, opts, cb) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  execCalls.push({ cmd, args: [...args], opts });
  if (execHandler) return execHandler(cmd, args, opts, cb);
  cb(null, '', '');
};

notify.notify = (ev) => { notifyCalls.push(ev); };

const serverId = '11111111-2222-3333-4444-555555555555';
const serverId2 = '22222222-2222-3333-4444-555555555555';
let db, httpServer, baseUrl, token;

function createServerFiles(id) {
  const dir = path.join(DATA, 'servers', id, 'server');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'world_nether'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'CURRENT-WORLD');
  fs.writeFileSync(path.join(dir, 'world_nether', 'dim.dat'), 'NETHER');
  fs.writeFileSync(path.join(dir, 'ops.json'), '["Steve"]');
  fs.writeFileSync(path.join(dir, 'server.properties'), 'level-name=world\n');
  fs.writeFileSync(path.join(dir, 'plugins', 'example.jar'), 'jar');
  return dir;
}

before(async () => {
  initDb();
  db = getDb();
  db.prepare(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'admin', 'x')`).run();
  token = signUserToken({ id: 'u1', username: 'admin' });

  db.prepare(`INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, port, rcon_port, rcon_password, ram_mb, max_players, status, loader_type, container_id, offsite_enabled)
    VALUES (?, 'Srv1', '1', 'Pack', 'modrinth', 25565, 25575, 'rcon', 4096, 20, 'stopped', 'fabric', 'ctr-1', 1)`).run(serverId);
  db.prepare(`INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, port, rcon_port, rcon_password, ram_mb, max_players, status, loader_type, container_id, offsite_enabled)
    VALUES (?, 'Srv2', '1', 'Pack', 'modrinth', 25566, 25576, 'rcon', 4096, 20, 'stopped', 'fabric', 'ctr-2', 0)`).run(serverId2);

  const express = require('express');
  const app = express();
  app.use(express.json());
  for (const { mount, router } of require(src('routes/features/offsite'))) {
    app.use(mount, router);
  }
  app.use(require(src('middleware/errorHandler')));
  httpServer = app.listen(0);
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(() => {
  childProcess.execFile = originalExecFile;
  notify.notify = originalNotify;
  httpServer?.close();
});

beforeEach(() => {
  execCalls.length = 0;
  dockerCalls.length = 0;
  notifyCalls.length = 0;
  execHandler = null;
  db.prepare('DELETE FROM offsite_runs').run();
  appSettings.set('offsite_repository', '/mnt/restic-repo');
  appSettings.set('offsite_password', 'super-secret-pass');
  appSettings.set('offsite_env', null);
  appSettings.set('offsite_keep_daily', null);
  appSettings.set('offsite_keep_weekly', null);
  appSettings.set('offsite_keep_monthly', null);
  createServerFiles(serverId);
  createServerFiles(serverId2);
});

async function apiReq(method, urlPath, body) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json();
  return { status: res.status, data };
}

test('backupServer : execFile appelé sans shell avec bons arguments et forget rétention, mot de passe uniquement dans env', async () => {
  appSettings.set('offsite_keep_daily', '5');
  appSettings.set('offsite_keep_weekly', '3');
  appSettings.set('offsite_keep_monthly', '2');

  execHandler = (cmd, args, opts, cb) => {
    if (args[0] === 'backup') {
      return cb(null, `${JSON.stringify({ message_type: 'status', percent_done: 1 })}\n${JSON.stringify({ message_type: 'summary', snapshot_id: 'abcdef123456', data_added: 4096 })}\n`, '');
    }
    cb(null, '[]', '');
  };

  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  const res = await offsite.backupServer(server);

  assert.strictEqual(res.snapshotId, 'abcdef123456');
  assert.strictEqual(res.addedBytes, 4096);
  assert.strictEqual(execCalls.length, 2);

  const [backupCall, forgetCall] = execCalls;
  assert.strictEqual(backupCall.cmd, 'restic');
  assert.strictEqual(backupCall.opts.shell, false);
  assert.strictEqual(backupCall.opts.timeout, 6 * 3600_000);
  assert.strictEqual(backupCall.opts.env.RESTIC_REPOSITORY, '/mnt/restic-repo');
  assert.strictEqual(backupCall.opts.env.RESTIC_PASSWORD, 'super-secret-pass');
  assert.ok(!backupCall.args.includes('super-secret-pass'));
  assert.strictEqual(backupCall.args[0], 'backup');
  assert.ok(backupCall.args.includes('--json'));
  assert.ok(backupCall.args.includes('craftarr'));
  assert.ok(backupCall.args.includes(`server:${serverId}`));
  assert.ok(backupCall.args.includes('world'));
  assert.ok(backupCall.args.includes('world_nether'));
  assert.ok(!backupCall.args.includes('world_the_end'));
  assert.ok(backupCall.args.includes('ops.json'));
  assert.ok(backupCall.args.includes('server.properties'));
  assert.ok(backupCall.args.includes('plugins'));

  assert.strictEqual(forgetCall.cmd, 'restic');
  assert.strictEqual(forgetCall.opts.shell, false);
  assert.strictEqual(forgetCall.opts.env.RESTIC_PASSWORD, 'super-secret-pass');
  assert.ok(!forgetCall.args.includes('super-secret-pass'));
  assert.deepStrictEqual(forgetCall.args, [
    'forget', '--json', '--tag', `server:${serverId}`,
    '--keep-daily', '5', '--keep-weekly', '3', '--keep-monthly', '2', '--prune',
  ]);

  const run = db.prepare('SELECT * FROM offsite_runs WHERE server_id = ?').get(serverId);
  assert.strictEqual(run.status, 'success');
  assert.strictEqual(run.snapshot_id, 'abcdef123456');
  assert.strictEqual(run.added_bytes, 4096);
});

test('offsite_env : ligne rm -rf /=x ou clé invalide ignorée ; GET /api/offsite/settings ne renvoie aucun secret', async () => {
  const put = await apiReq('PUT', '/api/offsite/settings', {
    offsite_repository: 's3:https://s3.example.com/bucket',
    offsite_password: 'my-top-secret-password',
    offsite_env: [
      'AWS_ACCESS_KEY_ID=AKIATEST',
      'rm -rf /=x',
      'lowercase_key=nope',
      '123INVALID=nope',
      'A=too-short',
      'PATH=/tmp/evil',
      '# commentaire',
      'AWS_SECRET_ACCESS_KEY=sec=ret',
    ].join('\n'),
    offsite_keep_daily: 10,
  });

  assert.strictEqual(put.status, 200);
  assert.strictEqual(put.data.has_password, true);
  assert.strictEqual(put.data.has_env, true);
  assert.strictEqual(put.data.offsite_password, undefined);
  assert.strictEqual(put.data.offsite_env, undefined);

  const get = await apiReq('GET', '/api/offsite/settings');
  assert.strictEqual(get.status, 200);
  assert.strictEqual(get.data.offsite_repository, 's3:https://s3.example.com/bucket');
  assert.strictEqual(get.data.has_password, true);
  assert.strictEqual(get.data.has_env, true);
  assert.strictEqual(get.data.offsite_keep_daily, 10);
  assert.strictEqual(get.data.offsite_keep_weekly, 4);
  assert.strictEqual(get.data.offsite_keep_monthly, 6);
  const rawJson = JSON.stringify(get.data);
  assert.ok(!rawJson.includes('my-top-secret-password'));
  assert.ok(!rawJson.includes('AKIATEST'));
  assert.ok(!rawJson.includes('sec=ret'));

  execHandler = (cmd, args, opts, cb) => cb(null, '{}', '');
  const testRes = await apiReq('POST', '/api/offsite/test');
  assert.strictEqual(testRes.status, 200);
  assert.strictEqual(execCalls.length, 1);
  const passedEnv = execCalls[0].opts.env;
  assert.strictEqual(passedEnv.AWS_ACCESS_KEY_ID, 'AKIATEST');
  assert.strictEqual(passedEnv.AWS_SECRET_ACCESS_KEY, 'sec=ret');
  assert.strictEqual(passedEnv['rm -rf /'], undefined);
  assert.strictEqual(passedEnv.lowercase_key, undefined);
  assert.strictEqual(passedEnv['123INVALID'], undefined);
  assert.strictEqual(passedEnv.A, undefined);
  assert.notStrictEqual(passedEnv.PATH, '/tmp/evil');
});

test('init : appelle restic init si cat config échoue, sinon reste sans effet', async () => {
  let exists = false;
  execHandler = (cmd, args, opts, cb) => {
    if (args[0] === 'cat' && args[1] === 'config') {
      if (!exists) return cb(new Error('Is there a repository at the following location?'), '', 'Fatal: config does not exist');
      return cb(null, '{}', '');
    }
    if (args[0] === 'init') {
      exists = true;
      return cb(null, '{"id":"repo1"}', '');
    }
    cb(null, '', '');
  };

  const first = await apiReq('POST', '/api/offsite/init');
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.data.alreadyInitialized, false);
  assert.deepStrictEqual(execCalls.map(c => c.args[0]), ['cat', 'init']);

  execCalls.length = 0;
  const second = await apiReq('POST', '/api/offsite/init');
  assert.strictEqual(second.status, 200);
  assert.strictEqual(second.data.alreadyInitialized, true);
  assert.deepStrictEqual(execCalls.map(c => c.args[0]), ['cat']);
});

test('événement backup:created : exécute si offsite_enabled et exécutions simultanées séquentielles', async () => {
  offsiteExt.init({ events });

  let inFlight = 0;
  let maxInFlight = 0;
  const timeline = [];

  execHandler = (cmd, args, opts, cb) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    timeline.push(`start:${args[0]}`);
    setTimeout(() => {
      timeline.push(`end:${args[0]}`);
      inFlight--;
      if (args[0] === 'backup') {
        cb(null, JSON.stringify({ message_type: 'summary', snapshot_id: 'aaaa1111', data_added: 100 }), '');
      } else {
        cb(null, '[]', '');
      }
    }, 25);
  };

  // Serveur désactivé → ignoré
  events.emit('backup:created', { serverId: serverId2, backup: { trigger: 'manual' } });
  // Trigger pre-update → ignoré
  events.emit('backup:created', { serverId, backup: { trigger: 'pre-update' } });
  await new Promise(r => setTimeout(r, 40));
  assert.strictEqual(execCalls.length, 0);

  // Deux événements simultanés sur serveur activé → file d'attente séquentielle
  events.emit('backup:created', { serverId, backup: { trigger: 'manual' } });
  events.emit('backup:created', { serverId, backup: { trigger: 'scheduled' } });

  // Attendre que les deux exécutions (2 * (backup + forget)) se terminent
  for (let i = 0; i < 100; i++) {
    const count = db.prepare("SELECT COUNT(*) c FROM offsite_runs WHERE server_id = ? AND status = 'success'").get(serverId).c;
    if (count >= 2) break;
    await new Promise(r => setTimeout(r, 25));
  }

  assert.strictEqual(maxInFlight, 1);
  assert.strictEqual(execCalls.length, 4);
  assert.deepStrictEqual(timeline, [
    'start:backup', 'end:backup',
    'start:forget', 'end:forget',
    'start:backup', 'end:backup',
    'start:forget', 'end:forget',
  ]);
});

test('extension : fields offsite_enabled et decorate', () => {
  const fields = extensions.fields();
  assert.ok(fields.offsite_enabled);
  assert.strictEqual(fields.offsite_enabled.parse(true), 1);
  assert.strictEqual(fields.offsite_enabled.parse(false), 0);
  assert.deepStrictEqual(extensions.decorate({ offsite_enabled: 1 }), { offsite_enabled: true });
  assert.deepStrictEqual(extensions.decorate({ offsite_enabled: 0 }), { offsite_enabled: false });
});

test('restore : snapshotId invalide → 400 ; snapshotId valide restaure via staging et redémarre', async () => {
  for (const badId of [undefined, '', '1234', 'zzzzzzzz', 'abcdef12;rm -rf /', '../abcdef12', 'ABCDEF12']) {
    const r = await apiReq('POST', `/api/servers/${serverId}/offsite/restore`, badId === undefined ? {} : { snapshotId: badId });
    assert.strictEqual(r.status, 400, `attendu 400 pour ${String(badId)}`);
  }

  execHandler = (cmd, args, opts, cb) => {
    if (args[0] === 'restore') {
      const targetIdx = args.indexOf('--target');
      const targetDir = args[targetIdx + 1];
      fs.mkdirSync(path.join(targetDir, 'world'), { recursive: true });
      fs.writeFileSync(path.join(targetDir, 'world', 'level.dat'), 'RESTORED-WORLD');
      fs.writeFileSync(path.join(targetDir, 'ops.json'), '["Alex"]');
      return cb(null, '{}', '');
    }
    if (args[0] === 'snapshots') {
      return cb(null, JSON.stringify([{ id: 'abcdef1234567890', short_id: 'abcdef12', time: new Date().toISOString(), tags: ['craftarr', `server:${serverId}`] }]), '');
    }
    cb(null, '', '');
  };

  // Snapshot n'appartenant pas au serveur → 404, aucune restauration
  const foreign = await apiReq('POST', `/api/servers/${serverId}/offsite/restore`, { snapshotId: '99999999' });
  assert.strictEqual(foreign.status, 404);
  assert.ok(!execCalls.some(c => c.args[0] === 'restore'));
  assert.deepStrictEqual(dockerCalls, []);

  const ok = await apiReq('POST', `/api/servers/${serverId}/offsite/restore`, { snapshotId: 'abcdef1234' });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.data.ok, true);
  assert.deepStrictEqual(dockerCalls, ['stop:ctr-1', 'start:ctr-1']);

  const serverDir = path.join(DATA, 'servers', serverId, 'server');
  assert.strictEqual(fs.readFileSync(path.join(serverDir, 'world', 'level.dat'), 'utf8'), 'RESTORED-WORLD');
  assert.strictEqual(fs.readFileSync(path.join(serverDir, 'ops.json'), 'utf8'), '["Alex"]');
  assert.ok(!fs.existsSync(path.join(DATA, 'servers', serverId, '.offsite-restore-staging')));
});

test('backupServer en échec : enregistre status failed et notifie', async () => {
  execHandler = (cmd, args, opts, cb) => cb(new Error('S3 unreachable'), '', 'Fatal: S3 unreachable');
  const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);

  await assert.rejects(() => offsite.backupServer(server), /S3 unreachable/);
  const run = db.prepare('SELECT * FROM offsite_runs WHERE server_id = ?').get(serverId);
  assert.strictEqual(run.status, 'failed');
  assert.match(run.message, /S3 unreachable/);
  assert.strictEqual(notifyCalls.length, 1);
  assert.strictEqual(notifyCalls[0].level, 'error');
});

test('redactSecrets : identifiants d\'URL et secrets masqués dans les messages', () => {
  const { redactSecrets } = require(src('services/offsite'));
  const msg = redactSecrets('Fatal: unable to open rest:https://bob:s3cr3t@backup.example/repo');
  assert.ok(!msg.includes('s3cr3t') && msg.includes('***:***@'), msg);
});
