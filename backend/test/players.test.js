const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempDataPath, src } = require('./helpers');

const DATA = useTempDataPath();
const { initDb, getDb } = require(src('config/database'));
const id = 'eeeeeeee-2222-0000-0000-000000000000';
let db, logs, server, base, token;

const line = msg => `[20:00:00] [Server thread/INFO] [minecraft/MinecraftServer]: ${msg}`;
const feed = (...msgs) => msgs.forEach(m => logs.parsePlayerEvent(id, line(m)));
const sessions = user => db.prepare('SELECT * FROM player_sessions WHERE server_id = ? AND username = ? ORDER BY id').all(id, user);

before(async () => {
  initDb();
  db = getDb();
  db.prepare(`INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, port, rcon_port, rcon_password, ram_mb, max_players, status, loader_type)
    VALUES (?, 'J', '1', 'J', 'curseforge', 25572, 25582, 'x', 4096, 20, 'running', 'neoforge')`).run(id);
  logs = require(src('websocket/logs'));

  // Routes montées sur une petite app Express avec un vrai jeton
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/servers', require(src('routes/servers/players')));
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/servers/${id}`;
  const { getJwtSecret, loadOrCreateSecrets } = require(src('config/secrets'));
  loadOrCreateSecrets?.();
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES ('u1', 'admin', 'x')").run();
  token = require('jsonwebtoken').sign({ id: 'u1', username: 'admin' }, getJwtSecret(), { expiresIn: '5m' });
});
after(() => server?.close());

const get = async p => (await fetch(base + p, { headers: { Authorization: `Bearer ${token}` } })).json();

test('connexion : IP, session ouverte ; déconnexion : raison et session close', () => {
  feed('UUID of player Steve is 11111111-2222-3333-4444-555555555555',
    'Steve[/203.0.113.7:51234] logged in with entity id 42 at (1.5, 64.0, -3.2)',
    'Steve joined the game');
  const p = db.prepare('SELECT * FROM players WHERE username = ?').get('Steve');
  assert.strictEqual(p.is_online, 1);
  assert.strictEqual(p.last_ip, '203.0.113.7');
  assert.strictEqual(p.uuid, '11111111-2222-3333-4444-555555555555');
  assert.strictEqual(sessions('Steve').length, 1);
  assert.strictEqual(sessions('Steve')[0].left_at, null);

  feed('Steve lost connection: Timed out', 'Steve left the game');
  const s = sessions('Steve')[0];
  assert.ok(s.left_at);
  assert.strictEqual(s.reason, 'Timed out');
  const leave = db.prepare("SELECT detail FROM player_events WHERE type = 'leave' AND player_name = 'Steve'").get();
  assert.strictEqual(leave.detail, 'Timed out');
});

test('chat « [Not Secure] », succès et mort enregistrés', () => {
  feed('Steve joined the game', '[Not Secure] <Steve> salut tout le monde',
    'Steve has made the advancement [Stone Age]', 'Steve has completed the challenge [Monsters Hunted]',
    'Steve was slain by Zombie');
  const types = db.prepare("SELECT type, detail FROM player_events WHERE player_name = 'Steve' AND type IN ('chat','advancement','death') ORDER BY id").all();
  assert.deepStrictEqual(types.map(t => t.type), ['chat', 'advancement', 'advancement', 'death']);
  assert.strictEqual(types[0].detail, 'salut tout le monde');
  assert.strictEqual(types[1].detail, 'Stone Age');
});

test('arrêt du serveur : sessions ouvertes closes, joueurs hors ligne', () => {
  feed('Alex joined the game');
  logs.closeAllSessions(id, 'server_stop');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM player_sessions WHERE left_at IS NULL').get().n, 0);
  assert.strictEqual(sessions('Alex')[0].reason, 'server_stop');
  assert.strictEqual(db.prepare("SELECT is_online FROM players WHERE username = 'Alex'").get().is_online, 0);
});

test('reconnexion sans déconnexion vue : l\'ancienne session est close', () => {
  feed('Alex joined the game', 'Alex joined the game');
  const s = sessions('Alex');
  assert.strictEqual(s.length, 3);
  assert.ok(s[1].left_at && s[1].reason === 'unknown');
  assert.strictEqual(s[2].left_at, null);
});

test('routes : liste enrichie, vue d\'ensemble, profil, filtre du journal', async () => {
  // Session passée de 2 h pour Steve, qui chevauche une session d'Alex
  db.prepare("INSERT INTO player_sessions (server_id, username, joined_at, left_at) VALUES (?, 'Alex', datetime('now', '-2 hours'), datetime('now', '-90 minutes'))").run(id);
  db.prepare("INSERT INTO player_sessions (server_id, username, joined_at, left_at) VALUES (?, 'Steve', datetime('now', '-3 hours'), datetime('now', '-1 hours'))").run(id);
  const list = await get('/players');
  const steve = list.find(p => p.username === 'Steve');
  assert.ok(steve.playtime_seconds >= 7200, JSON.stringify(steve));
  assert.strictEqual(steve.death_count, 1);
  assert.ok(list.find(p => p.username === 'Alex').online_since);

  const ov = await get('/players/overview?days=7');
  assert.strictEqual(ov.totals.players, 2);
  assert.ok(ov.totals.peak >= 2, JSON.stringify(ov.totals));
  assert.ok(ov.sessions.length >= 4);
  assert.strictEqual(ov.totals.advancements, 2);

  const prof = await get('/players/Steve/profile');
  assert.strictEqual(prof.player.last_ip, '203.0.113.7');
  assert.ok(prof.sessions.count >= 2 && prof.sessions.longest >= 7200);
  assert.strictEqual(prof.eventCounts.advancement, 2);
  assert.strictEqual(prof.world.uuid, '11111111-2222-3333-4444-555555555555');

  const chats = await get('/players/Steve/events?type=chat,death');
  assert.deepStrictEqual(chats.map(e => e.type).sort(), ['chat', 'death']);
  const search = await get('/players/Steve/events?q=salut');
  assert.strictEqual(search.length, 1);
});

test('données du monde : stats, succès et fichier joueur (disposition 26.x)', async () => {
  const w = path.join(DATA, 'servers', id, 'server', 'world', 'players');
  const uuid = '11111111-2222-3333-4444-555555555555';
  fs.mkdirSync(path.join(w, 'stats'), { recursive: true });
  fs.mkdirSync(path.join(w, 'advancements'), { recursive: true });
  fs.mkdirSync(path.join(w, 'data'), { recursive: true });
  fs.writeFileSync(path.join(w, 'stats', `${uuid}.json`), JSON.stringify({ stats: {
    'minecraft:custom': { 'minecraft:play_time': 72000, 'minecraft:deaths': 3, 'minecraft:walk_one_cm': 150000, 'minecraft:fall_one_cm': 9999 },
    'minecraft:mined': { 'minecraft:stone': 50, 'minecraft:dirt': 10 },
  }, DataVersion: 4790 }));
  fs.writeFileSync(path.join(w, 'advancements', `${uuid}.json`), JSON.stringify({
    'minecraft:story/mine_stone': { criteria: { get_stone: '2026-09-27 16:04:47 +0000' }, done: true },
    'minecraft:recipes/misc/x': { criteria: {}, done: true },
    'minecraft:story/smelt_iron': { criteria: {}, done: false },
    DataVersion: 4790,
  }));
  const { serializeNbt, T } = require(src('services/nbt'));
  const item = (slot, iid, count, extra = []) => [['Slot', { type: T.BYTE, value: slot }], ['id', { type: T.STRING, value: iid }], ['count', { type: T.INT, value: count }], ...extra];
  const root = { type: T.COMPOUND, value: [
    ['Health', { type: T.FLOAT, value: 18 }],
    ['foodLevel', { type: T.INT, value: 17 }],
    ['XpLevel', { type: T.INT, value: 12 }],
    ['playerGameType', { type: T.INT, value: 0 }],
    ['Dimension', { type: T.STRING, value: 'minecraft:the_nether' }],
    ['Pos', { type: T.LIST, value: { elType: T.DOUBLE, items: [10.26, 70, -5.5] } }],
    ['Inventory', { type: T.LIST, value: { elType: T.COMPOUND, items: [
      item(0, 'minecraft:diamond_sword', 1, [['components', { type: T.COMPOUND, value: [
        ['minecraft:custom_name', { type: T.COMPOUND, value: [['text', { type: T.STRING, value: 'Excalibur' }]] }],
        ['minecraft:enchantments', { type: T.COMPOUND, value: [['minecraft:sharpness', { type: T.INT, value: 5 }]] }],
      ] }]]),
      item(5, 'minecraft:torch', 64),
    ] } }],
    ['equipment', { type: T.COMPOUND, value: [['head', { type: T.COMPOUND, value: item(0, 'minecraft:iron_helmet', 1).slice(1) }]] }],
  ] };
  fs.writeFileSync(path.join(w, 'data', `${uuid}.dat`), serializeNbt({ name: '', root, compression: 'gzip' }));

  const { world } = await get('/players/Steve/profile');
  assert.deepStrictEqual(world.errors, []);
  assert.strictEqual(world.stats.playTimeSeconds, 3600);
  assert.strictEqual(world.stats.deaths, 3);
  assert.strictEqual(world.stats.distanceMeters, 1500); // la chute n'est pas comptée
  assert.strictEqual(world.stats.blocksMined, 60);
  assert.strictEqual(world.advancements.doneCount, 1);
  assert.strictEqual(world.advancements.inProgress, 1);
  const p = world.player;
  assert.strictEqual(p.health, 18);
  assert.strictEqual(p.dimension, 'minecraft:the_nether');
  assert.deepStrictEqual(p.pos, [10.3, 70, -5.5]);
  assert.strictEqual(p.inventory[0].name, 'Excalibur');
  assert.deepStrictEqual(p.inventory[0].enchants, [{ id: 'minecraft:sharpness', level: 5 }]);
  assert.strictEqual(p.inventory[1].count, 64);
  assert.strictEqual(p.equipment.head.id, 'minecraft:iron_helmet');
});

test('reconstitution des sessions depuis les anciens événements', () => {
  db.prepare('DELETE FROM player_sessions').run();
  const { initDb: reinit } = require(src('config/database'));
  // Les événements join/leave déjà présents redonnent des sessions
  reinit();
  const rows = getDb().prepare('SELECT * FROM player_sessions').all();
  assert.ok(rows.length >= 1 && rows.every(r => r.left_at), JSON.stringify(rows));
});
