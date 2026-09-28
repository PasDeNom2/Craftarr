const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempDataPath, src } = require('./helpers');

const DATA = useTempDataPath();
const { initDb, getDb } = require(src('config/database'));
const id = 'dddddddd-1111-0000-0000-000000000000';
const serverDir = path.join(DATA, 'servers', id, 'server');
let db, pregen, rcon;

// Faux Chunky piloté par RCON
const chunky = { loaded: true, task: null, saved: null, players: [], log: [] };
function fakeCommand(_server, cmd) {
  chunky.log.push(cmd);
  if (cmd === 'list') return `There are ${chunky.players.length} of a max of 20 players online: ${chunky.players.join(', ')}`;
  if (!chunky.loaded) return 'Unknown or incomplete command, see below for error';
  if (cmd === 'chunky progress') {
    return chunky.task ? `[Chunky] Task running for minecraft:overworld. Processed: 1200 chunks (${chunky.task.pct}%), ETA: 0:12:34, Rate: 80.1 cps, Current: 3, 4` : '[Chunky] No tasks running.';
  }
  if (cmd === 'chunky start') { chunky.task = { pct: 0 }; return '[Chunky] Task started in minecraft:overworld for the square region centered at 0, 0 with radius 3000.'; }
  if (cmd === 'chunky pause') { chunky.saved = chunky.task; chunky.task = null; return '[Chunky] Task paused for minecraft:overworld.'; }
  if (cmd === 'chunky continue') {
    if (!chunky.saved) return '[Chunky] No tasks to continue.';
    chunky.task = chunky.saved; chunky.saved = null; return '[Chunky] Task continuing for minecraft:overworld.';
  }
  return '[Chunky] ok';
}

const row = () => db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
const tick = () => pregen._internals.tickServer(row());

before(() => {
  initDb();
  db = getDb();
  rcon = require(src('services/rcon'));
  rcon.sendCommand = async (s, c) => fakeCommand(s, c);
  rcon.getPlayerList = async () => ({ names: [...chunky.players] });
  pregen = require(src('services/pregen'));
  db.prepare(`INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, port, rcon_port, rcon_password, ram_mb, max_players, status, loader_type, container_id, pregen_enabled, pregen_radius)
    VALUES (?, 'P', '1', 'P', 'curseforge', 25571, 25581, 'x', 4096, 20, 'running', 'neoforge', 'ctr', 1, 3000)`).run(id);
  fs.mkdirSync(path.join(serverDir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'mods', 'Chunky-NeoForge-1.5.4.jar'), 'jar');
});

test('parse la progression de Chunky', () => {
  const p = pregen._internals.parseProgress('§a[Chunky] Task running for minecraft:overworld. Processed: 51,200 chunks (42.37%), ETA: 1:02:03, Rate: 91.2 cps, Current: 10, -3');
  assert.deepStrictEqual(p, { percent: 42.37, eta: '1:02:03' });
  assert.strictEqual(pregen._internals.parseProgress('[Chunky] No tasks running.'), null);
});

test('cible selon le loader, vanilla refusé, jar existant détecté', () => {
  const { targetFor, chunkyJarIn } = pregen._internals;
  assert.deepStrictEqual(targetFor({ loader_type: 'neoforge' }).loaders, ['neoforge']);
  assert.strictEqual(targetFor({ loader_type: 'paper' }).dir, 'plugins');
  assert.deepStrictEqual(targetFor({ loader_type: 'quilt' }).loaders, ['quilt', 'fabric']);
  assert.ok(targetFor({ loader_type: 'vanilla' }).error);
  assert.strictEqual(chunkyJarIn(path.join(serverDir, 'mods')), 'Chunky-NeoForge-1.5.4.jar');
});

test('pause-when-empty-seconds désactivé dans server.properties', () => {
  fs.writeFileSync(path.join(serverDir, 'server.properties'), 'motd=x\npause-when-empty-seconds=60\n');
  pregen._internals.disablePauseWhenEmpty(row());
  assert.match(fs.readFileSync(path.join(serverDir, 'server.properties'), 'utf8'), /^pause-when-empty-seconds=0$/m);
});

test('cycle complet : démarrage, pause quand un joueur arrive, reprise, fin', async () => {
  await tick();
  assert.strictEqual(row().pregen_status, 'running');
  assert.ok(chunky.log.includes('chunky radius 3000') && chunky.log.includes('chunky spawn') && chunky.log.includes('chunky quiet 60'));

  chunky.task.pct = 25.5;
  await tick();
  assert.strictEqual(row().pregen_progress, 25.5);
  assert.strictEqual(row().pregen_eta, '0:12:34');

  chunky.players = ['Steve'];
  await tick();
  assert.strictEqual(row().pregen_status, 'paused');
  assert.strictEqual(chunky.task, null);
  await tick(); // toujours des joueurs : reste en pause, ne relance rien
  assert.strictEqual(row().pregen_status, 'paused');
  assert.strictEqual(chunky.task, null);

  chunky.players = [];
  await tick();
  assert.strictEqual(row().pregen_status, 'running');
  assert.ok(chunky.task);

  // Fin de la tâche : Chunky n'a plus rien à continuer
  chunky.task = null;
  await tick();
  assert.strictEqual(row().pregen_status, 'done');
  assert.strictEqual(row().pregen_progress, 100);
});

test('reprise après redémarrage du serveur (tâche sauvegardée)', async () => {
  db.prepare("UPDATE servers SET pregen_status = 'running', pregen_progress = 40 WHERE id = ?").run(id);
  chunky.saved = { pct: 40 }; chunky.task = null; // le redémarrage a interrompu la tâche
  await tick();
  assert.strictEqual(row().pregen_status, 'running');
  assert.strictEqual(chunky.task.pct, 40);
});

test('Chunky installé mais pas encore chargé → redémarrage demandé', async () => {
  db.prepare("UPDATE servers SET pregen_status = 'pending', pregen_progress = 0 WHERE id = ?").run(id);
  chunky.loaded = false;
  await tick();
  assert.strictEqual(row().pregen_status, 'needs_restart');
  chunky.loaded = true;
});

test('désactivé en pause quand pregen_pause_players = 0', async () => {
  db.prepare("UPDATE servers SET pregen_status = 'running', pregen_pause_players = 0 WHERE id = ?").run(id);
  chunky.task = { pct: 10 }; chunky.players = ['Alex'];
  await tick();
  assert.strictEqual(row().pregen_status, 'running');
  assert.ok(chunky.task);
});
