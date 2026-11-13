const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { useTempDataPath, src } = require('./helpers');

useTempDataPath();
const { initDb, getDb } = require(src('config/database'));
const docker = require(src('services/docker'));
const rcon = require(src('services/rcon'));
const metrics = require(src('services/metrics'));

let db;
let origGetContainerStats;
let origGetServerStats;

function createFakeIo(watchedIds = new Set()) {
  const emits = [];
  const io = {
    emits,
    in(room) {
      const serverId = room.replace(/^server:/, '');
      return {
        async fetchSockets() {
          return watchedIds.has(serverId) ? [{ id: `sock-${serverId}` }] : [];
        },
      };
    },
    to(room) {
      return {
        emit(event, payload) {
          emits.push({ room, event, payload });
        },
      };
    },
  };
  return io;
}

function insertServer({
  id,
  status = 'running',
  containerId = `cid-${id}`,
  port = 25565,
  rconPort = 25575,
  maxPlayers = 20,
}) {
  db.prepare(`INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, container_id, container_name, port, rcon_port, rcon_password, ram_mb, max_players, status, loader_type)
    VALUES (?, ?, '1', 'Pack', 'curseforge', ?, ?, ?, ?, 'secret', 4096, ?, ?, 'neoforge')`)
    .run(id, `Serveur-${id}`, containerId, `mc-${id}`, port, rconPort, maxPlayers, status);
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

before(() => {
  initDb();
  db = getDb();
  origGetContainerStats = docker.getContainerStats;
  origGetServerStats = rcon.getServerStats;
});

beforeEach(() => {
  db.prepare('DELETE FROM servers').run();
});

afterEach(() => {
  metrics.stopPolling();
  metrics.setIo(null);
  docker.getContainerStats = origGetContainerStats;
  rcon.getServerStats = origGetServerStats;
});

after(() => {
  metrics.stopPolling();
  docker.getContainerStats = origGetContainerStats;
  rcon.getServerStats = origGetServerStats;
});

test('3 serveurs running en parallèle (< 500 ms) sans 2 appels simultanés pour le même serveur', async () => {
  insertServer({ id: 's1', port: 25565, rconPort: 25575 });
  insertServer({ id: 's2', port: 25566, rconPort: 25576 });
  insertServer({ id: 's3', port: 25567, rconPort: 25577 });
  insertServer({ id: 's-unwatched', port: 25568, rconPort: 25578 });

  const io = createFakeIo(new Set(['s1', 's2', 's3']));
  let resolveFirstTour;
  const firstTourDone = new Promise(r => { resolveFirstTour = r; });
  const baseTo = io.to.bind(io);
  io.to = (room) => {
    const target = baseTo(room);
    return {
      emit(event, payload) {
        target.emit(event, payload);
        if (io.emits.length === 3) resolveFirstTour();
      },
    };
  };
  metrics.setIo(io);

  const activeByContainer = new Map();
  let maxPerContainer = 0;
  let totalActive = 0;
  let maxTotalActive = 0;
  const calledContainers = [];

  docker.getContainerStats = async (containerId) => {
    calledContainers.push(containerId);
    const active = (activeByContainer.get(containerId) || 0) + 1;
    activeByContainer.set(containerId, active);
    if (active > maxPerContainer) maxPerContainer = active;
    totalActive++;
    if (totalActive > maxTotalActive) maxTotalActive = totalActive;

    await wait(300);

    activeByContainer.set(containerId, activeByContainer.get(containerId) - 1);
    totalActive--;
    return { cpu: 12.5, memUsed: 1024, memLimit: 4096, memPercent: 25 };
  };
  rcon.getServerStats = async (server) => ({
    players: { online: 1, max: server.max_players },
    tps: { tps1: 20, tps5: 20, tps15: 20 },
  });

  const start = Date.now();
  metrics.startPolling({ dockerMs: 10, rconMs: 10000 });
  await firstTourDone;
  const elapsed = Date.now() - start;
  metrics.stopPolling();

  assert.ok(elapsed < 500, `Tour trop lent (${elapsed} ms >= 500 ms) — exécution non parallèle ?`);
  assert.strictEqual(maxPerContainer, 1);
  assert.strictEqual(maxTotalActive, 3);
  assert.strictEqual(io.emits.length, 3);
  assert.ok(!calledContainers.includes('cid-s-unwatched'));
});

test('les tours consécutifs ne se chevauchent pas même si un tour dépasse dockerMs', async () => {
  insertServer({ id: 's1', port: 25565, rconPort: 25575 });
  insertServer({ id: 's2', port: 25566, rconPort: 25576 });

  const io = createFakeIo(new Set(['s1', 's2']));
  let resolveTwoTours;
  const twoToursDone = new Promise(r => { resolveTwoTours = r; });
  const baseTo = io.to.bind(io);
  io.to = (room) => {
    const target = baseTo(room);
    return {
      emit(event, payload) {
        target.emit(event, payload);
        if (io.emits.length === 4) resolveTwoTours();
      },
    };
  };
  metrics.setIo(io);

  const activeByContainer = new Map();
  let maxPerContainer = 0;

  docker.getContainerStats = async (containerId) => {
    const active = (activeByContainer.get(containerId) || 0) + 1;
    activeByContainer.set(containerId, active);
    if (active > maxPerContainer) maxPerContainer = active;
    await wait(80);
    activeByContainer.set(containerId, activeByContainer.get(containerId) - 1);
    return { cpu: 5, memUsed: 512, memLimit: 4096, memPercent: 13 };
  };
  rcon.getServerStats = async (server) => ({
    players: { online: 0, max: server.max_players },
    tps: null,
  });

  metrics.startPolling({ dockerMs: 15, rconMs: 10000 });
  await twoToursDone;
  metrics.stopPolling();

  assert.strictEqual(maxPerContainer, 1);
  assert.strictEqual(io.emits.length, 4);
});

test('un serveur stopped ne déclenche aucun appel à getContainerStats et émet des métriques à zéro', async () => {
  insertServer({ id: 's-stopped', status: 'stopped', containerId: 'cid-stopped', maxPlayers: 24, port: 25565, rconPort: 25575 });
  insertServer({ id: 's-starting', status: 'starting', containerId: 'cid-starting', maxPlayers: 20, port: 25566, rconPort: 25576 });

  const io = createFakeIo(new Set(['s-stopped', 's-starting']));
  metrics.setIo(io);

  const calledContainers = [];
  docker.getContainerStats = async (containerId) => {
    calledContainers.push(containerId);
    return { cpu: 40, memUsed: 2048, memLimit: 4096, memPercent: 50 };
  };

  await metrics._internals.pollDockerStats();

  assert.deepStrictEqual(calledContainers, ['cid-starting']);
  const stoppedEmit = io.emits.find(e => e.room === 'server:s-stopped');
  assert.ok(stoppedEmit, 'Un événement metrics doit être émis pour le serveur stopped');
  assert.strictEqual(stoppedEmit.event, 'metrics');
  assert.strictEqual(stoppedEmit.payload.serverId, 's-stopped');
  assert.strictEqual(stoppedEmit.payload.cpu, 0);
  assert.strictEqual(stoppedEmit.payload.memUsed, 0);
  assert.strictEqual(stoppedEmit.payload.memLimit, 0);
  assert.strictEqual(stoppedEmit.payload.memPercent, 0);
  assert.strictEqual(stoppedEmit.payload.uptime, null);
  assert.deepStrictEqual(stoppedEmit.payload.players, { online: 0, max: 24 });
  assert.strictEqual(stoppedEmit.payload.tps, null);
});

test('garde anti-réentrance : un appel lancé pendant un tour en cours est ignoré', async () => {
  insertServer({ id: 's1', status: 'running', containerId: 'cid-s1' });
  const io = createFakeIo(new Set(['s1']));
  metrics.setIo(io);

  let releaseStats;
  let calls = 0;
  docker.getContainerStats = () => {
    calls++;
    return new Promise(resolve => {
      releaseStats = () => resolve({ cpu: 10, memUsed: 500, memLimit: 2000, memPercent: 25 });
    });
  };

  const firstTour = metrics._internals.pollDockerStats();
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(calls, 1);

  // Deuxième appel pendant que le premier tour attend encore Docker : doit être ignoré
  await metrics._internals.pollDockerStats();
  assert.strictEqual(calls, 1);

  releaseStats();
  await firstTour;
  assert.strictEqual(io.emits.length, 1);
});

test('après stopPolling(), plus aucun appel Docker ni RCON ne se produit', async () => {
  insertServer({ id: 's1', status: 'running', containerId: 'cid-s1' });
  const io = createFakeIo(new Set(['s1']));
  metrics.setIo(io);

  let dockerCalls = 0;
  let rconCalls = 0;
  docker.getContainerStats = async () => {
    dockerCalls++;
    return { cpu: 1, memUsed: 100, memLimit: 1000, memPercent: 10 };
  };
  rcon.getServerStats = async (server) => {
    rconCalls++;
    return { players: { online: 2, max: server.max_players }, tps: { tps1: 20, tps5: 20, tps15: 20 } };
  };

  metrics.startPolling({ dockerMs: 30, rconMs: 30 });

  const deadline = Date.now() + 2000;
  while ((dockerCalls < 1 || rconCalls < 1) && Date.now() < deadline) {
    await wait(5);
  }
  assert.ok(dockerCalls >= 1 && rconCalls >= 1, 'Les deux boucles doivent avoir tourné avant stopPolling()');

  metrics.stopPolling();
  // Laisse se terminer les microtasks déjà lancées avant de figer les compteurs
  await new Promise(resolve => setImmediate(resolve));
  const dockerAtStop = dockerCalls;
  const rconAtStop = rconCalls;

  // Attend plus de 2 intervalles complets
  await wait(100);

  assert.strictEqual(dockerCalls, dockerAtStop);
  assert.strictEqual(rconCalls, rconAtStop);
});

test('pushImmediate émet les métriques sans appeler Docker pour un serveur stopped', async () => {
  insertServer({ id: 's-stop', status: 'stopped', containerId: 'cid-stop', maxPlayers: 16, port: 25565, rconPort: 25575 });
  insertServer({ id: 's-run', status: 'running', containerId: 'cid-run', maxPlayers: 16, port: 25566, rconPort: 25576 });

  const called = [];
  docker.getContainerStats = async (containerId) => {
    called.push(containerId);
    return { cpu: 33.3, memUsed: 800, memLimit: 4000, memPercent: 20 };
  };

  const events = [];
  const fakeSocket = { emit: (event, payload) => events.push({ event, payload }) };

  await metrics.pushImmediate(fakeSocket, 's-stop');
  await metrics.pushImmediate(fakeSocket, 's-run');

  assert.deepStrictEqual(called, ['cid-run']);
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].payload.cpu, 0);
  assert.strictEqual(events[1].payload.cpu, 33.3);
});
