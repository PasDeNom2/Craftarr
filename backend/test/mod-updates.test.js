const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { useTempDataPath, src } = require('./helpers');

const DATA = useTempDataPath();

const axios = require('axios');
const { initDb, getDb } = require(src('config/database'));
const installer = require(src('services/installer'));
const modManager = require(src('services/modManager'));
const serverLock = require(src('services/serverLock'));
const modUpdates = require(src('services/modUpdates'));
const modUpdatesRoute = require(src('routes/features/mod-updates'));

const sha1Of = buf => crypto.createHash('sha1').update(buf).digest('hex').toLowerCase();

const serverId = 'bbbbbbbb-1111-2222-3333-444444444444';
const paperId = 'cccccccc-1111-2222-3333-444444444444';

let db;
let httpServer;
let baseUrl;
let token;
let origPost;
let origGet;
let origDownloadFile;

let postCalls = [];
let getCalls = [];
let downloadCalls = [];
let mockPostHandler = async () => ({ data: {} });
let mockGetHandler = async () => ({ data: [] });
let mockDownloadHandler = async (url, dest) => {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, 'downloaded-jar');
};

before(async () => {
  origPost = axios.post;
  origGet = axios.get;
  origDownloadFile = installer._internals.downloadFile;

  axios.post = async (url, body, config) => {
    postCalls.push({ url, body, config });
    return mockPostHandler(url, body, config);
  };
  axios.get = async (url, config) => {
    getCalls.push({ url, config });
    return mockGetHandler(url, config);
  };
  installer._internals.downloadFile = async (url, dest, onProgress, expected) => {
    downloadCalls.push({ url, dest, expected });
    return mockDownloadHandler(url, dest, onProgress, expected);
  };

  initDb();
  db = getDb();
  db.prepare(`INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, port, rcon_port, rcon_password, ram_mb, max_players, status, mc_version, loader_type)
    VALUES (?, 'TestFabric', '1', 'TestFabric', 'modrinth', 25565, 25575, 'x', 4096, 20, 'running', '1.21.1', 'fabric')`).run(serverId);
  db.prepare(`INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, port, rcon_port, rcon_password, ram_mb, max_players, status, mc_version, loader_type)
    VALUES (?, 'TestPurpur', '2', 'TestPurpur', 'modrinth', 25566, 25576, 'x', 4096, 20, 'stopped', '1.21.1', 'purpur')`).run(paperId);

  const { getJwtSecret, loadOrCreateSecrets } = require(src('config/secrets'));
  loadOrCreateSecrets?.();
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES ('u1', 'admin', 'x')").run();
  token = require('jsonwebtoken').sign({ id: 'u1', username: 'admin' }, getJwtSecret(), { expiresIn: '5m' });

  const app = express();
  app.use(express.json());
  app.use(modUpdatesRoute.mount, modUpdatesRoute.router);
  httpServer = app.listen(0);
  baseUrl = `http://127.0.0.1:${httpServer.address().port}/api/servers`;
});

after(() => {
  axios.post = origPost;
  axios.get = origGet;
  installer._internals.downloadFile = origDownloadFile;
  httpServer?.close();
});

beforeEach(() => {
  postCalls = [];
  getCalls = [];
  downloadCalls = [];
  modUpdates.invalidateCache(serverId);
  modUpdates.invalidateCache(paperId);
  fs.rmSync(path.join(DATA, 'servers', serverId), { recursive: true, force: true });
  fs.rmSync(path.join(DATA, 'servers', paperId), { recursive: true, force: true });
  db.prepare("UPDATE servers SET status = 'running' WHERE id = ?").run(serverId);
});

async function apiReq(pathname, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (auth) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

test('détection : 3 jars (à jour, mise à jour, inconnu), désactivés et versions MC/loader incompatibles ignorées', async () => {
  const { mods } = modManager.dirsOf(serverId);
  fs.mkdirSync(mods, { recursive: true });

  const bufCurrent = Buffer.from('jar-up-to-date');
  const bufOutdated = Buffer.from('jar-outdated-v1');
  const bufUnknown = Buffer.from('jar-custom-unknown');
  const bufWrongMc = Buffer.from('jar-wrong-mc');
  const bufWrongLoader = Buffer.from('jar-wrong-loader');
  const bufDisabled = Buffer.from('jar-disabled');

  const hCurrent = sha1Of(bufCurrent);
  const hOutdated = sha1Of(bufOutdated);
  const hUnknown = sha1Of(bufUnknown);
  const hWrongMc = sha1Of(bufWrongMc);
  const hWrongLoader = sha1Of(bufWrongLoader);
  const hDisabled = sha1Of(bufDisabled);

  const newOutdatedBytes = Buffer.from('jar-outdated-v2');
  const hOutdatedNew = sha1Of(newOutdatedBytes);

  fs.writeFileSync(path.join(mods, 'alpha-current-1.0.jar'), bufCurrent);
  fs.writeFileSync(path.join(mods, 'beta-outdated-1.0.jar'), bufOutdated);
  fs.writeFileSync(path.join(mods, 'gamma-unknown.jar'), bufUnknown);
  fs.writeFileSync(path.join(mods, 'delta-wrong-mc-1.0.jar'), bufWrongMc);
  fs.writeFileSync(path.join(mods, 'epsilon-wrong-loader-1.0.jar'), bufWrongLoader);
  fs.writeFileSync(path.join(mods, 'zeta-disabled-1.0.jar.disabled'), bufDisabled);

  mockPostHandler = async (url, body) => {
    if (url.endsWith('/version_files/update')) {
      return {
        data: {
          [hCurrent]: {
            id: 'ver-cur-1',
            project_id: 'proj-cur',
            version_number: '1.0.0',
            game_versions: ['1.21.1'],
            loaders: ['fabric'],
            files: [{ filename: 'alpha-current-1.0.jar', url: 'https://cdn.example/a.jar', primary: true, hashes: { sha1: hCurrent } }],
          },
          [hOutdated]: {
            id: 'ver-out-2',
            project_id: 'proj-out',
            version_number: '2.0.0',
            game_versions: ['1.21.1'],
            loaders: ['fabric'],
            files: [{ filename: 'beta-outdated-2.0.jar', url: 'https://cdn.example/b2.jar', primary: true, hashes: { sha1: hOutdatedNew } }],
          },
          [hWrongMc]: {
            id: 'ver-wmc-2',
            project_id: 'proj-wmc',
            version_number: '2.0.0',
            game_versions: ['1.21.4'], // autre version MC -> doit être ignorée
            loaders: ['fabric'],
            files: [{ filename: 'delta-2.0.jar', url: 'https://cdn.example/d2.jar', primary: true, hashes: { sha1: 'deadbeef' } }],
          },
          [hWrongLoader]: {
            id: 'ver-wld-2',
            project_id: 'proj-wld',
            version_number: '2.0.0',
            game_versions: ['1.21.1'],
            loaders: ['forge'], // autre loader -> doit être ignorée
            files: [{ filename: 'epsilon-2.0.jar', url: 'https://cdn.example/e2.jar', primary: true, hashes: { sha1: 'cafebabe' } }],
          },
        },
      };
    }
    if (url.endsWith('/version_files')) {
      return {
        data: {
          [hCurrent]: { id: 'ver-cur-1', project_id: 'proj-cur', version_number: '1.0.0' },
          [hOutdated]: { id: 'ver-out-1', project_id: 'proj-out', version_number: '1.0.0' },
          [hWrongMc]: { id: 'ver-wmc-1', project_id: 'proj-wmc', version_number: '1.0.0' },
          [hWrongLoader]: { id: 'ver-wld-1', project_id: 'proj-wld', version_number: '1.0.0' },
        },
      };
    }
    return { data: {} };
  };

  mockGetHandler = async () => ({
    data: [
      { id: 'proj-cur', title: 'Alpha Current', slug: 'alpha-current', icon_url: 'https://cdn.example/a.png' },
      { id: 'proj-out', title: 'Beta Outdated', slug: 'beta-outdated', icon_url: 'https://cdn.example/b.png' },
    ],
  });

  const { status, data } = await apiReq(`/${serverId}/mods/updates`);
  assert.strictEqual(status, 200);
  assert.strictEqual(data.cached, false);
  assert.strictEqual(data.updatesCount, 1);

  const updateCall = postCalls.find(c => c.url.endsWith('/version_files/update'));
  assert.ok(updateCall);
  assert.match(updateCall.config.headers['User-Agent'], /Craftarr/);
  assert.strictEqual(updateCall.config.timeout, 20000);
  assert.deepStrictEqual(updateCall.body.loaders, ['fabric']);
  assert.deepStrictEqual(updateCall.body.game_versions, ['1.21.1']);
  assert.ok(!updateCall.body.hashes.includes(hDisabled), 'les mods .disabled ne doivent pas être interrogés');
  assert.ok(updateCall.body.hashes.includes(hUnknown));

  const byFile = Object.fromEntries(data.mods.map(m => [m.file, m]));
  assert.strictEqual(byFile['zeta-disabled-1.0.jar.disabled'], undefined);

  assert.strictEqual(byFile['alpha-current-1.0.jar'].status, 'up_to_date');
  assert.strictEqual(byFile['alpha-current-1.0.jar'].name, 'Alpha Current');
  assert.strictEqual(byFile['alpha-current-1.0.jar'].icon, 'https://cdn.example/a.png');

  assert.strictEqual(byFile['beta-outdated-1.0.jar'].status, 'update_available');
  assert.strictEqual(byFile['beta-outdated-1.0.jar'].currentVersion, '1.0.0');
  assert.strictEqual(byFile['beta-outdated-1.0.jar'].latestVersion, '2.0.0');

  assert.strictEqual(byFile['gamma-unknown.jar'].status, 'untracked');
  assert.strictEqual(byFile['delta-wrong-mc-1.0.jar'].status, 'up_to_date');
  assert.strictEqual(byFile['epsilon-wrong-loader-1.0.jar'].status, 'up_to_date');

  // Cache 1 h : un second appel ne refait pas de requête Modrinth
  postCalls = [];
  const second = await apiReq(`/${serverId}/mods/updates`);
  assert.strictEqual(second.status, 200);
  assert.strictEqual(second.data.cached, true);
  assert.strictEqual(postCalls.length, 0);

  // refresh=1 force la réinterrogation
  const forced = await apiReq(`/${serverId}/mods/updates?refresh=1`);
  assert.strictEqual(forced.data.cached, false);
  assert.ok(postCalls.length > 0);
});

test('mise à jour d\'un mod : nouveau fichier présent, ancien en corbeille, cache invalidé, restartRequired, ../x.jar -> 400', async () => {
  const { mods, trash } = modManager.dirsOf(serverId);
  fs.mkdirSync(mods, { recursive: true });

  const oldBytes = Buffer.from('old-mod-bytes');
  const newBytes = Buffer.from('new-mod-bytes');
  const hOld = sha1Of(oldBytes);
  const hNew = sha1Of(newBytes);

  fs.writeFileSync(path.join(mods, 'sodium-0.5.8.jar'), oldBytes);

  mockPostHandler = async (url) => {
    if (url.endsWith('/version_files/update')) {
      return {
        data: {
          [hOld]: {
            id: 'ver-sod-2',
            project_id: 'proj-sod',
            version_number: '0.6.0',
            game_versions: ['1.21.1'],
            loaders: ['fabric'],
            files: [{ filename: 'sodium-0.6.0.jar', url: 'https://cdn.example/sodium-0.6.0.jar', primary: true, hashes: { sha1: hNew } }],
          },
        },
      };
    }
    if (url.endsWith('/version_files')) {
      return { data: { [hOld]: { id: 'ver-sod-1', project_id: 'proj-sod', version_number: '0.5.8' } } };
    }
    return { data: {} };
  };
  mockGetHandler = async () => ({ data: [{ id: 'proj-sod', title: 'Sodium', slug: 'sodium' }] });
  mockDownloadHandler = async (url, dest) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, newBytes);
  };

  // Remplit le cache d'abord
  const pre = await apiReq(`/${serverId}/mods/updates`);
  assert.strictEqual(pre.data.updatesCount, 1);
  assert.ok(modUpdates._internals.cache.has(serverId));

  // Validation chemin dangereux ../x.jar -> 400
  const bad = await apiReq(`/${serverId}/mods/updates`, { method: 'POST', body: { files: ['../x.jar'] } });
  assert.strictEqual(bad.status, 400);

  // Mise à jour effective
  const upd = await apiReq(`/${serverId}/mods/updates`, { method: 'POST', body: { files: ['sodium-0.5.8.jar'] } });
  assert.strictEqual(upd.status, 200);
  assert.strictEqual(upd.data.ok, true);
  assert.strictEqual(upd.data.updatedCount, 1);
  assert.strictEqual(upd.data.restartRequired, true);
  assert.strictEqual(upd.data.results[0].status, 'updated');
  assert.strictEqual(upd.data.results[0].newFile, 'sodium-0.6.0.jar');

  // SHA-1 transmis à downloadFile
  assert.strictEqual(downloadCalls.length, 1);
  assert.strictEqual(downloadCalls[0].expected.sha1, hNew);

  // Nouveau présent, ancien déplacé dans la corbeille modManager
  assert.ok(!fs.existsSync(path.join(mods, 'sodium-0.5.8.jar')));
  assert.strictEqual(fs.readFileSync(path.join(mods, 'sodium-0.6.0.jar'), 'utf8'), 'new-mod-bytes');
  assert.strictEqual(fs.readFileSync(path.join(trash, 'sodium-0.5.8.jar'), 'utf8'), 'old-mod-bytes');

  // Cache invalidé après la mise à jour
  assert.strictEqual(modUpdates._internals.cache.has(serverId), false);
});

test('tout mettre à jour (all) : exécution séquentielle et rapport par mod en cas d\'échec partiel', async () => {
  const { mods, trash } = modManager.dirsOf(serverId);
  fs.mkdirSync(mods, { recursive: true });
  db.prepare("UPDATE servers SET status = 'stopped' WHERE id = ?").run(serverId);

  const b1 = Buffer.from('mod-one-v1');
  const b2 = Buffer.from('mod-two-v1');
  const h1 = sha1Of(b1);
  const h2 = sha1Of(b2);
  const h1New = sha1Of(Buffer.from('mod-one-v2'));
  const h2New = sha1Of(Buffer.from('mod-two-v2'));

  fs.writeFileSync(path.join(mods, 'one-1.0.jar'), b1);
  fs.writeFileSync(path.join(mods, 'two-1.0.jar'), b2);

  mockPostHandler = async (url) => {
    if (url.endsWith('/version_files/update')) {
      return {
        data: {
          [h1]: {
            id: 'v1-2', project_id: 'p1', version_number: '2.0', game_versions: ['1.21.1'], loaders: ['fabric'],
            files: [{ filename: 'one-2.0.jar', url: 'https://cdn.example/one-2.0.jar', primary: true, hashes: { sha1: h1New } }],
          },
          [h2]: {
            id: 'v2-2', project_id: 'p2', version_number: '2.0', game_versions: ['1.21.1'], loaders: ['fabric'],
            files: [{ filename: 'two-2.0.jar', url: 'https://cdn.example/two-2.0.jar', primary: true, hashes: { sha1: h2New } }],
          },
        },
      };
    }
    return { data: {} };
  };
  mockGetHandler = async () => ({
    data: [
      { id: 'p1', title: 'Alpha Mod', slug: 'alpha-mod' },
      { id: 'p2', title: 'Beta Mod', slug: 'beta-mod' },
    ],
  });
  mockDownloadHandler = async (url, dest) => {
    if (url.includes('two-2.0.jar')) throw new Error('hash sha1 invalide');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, 'mod-one-v2');
  };

  const res = await apiReq(`/${serverId}/mods/updates`, { method: 'POST', body: { files: 'all' } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.updatedCount, 1);
  assert.strictEqual(res.data.failedCount, 1);
  assert.strictEqual(res.data.restartRequired, false); // serveur arrêté

  const byFile = Object.fromEntries(res.data.results.map(r => [r.file, r]));
  assert.strictEqual(byFile['one-1.0.jar'].status, 'updated');
  assert.strictEqual(byFile['two-1.0.jar'].status, 'error');
  assert.match(byFile['two-1.0.jar'].error, /sha1/);

  // one mis à jour, two conservé intact (pas mis à la corbeille)
  assert.ok(fs.existsSync(path.join(mods, 'one-2.0.jar')));
  assert.ok(fs.existsSync(path.join(trash, 'one-1.0.jar')));
  assert.ok(fs.existsSync(path.join(mods, 'two-1.0.jar')));
  assert.ok(!fs.existsSync(path.join(mods, 'two-2.0.jar')));
});

test('serveur Purpur/Paper : scanne plugins/ et vérifie les droits, 404 et verrou serveur', async () => {
  const pluginsDir = path.join(DATA, 'servers', paperId, 'server', 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  const buf = Buffer.from('plugin-v1');
  const hOld = sha1Of(buf);
  const hNew = sha1Of(Buffer.from('plugin-v2'));
  fs.writeFileSync(path.join(pluginsDir, 'LuckPerms-5.4.jar'), buf);

  mockPostHandler = async (url) => {
    if (url.endsWith('/version_files/update')) {
      return {
        data: {
          [hOld]: {
            id: 'lp-2', project_id: 'lp', version_number: '5.5', game_versions: ['1.21.1'], loaders: ['paper'],
            files: [{ filename: 'LuckPerms-5.5.jar', url: 'https://cdn.example/lp.jar', primary: true, hashes: { sha1: hNew } }],
          },
        },
      };
    }
    return { data: {} };
  };
  mockGetHandler = async () => ({ data: [{ id: 'lp', title: 'LuckPerms', slug: 'luckperms' }] });

  const check = await apiReq(`/${paperId}/mods/updates`);
  assert.strictEqual(check.status, 200);
  assert.strictEqual(check.data.updatesCount, 1);
  assert.deepStrictEqual(postCalls[0].body.loaders, ['purpur', 'paper', 'bukkit', 'spigot']);

  // Sans jeton -> 401
  const unauth = await apiReq(`/${paperId}/mods/updates`, { auth: false });
  assert.strictEqual(unauth.status, 401);

  // Fichier absent du dossier -> 404
  const missing = await apiReq(`/${paperId}/mods/updates`, { method: 'POST', body: { files: ['absent.jar'] } });
  assert.strictEqual(missing.status, 404);

  // Verrou actif -> 409
  const release = serverLock.acquire(paperId, 'backup');
  try {
    const locked = await apiReq(`/${paperId}/mods/updates`, { method: 'POST', body: { files: 'all' } });
    assert.strictEqual(locked.status, 409);
  } finally {
    release();
  }
});
