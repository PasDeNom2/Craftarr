// Tests de la fonctionnalité A3 — Diagnostic : spark, rapports de crash, logs .gz, partage mclo.gs.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const { useTempDataPath, src } = require('./helpers');

const DATA = useTempDataPath();

// Simulation de Docker (streamContainerLogs) et RCON (sendCommand) avant de charger diagnostics
const rconCalls = [];
let rconHandler = async () => '';
let logStreamHandler = (_containerId, _onData, _onError, _onEnd, _opts) => () => {};

const mock = (rel, exports) => {
  const p = require.resolve(src(rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

mock('services/docker.js', {
  streamContainerLogs: (containerId, onData, onError, onEnd, opts) =>
    logStreamHandler(containerId, onData, onError, onEnd, opts),
  getContainerStatus: async () => 'running',
});

mock('services/rcon.js', {
  sendCommand: async (server, cmd) => {
    rconCalls.push({ serverId: server.id, cmd });
    return rconHandler(server, cmd);
  },
});

mock('services/installer.js', {
  _internals: {
    downloadFile: async (_url, dest) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, 'fake-spark-jar');
    },
  },
});

const axios = require('axios');
let axiosPostHandler = async () => ({ data: {} });
let axiosGetHandler = async () => ({ data: {} });
axios.post = (...args) => axiosPostHandler(...args);
axios.get = (...args) => axiosGetHandler(...args);

const { initDb, getDb } = require(src('config/database'));
const diagnostics = require(src('services/diagnostics'));
const diagnosticsRoute = require(src('routes/features/diagnostics'));

const serverId = 'dddddddd-3333-0000-0000-000000000000';
const paperId = 'dddddddd-4444-0000-0000-000000000000';
const serverRoot = path.join(DATA, 'servers', serverId, 'server');
const paperRoot = path.join(DATA, 'servers', paperId, 'server');

let db;
let httpServer;
let baseUrl;
let token;
const emitted = [];

before(() => {
  initDb();
  db = getDb();

  db.prepare(`INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, port, rcon_port, rcon_password, ram_mb, max_players, status, mc_version, loader_type, container_id)
    VALUES (?, 'DiagTest', '1', 'DiagTest', 'modrinth', 25565, 25575, 'pass', 4096, 20, 'running', '1.21.1', 'fabric', 'ctr-diag-1')`).run(serverId);

  db.prepare(`INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, port, rcon_port, rcon_password, ram_mb, max_players, status, mc_version, loader_type, container_id)
    VALUES (?, 'PaperDiag', '2', 'PaperDiag', 'vanilla', 25566, 25576, 'pass', 4096, 20, 'running', '1.21.4', 'paper', 'ctr-diag-2')`).run(paperId);

  const app = express();
  app.use(express.json());
  app.set('io', {
    to(room) {
      return {
        emit(event, payload) {
          emitted.push({ room, event, payload });
        },
      };
    },
  });
  app.use(diagnosticsRoute.mount, diagnosticsRoute.router);
  // Gestionnaire d'erreurs JSON (comme l'application réelle)
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  httpServer = app.listen(0);
  baseUrl = `http://127.0.0.1:${httpServer.address().port}/api/servers`;

  const { getJwtSecret, loadOrCreateSecrets } = require(src('config/secrets'));
  loadOrCreateSecrets?.();
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES ('u-diag', 'admin', 'x')").run();
  token = require('jsonwebtoken').sign({ id: 'u-diag', username: 'admin' }, getJwtSecret(), { expiresIn: '5m' });
});

after(() => {
  httpServer?.closeAllConnections?.();
  httpServer?.close();
});

async function apiReq(pathname, { method = 'GET', body, id = serverId } = {}) {
  const res = await fetch(`${baseUrl}/${id}${pathname}`, {
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

test('liste : crash-reports triés récents d\'abord, logs .gz décompressés, path traversal refusé', async () => {
  fs.mkdirSync(path.join(serverRoot, 'crash-reports'), { recursive: true });
  fs.mkdirSync(path.join(serverRoot, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'secrets.json'), '{"jwt":"secret"}');
  fs.writeFileSync(path.join(serverRoot, 'server.properties'), 'motd=Test');

  const oldCrash = path.join(serverRoot, 'crash-reports', 'crash-2026-01-01.txt');
  const newCrash = path.join(serverRoot, 'crash-reports', 'crash-2026-11-13.txt');
  fs.writeFileSync(oldCrash, '---- Minecraft Crash Report ----\nDescription: Old crash\n');
  fs.writeFileSync(newCrash, [
    '---- Minecraft Crash Report ----',
    '// Don\'t do that.',
    '',
    'Time: 2026-11-13 15:00:00',
    'Description: Ticking entity',
    '',
    'java.lang.NullPointerException: Cannot invoke "Level.isClientSide()" because "level" is null',
    '\tat TRANSFORMER/minecraft@1.21.1/net.minecraft.world.entity.Entity.tick(Entity.java:100)',
    '\tat TRANSFORMER/create@6.0.0/com.simibubi.create.content.contraptions.Contraption.tick(Contraption.java:142)',
    '\tat java.base/java.lang.Thread.run(Thread.java:1583)',
  ].join('\n'));
  fs.utimesSync(oldCrash, new Date('2026-01-01T10:00:00Z'), new Date('2026-01-01T10:00:00Z'));
  fs.utimesSync(newCrash, new Date('2026-11-13T15:00:00Z'), new Date('2026-11-13T15:00:00Z'));

  fs.writeFileSync(path.join(serverRoot, 'logs', 'latest.log'), '[15:00:00] [Server thread/INFO]: Done\n');
  const gzContent = '[12:00:00] [Server thread/INFO]: Archived log line\n';
  fs.writeFileSync(path.join(serverRoot, 'logs', '2026-11-12-1.log.gz'), zlib.gzipSync(Buffer.from(gzContent, 'utf8')));

  const list = await apiReq('/diagnostics');
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.data.spark.installed, false);
  assert.strictEqual(list.data.spark.canInstall, true);
  assert.deepStrictEqual(
    list.data.crashReports.map(f => f.filename),
    ['crash-2026-11-13.txt', 'crash-2026-01-01.txt']
  );
  assert.ok(list.data.logs.some(f => f.filename === 'latest.log'));
  assert.ok(list.data.logs.some(f => f.filename === '2026-11-12-1.log.gz' && f.compressed === true));

  // Paper 1.21.4 intègre spark nativement
  fs.mkdirSync(paperRoot, { recursive: true });
  const paperDiag = await apiReq('/diagnostics', { id: paperId });
  assert.strictEqual(paperDiag.status, 200);
  assert.strictEqual(paperDiag.data.spark.installed, true);
  assert.strictEqual(paperDiag.data.spark.builtin, true);

  // Lecture .gz décompressée
  const gzRead = await apiReq('/diagnostics/file?name=logs/2026-11-12-1.log.gz');
  assert.strictEqual(gzRead.status, 200);
  assert.strictEqual(gzRead.data.compressed, true);
  assert.strictEqual(gzRead.data.content, gzContent);

  // Path traversal et fichier non autorisé refusés (400/403)
  const traversal = await apiReq('/diagnostics/file?name=../../secrets.json');
  assert.ok([400, 403].includes(traversal.status), `Attendu 400/403, reçu ${traversal.status}`);

  const unlisted = await apiReq('/diagnostics/file?name=server.properties');
  assert.ok([400, 403].includes(unlisted.status), `Attendu 400/403, reçu ${unlisted.status}`);
});

test('résumé automatique d\'un rapport de crash : description, exception et ligne at d\'un mod', async () => {
  const res = await apiReq('/diagnostics/file?name=crash-reports/crash-2026-11-13.txt');
  assert.strictEqual(res.status, 200);
  assert.ok(res.data.summary);
  assert.strictEqual(res.data.summary.description, 'Ticking entity');
  assert.ok(res.data.summary.exception.startsWith('java.lang.NullPointerException:'));
  assert.strictEqual(res.data.summary.mod, 'create');
  assert.ok(res.data.summary.atLine.includes('com.simibubi.create.content.contraptions.Contraption.tick'));
});

test('partage mclo.gs : URL + insights renvoyés, contenu > 10 Mo tronqué', async () => {
  const bigContent = 'A'.repeat(10 * 1024 * 1024 + 4096);
  fs.writeFileSync(path.join(serverRoot, 'logs', 'latest.log'), bigContent, 'utf8');

  let capturedBody = null;
  let capturedTimeout = null;
  axiosPostHandler = async (url, body, config) => {
    assert.strictEqual(url, 'https://api.mclo.gs/1/log');
    assert.strictEqual(config.headers['Content-Type'], 'application/x-www-form-urlencoded');
    capturedTimeout = config.timeout;
    capturedBody = body;
    return { data: { success: true, id: 'AbCd123', url: 'https://mclo.gs/AbCd123' } };
  };
  axiosGetHandler = async (url, config) => {
    assert.strictEqual(url, 'https://api.mclo.gs/1/insights/AbCd123');
    assert.strictEqual(config.timeout, 20_000);
    return {
      data: {
        id: 'AbCd123',
        analysis: {
          problems: [{ message: 'Test problem', solutions: [{ message: 'Fix it' }] }],
          information: [{ label: 'Version', value: '1.21.1' }],
        },
      },
    };
  };

  const res = await apiReq('/diagnostics/share', {
    method: 'POST',
    body: { name: 'logs/latest.log' },
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.url, 'https://mclo.gs/AbCd123');
  assert.strictEqual(res.data.id, 'AbCd123');
  assert.strictEqual(res.data.truncated, true);
  assert.strictEqual(capturedTimeout, 20_000);
  assert.strictEqual(res.data.insights.analysis.problems[0].message, 'Test problem');

  const params = new URLSearchParams(capturedBody);
  const sent = params.get('content');
  assert.strictEqual(Buffer.byteLength(sent, 'utf8'), 10 * 1024 * 1024);
});

test('profilage spark : URL reçue dans le flux de logs + socket.io ; timeout sans URL', async () => {
  emitted.length = 0;
  rconCalls.length = 0;

  let seenSince = null;
  rconHandler = async () => 'Profiler started';
  logStreamHandler = (_cid, onData, _onError, _onEnd, opts) => {
    seenSince = opts?.since;
    const t = setTimeout(() => {
      onData('[15:01:00 INFO]: [⚡] Profiler stopped & uploading...');
      onData('[15:01:01 INFO]: [⚡] https://spark.lucko.me/TestProf123');
    }, 15);
    return () => clearTimeout(t);
  };

  const prof = await apiReq('/diagnostics/spark/profile', {
    method: 'POST',
    body: { kind: 'profiler' },
  });

  assert.strictEqual(prof.status, 200);
  assert.strictEqual(prof.data.url, 'https://spark.lucko.me/TestProf123');
  assert.strictEqual(rconCalls[0].cmd, 'spark profiler start --timeout 60');
  assert.strictEqual(typeof seenSince, 'number');
  assert.ok(emitted.some(e => e.room === `server:${serverId}` && e.event === 'diagnostics:spark' && e.payload.status === 'running'));
  assert.ok(emitted.some(e => e.room === `server:${serverId}` && e.event === 'diagnostics:spark' && e.payload.status === 'done' && e.payload.url === 'https://spark.lucko.me/TestProf123'));

  // Résumé mémoire
  rconCalls.length = 0;
  logStreamHandler = (_cid, onData) => {
    const t = setTimeout(() => onData('[15:02:00 INFO]: https://spark.lucko.me/Heap789'), 10);
    return () => clearTimeout(t);
  };
  const heap = await apiReq('/diagnostics/spark/profile', {
    method: 'POST',
    body: { kind: 'heap' },
  });
  assert.strictEqual(heap.status, 200);
  assert.strictEqual(heap.data.url, 'https://spark.lucko.me/Heap789');
  assert.strictEqual(rconCalls[0].cmd, 'spark heapsummary');

  // Timeout quand aucune URL n'apparaît dans les logs
  const prevTimeout = diagnostics._internals.profileTimeoutMs;
  diagnostics._internals.profileTimeoutMs = 40;
  try {
    logStreamHandler = () => () => {};
    const timedOut = await apiReq('/diagnostics/spark/profile', {
      method: 'POST',
      body: { kind: 'profiler' },
    });
    assert.strictEqual(timedOut.status, 504);
    assert.ok(timedOut.data.error);
    assert.ok(emitted.some(e => e.event === 'diagnostics:spark' && e.payload.status === 'error'));
  } finally {
    diagnostics._internals.profileTimeoutMs = prevTimeout;
  }
});

test('installation spark via Modrinth : installe le jar et signale redémarrage nécessaire', async () => {
  axiosGetHandler = async (url) => {
    assert.ok(url.includes('/project/spark/version'));
    return {
      data: [
        {
          version_type: 'release',
          version_number: '1.10.109-fabric',
          files: [{ primary: true, filename: 'spark-1.10.109-fabric.jar', url: 'https://cdn.modrinth.com/spark.jar' }],
          dependencies: [],
        },
      ],
    };
  };

  const inst = await apiReq('/diagnostics/spark/install', { method: 'POST' });
  assert.strictEqual(inst.status, 200);
  assert.strictEqual(inst.data.installed, true);
  assert.strictEqual(inst.data.file, 'spark-1.10.109-fabric.jar');
  assert.strictEqual(inst.data.restartRequired, true);
  assert.ok(fs.existsSync(path.join(serverRoot, 'mods', 'spark-1.10.109-fabric.jar')));

  const afterList = await apiReq('/diagnostics');
  assert.strictEqual(afterList.data.spark.installed, true);
  assert.strictEqual(afterList.data.spark.file, 'spark-1.10.109-fabric.jar');
});
