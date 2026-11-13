const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const express = require('express');
const { useTempDataPath, src } = require('./helpers');

const DATA = useTempDataPath();

const axios = require('axios');
const { initDb, getDb } = require(src('config/database'));
const { getJwtSecret, loadOrCreateSecrets } = require(src('config/secrets'));
const installer = require(src('services/installer'));
const pregen = require(src('services/pregen'));
const dockerService = require(src('services/docker'));
const modManager = require(src('services/modManager'));
const modUpdates = require(src('services/modUpdates'));
const serverTypesRoute = require(src('routes/features/server-types'));

const sha1Of = buf => crypto.createHash('sha1').update(buf).digest('hex').toLowerCase();

const paperId = 'dddddddd-1111-2222-3333-444444444444';

let db;
let httpServer;
let baseUrl;
let token;
let origGet;
let origPost;
let origInstallServer;
let origPregenAvailable;

let getCalls = [];
let postCalls = [];
let installCalls = [];
let mockGetHandler = async () => ({ data: {} });
let mockPostHandler = async () => ({ data: {} });

before(async () => {
  origGet = axios.get;
  origPost = axios.post;
  origInstallServer = installer.installServer;
  origPregenAvailable = pregen.isAvailable;

  axios.get = async (url, config) => {
    getCalls.push({ url, config });
    return mockGetHandler(url, config);
  };
  axios.post = async (url, body, config) => {
    postCalls.push({ url, body, config });
    return mockPostHandler(url, body, config);
  };
  installer.installServer = async (srv) => {
    installCalls.push(srv);
  };
  pregen.isAvailable = async () => true;

  initDb();
  db = getDb();
  loadOrCreateSecrets?.();
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES ('u1', 'admin', 'x')").run();
  token = require('jsonwebtoken').sign({ id: 'u1', username: 'admin' }, getJwtSecret(), { expiresIn: '5m' });

  db.prepare(`INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, port, rcon_port, rcon_password, ram_mb, max_players, status, mc_version, loader_type)
    VALUES (?, 'PaperFixture', 'paper-1.21.4', 'PaperFixture', 'vanilla', 25570, 25580, 'x', 4096, 20, 'stopped', '1.21.4', 'paper')`).run(paperId);

  const app = express();
  app.use(express.json());
  app.use(serverTypesRoute.mount, serverTypesRoute.router);
  app.use('/api/servers', require(src('routes/servers/lifecycle')));
  app.use('/api/servers', require(src('routes/servers/mods')));
  app.use(require(src('middleware/errorHandler')));
  httpServer = app.listen(0);
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(() => {
  axios.get = origGet;
  axios.post = origPost;
  installer.installServer = origInstallServer;
  pregen.isAvailable = origPregenAvailable;
  httpServer?.close();
});

beforeEach(() => {
  getCalls = [];
  postCalls = [];
  installCalls = [];
  serverTypesRoute._internals.cache.clear();
  modUpdates.invalidateCache(paperId);
  mockGetHandler = async () => ({ data: {} });
  mockPostHandler = async () => ({ data: {} });
});

async function apiReq(urlPath, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (auth) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

test('GET /api/vanilla/server-types/:type/versions requiert auth et rejette un type inconnu (400)', async () => {
  const unauth = await apiReq('/api/vanilla/server-types/paper/versions', { auth: false });
  assert.strictEqual(unauth.status, 401);

  for (const invalid of ['unknown', 'vanilla', 'spigot']) {
    const res = await apiReq(`/api/vanilla/server-types/${invalid}/versions`);
    assert.strictEqual(res.status, 400);
    assert.ok(res.data?.error);
  }
  assert.strictEqual(getCalls.length, 0);
});

test('GET /api/vanilla/server-types/paper|purpur/versions renvoie les versions récentes en premier, timeout 15s et cache 1h', async () => {
  mockGetHandler = async (url) => {
    if (url.includes('papermc.io')) {
      return { data: { project_id: 'paper', versions: ['1.8.8', '1.20.6', '1.21.4'] } };
    }
    if (url.includes('purpurmc.org')) {
      return { data: { project: 'purpur', versions: ['1.14.1', '1.20.4', '1.21.4'] } };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  // Paper : premier appel réseau (plus récentes d'abord)
  const p1 = await apiReq('/api/vanilla/server-types/paper/versions');
  assert.strictEqual(p1.status, 200);
  assert.strictEqual(p1.data.type, 'paper');
  assert.strictEqual(p1.data.cached, false);
  assert.strictEqual(p1.data.latest, '1.21.4');
  assert.deepStrictEqual(p1.data.versions, ['1.21.4', '1.20.6', '1.8.8']);
  assert.strictEqual(getCalls.length, 1);
  assert.strictEqual(getCalls[0].url, 'https://api.papermc.io/v2/projects/paper');
  assert.strictEqual(getCalls[0].config.timeout, 15000);

  // Paper : second appel servi depuis le cache 1h (aucun appel réseau)
  const p2 = await apiReq('/api/vanilla/server-types/paper/versions');
  assert.strictEqual(p2.status, 200);
  assert.strictEqual(p2.data.cached, true);
  assert.deepStrictEqual(p2.data.versions, ['1.21.4', '1.20.6', '1.8.8']);
  assert.strictEqual(getCalls.length, 1);

  // Purpur : appel indépendant
  const u1 = await apiReq('/api/vanilla/server-types/purpur/versions');
  assert.strictEqual(u1.status, 200);
  assert.strictEqual(u1.data.type, 'purpur');
  assert.strictEqual(u1.data.cached, false);
  assert.deepStrictEqual(u1.data.versions, ['1.21.4', '1.20.4', '1.14.1']);
  assert.strictEqual(getCalls.length, 2);
  assert.strictEqual(getCalls[1].url, 'https://api.purpurmc.org/v2/purpur');
  assert.strictEqual(getCalls[1].config.timeout, 15000);

  // Force refresh & expiration cache
  serverTypesRoute._internals.cache.get('paper').expiresAt = Date.now() - 1;
  const p3 = await apiReq('/api/vanilla/server-types/paper/versions');
  assert.strictEqual(p3.data.cached, false);
  assert.strictEqual(getCalls.length, 3);
});

test('POST /api/servers crée un serveur Paper/Purpur (conserve loader_type avec pregen) et configure Docker TYPE/VERSION', async () => {
  // Paper + pregen_enabled : ne bascule PAS sur Fabric
  const paperRes = await apiReq('/api/servers', {
    method: 'POST',
    body: {
      name: 'Mon Paper',
      loader_type: 'paper',
      modpack_source: 'vanilla',
      mc_version: '1.21.4',
      port: 25571,
      ram_mb: 2048,
      pregen_enabled: true,
    },
  });
  assert.strictEqual(paperRes.status, 201);
  assert.strictEqual(paperRes.data.loader_type, 'paper');
  assert.strictEqual(paperRes.data.modpack_source, 'vanilla');
  assert.strictEqual(paperRes.data.modpack_id, 'paper-1.21.4');
  assert.strictEqual(paperRes.data.mc_version, '1.21.4');
  assert.strictEqual(paperRes.data.pregen_enabled, true);

  const paperRow = db.prepare('SELECT * FROM servers WHERE id = ?').get(paperRes.data.id);
  const paperEnv = dockerService._internals.buildEnvVars(paperRow);
  assert.ok(paperEnv.includes('TYPE=PAPER'));
  assert.ok(paperEnv.includes('VERSION=1.21.4'));

  // Purpur : TYPE=PURPUR + VERSION
  const purpurRes = await apiReq('/api/servers', {
    method: 'POST',
    body: {
      name: 'Mon Purpur',
      loader_type: 'purpur',
      modpack_source: 'vanilla',
      mc_version: '1.21.3',
      port: 25572,
      ram_mb: 2048,
    },
  });
  assert.strictEqual(purpurRes.status, 201);
  assert.strictEqual(purpurRes.data.loader_type, 'purpur');
  assert.strictEqual(purpurRes.data.modpack_source, 'vanilla');
  const purpurRow = db.prepare('SELECT * FROM servers WHERE id = ?').get(purpurRes.data.id);
  const purpurEnv = dockerService._internals.buildEnvVars(purpurRow);
  assert.ok(purpurEnv.includes('TYPE=PURPUR'));
  assert.ok(purpurEnv.includes('VERSION=1.21.3'));

  // Non-régression Vanilla + pregen_enabled : bascule bien vers fabric
  const vanillaPregenRes = await apiReq('/api/servers', {
    method: 'POST',
    body: {
      name: 'Vanilla Pregen',
      loader_type: 'vanilla',
      mc_version: '1.21.4',
      port: 25573,
      ram_mb: 2048,
      pregen_enabled: true,
    },
  });
  assert.strictEqual(vanillaPregenRes.status, 201);
  assert.strictEqual(vanillaPregenRes.data.loader_type, 'fabric');
  assert.strictEqual(installCalls.length, 3);
});

test('modManager gère les plugins Paper dans plugins/, recherche Modrinth plugin et corbeille .craftarr/trash/plugins', async () => {
  const paperServer = db.prepare('SELECT * FROM servers WHERE id = ?').get(paperId);
  const dirs = modManager.dirsOf(paperServer);
  assert.strictEqual(dirs.folder, 'plugins');
  assert.strictEqual(dirs.dir, path.join(DATA, 'servers', paperId, 'server', 'plugins'));
  assert.strictEqual(dirs.trash, path.join(DATA, 'servers', paperId, 'server', '.craftarr', 'trash', 'plugins'));

  // Recherche Modrinth uniquement avec project_type:plugin et loaders plugin
  const pluginJarBuf = Buffer.from('fake-plugin-jar-v1');
  const pluginSha1 = sha1Of(pluginJarBuf);
  mockGetHandler = async (url, config) => {
    if (url.endsWith('/search')) {
      return {
        data: {
          hits: [{
            project_id: 'luckperms',
            slug: 'luckperms',
            title: 'LuckPerms',
            description: 'Permissions plugin',
            icon_url: null,
            downloads: 500000,
            author: 'Luck',
          }],
        },
      };
    }
    if (url.includes('/project/luckperms/version')) {
      return {
        data: [{
          version_type: 'release',
          version_number: '5.4.0',
          dependencies: [],
          files: [{
            filename: 'LuckPerms-Bukkit-5.4.0.jar',
            url: 'https://cdn.modrinth.com/LuckPerms-Bukkit-5.4.0.jar',
            primary: true,
            hashes: { sha1: pluginSha1 },
          }],
        }],
      };
    }
    if (url === 'https://cdn.modrinth.com/LuckPerms-Bukkit-5.4.0.jar' && config?.responseType === 'stream') {
      return {
        data: Readable.from([pluginJarBuf]),
        headers: { 'content-length': String(pluginJarBuf.length) },
      };
    }
    throw new Error(`Unexpected GET: ${url}`);
  };

  const searchRes = await apiReq(`/api/servers/${paperId}/mods/search?q=luckperms&source=all`);
  assert.strictEqual(searchRes.status, 200);
  assert.strictEqual(searchRes.data.results.length, 1);
  assert.strictEqual(searchRes.data.results[0].url, 'https://modrinth.com/plugin/luckperms');
  assert.strictEqual(getCalls.length, 1); // pas d'appel CurseForge
  const facets = JSON.parse(getCalls[0].config.params.facets);
  assert.ok(facets.some(group => group.includes('project_type:plugin')));
  assert.ok(facets.some(group =>
    group.includes('categories:paper')
    && group.includes('categories:purpur')
    && group.includes('categories:bukkit')
    && group.includes('categories:spigot')
  ));

  // Installation dans plugins/
  const installRes = await apiReq(`/api/servers/${paperId}/mods/install`, {
    method: 'POST',
    body: { source: 'modrinth', projectId: 'luckperms' },
  });
  assert.strictEqual(installRes.status, 200);
  const installedPath = path.join(dirs.dir, 'LuckPerms-Bukkit-5.4.0.jar');
  assert.ok(fs.existsSync(installedPath));
  assert.ok(!fs.existsSync(path.join(dirs.mods, 'LuckPerms-Bukkit-5.4.0.jar')));

  // Vérification upload d'un plugin brut : aucun faux avertissement de métadonnées mod manquantes
  const customJar = path.join(dirs.dir, 'CustomPlugin.jar');
  fs.writeFileSync(customJar, Buffer.from('not-a-fabric-mod'));
  const { warnings } = modManager.checkUploaded(paperServer, customJar);
  assert.deepStrictEqual(warnings, []);

  // Liste, toggle (.disabled), suppression vers .craftarr/trash/plugins
  const listed = await apiReq(`/api/servers/${paperId}/mods`);
  assert.strictEqual(listed.status, 200);
  assert.strictEqual(listed.data.mods.length, 2);
  assert.deepStrictEqual(listed.data.problems, []);

  const disabledRes = await apiReq(`/api/servers/${paperId}/mods`, {
    method: 'PATCH',
    body: { file: 'LuckPerms-Bukkit-5.4.0.jar', enabled: false },
  });
  assert.strictEqual(disabledRes.status, 200);
  assert.ok(fs.existsSync(path.join(dirs.dir, 'LuckPerms-Bukkit-5.4.0.jar.disabled')));

  const trashRes = await apiReq(`/api/servers/${paperId}/mods/trash`, {
    method: 'POST',
    body: { files: ['CustomPlugin.jar'] },
  });
  assert.strictEqual(trashRes.status, 200);
  assert.ok(!fs.existsSync(customJar));
  assert.ok(fs.existsSync(path.join(dirs.trash, 'CustomPlugin.jar')));
});

test('modUpdates sur Paper scanne plugins/ et déplace l’ancien plugin dans .craftarr/trash/plugins', async () => {
  const paperServer = db.prepare('SELECT * FROM servers WHERE id = ?').get(paperId);
  const dirs = modManager.dirsOf(paperServer);
  fs.mkdirSync(dirs.dir, { recursive: true });
  for (const f of fs.readdirSync(dirs.dir)) fs.rmSync(path.join(dirs.dir, f), { force: true });

  const oldBuf = Buffer.from('vault-v1');
  const newBuf = Buffer.from('vault-v2');
  const oldSha1 = sha1Of(oldBuf);
  const newSha1 = sha1Of(newBuf);
  fs.writeFileSync(path.join(dirs.dir, 'Vault-1.7.jar'), oldBuf);

  mockPostHandler = async (url) => {
    if (url.endsWith('/version_files')) {
      return {
        data: {
          [oldSha1]: { id: 'v1', project_id: 'vault', version_number: '1.7.0' },
        },
      };
    }
    if (url.endsWith('/version_files/update')) {
      return {
        data: {
          [oldSha1]: {
            id: 'v2',
            project_id: 'vault',
            version_number: '1.8.0',
            game_versions: ['1.21.4'],
            loaders: ['paper'],
            files: [{
              filename: 'Vault-1.8.jar',
              url: 'https://cdn.modrinth.com/Vault-1.8.jar',
              primary: true,
              hashes: { sha1: newSha1 },
            }],
          },
        },
      };
    }
    return { data: {} };
  };
  mockGetHandler = async (url, config) => {
    if (url.includes('/projects')) {
      return { data: [{ id: 'vault', title: 'Vault', slug: 'vault' }] };
    }
    if (url === 'https://cdn.modrinth.com/Vault-1.8.jar' && config?.responseType === 'stream') {
      return {
        data: Readable.from([newBuf]),
        headers: { 'content-length': String(newBuf.length) },
      };
    }
    throw new Error(`Unexpected GET: ${url}`);
  };

  const check = await modUpdates.checkUpdates(paperServer, { force: true });
  assert.strictEqual(check.updatesCount, 1);
  assert.strictEqual(check.mods[0].url, 'https://modrinth.com/plugin/vault');
  assert.deepStrictEqual(postCalls.find(c => c.url.endsWith('/version_files/update')).body.loaders, ['paper', 'bukkit', 'spigot']);

  const upd = await modUpdates.updateMods(paperServer, ['Vault-1.7.jar']);
  assert.strictEqual(upd.updatedCount, 1);
  assert.ok(fs.existsSync(path.join(dirs.dir, 'Vault-1.8.jar')));
  assert.ok(!fs.existsSync(path.join(dirs.dir, 'Vault-1.7.jar')));
  assert.ok(fs.existsSync(path.join(dirs.trash, 'Vault-1.7.jar')));
});
