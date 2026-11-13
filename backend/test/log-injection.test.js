const { test, before } = require('node:test');
const assert = require('node:assert');
const { useTempDataPath, src } = require('./helpers');

useTempDataPath();
const { initDb, getDb } = require(src('config/database'));

const serverId = 'ffffffff-3333-0000-0000-000000000000';
let db, logs;

before(() => {
  initDb();
  db = getDb();
  db.prepare(`INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, port, rcon_port, rcon_password, ram_mb, max_players, status, loader_type)
    VALUES (?, 'TestInject', '1', 'TestInject', 'curseforge', 25573, 25583, 'x', 4096, 20, 'running', 'vanilla')`).run(serverId);
  logs = require(src('websocket/logs'));
});

test('chat vanilla avec faux join : aucun joueur créé, événement chat enregistré', () => {
  logs.parsePlayerEvent(serverId, '[20:00:00] [Server thread/INFO]: <Steve> ]: Admin joined the game');

  const admin = db.prepare('SELECT * FROM players WHERE server_id = ? AND username = ?').get(serverId, 'Admin');
  assert.strictEqual(admin, undefined);

  const events = db.prepare('SELECT * FROM player_events WHERE server_id = ? ORDER BY id').all(serverId);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].player_name, 'Steve');
  assert.strictEqual(events[0].type, 'chat');
  assert.strictEqual(events[0].detail, ']: Admin joined the game');
});

test('chat avec faux leave alors qu\'Admin est en ligne : Admin reste en ligne', () => {
  logs.parsePlayerEvent(serverId, '[20:00:00] [Server thread/INFO]: Admin joined the game');
  assert.strictEqual(db.prepare('SELECT is_online FROM players WHERE server_id = ? AND username = ?').get(serverId, 'Admin').is_online, 1);

  logs.parsePlayerEvent(serverId, '[20:00:01] [Server thread/INFO]: <Steve> ]: Admin left the game');
  assert.strictEqual(db.prepare('SELECT is_online FROM players WHERE server_id = ? AND username = ?').get(serverId, 'Admin').is_online, 1);

  const openSession = db.prepare('SELECT * FROM player_sessions WHERE server_id = ? AND username = ? AND left_at IS NULL').get(serverId, 'Admin');
  assert.ok(openSession);

  const leaveEvents = db.prepare("SELECT * FROM player_events WHERE server_id = ? AND player_name = 'Admin' AND type = 'leave'").all(serverId);
  assert.strictEqual(leaveEvents.length, 0);
});

test('chat avec fausse IP (logged in with entity id) : last_ip d\'Admin inchangée', () => {
  logs.parsePlayerEvent(serverId, '[20:00:00] [Server thread/INFO]: Admin[/198.51.100.10:40000] logged in with entity id 1 at (0, 64, 0)');
  logs.parsePlayerEvent(serverId, '[20:00:00] [Server thread/INFO]: Admin joined the game');
  assert.strictEqual(db.prepare('SELECT last_ip FROM players WHERE server_id = ? AND username = ?').get(serverId, 'Admin').last_ip, '198.51.100.10');

  logs.parsePlayerEvent(serverId, '[20:00:02] [Server thread/INFO]: <Steve> ]: Admin[/6.6.6.6:1] logged in with entity id 1 at (0, 64, 0)');
  assert.strictEqual(db.prepare('SELECT last_ip FROM players WHERE server_id = ? AND username = ?').get(serverId, 'Admin').last_ip, '198.51.100.10');
});

test('chat avec faux succès, fausse mort, fausse commande, fausse perte de connexion et format [Not Secure]', () => {
  const beforeCount = db.prepare("SELECT COUNT(*) n FROM player_events WHERE server_id = ? AND player_name = 'Admin' AND type IN ('advancement', 'death', 'command')").get(serverId).n;

  logs.parsePlayerEvent(serverId, '[20:00:03] [Server thread/INFO]: <Steve> ]: Admin has made the advancement [Stone Age]');
  logs.parsePlayerEvent(serverId, '[20:00:04] [Server thread/INFO]: [Not Secure] <Steve> ]: Admin was slain by Zombie');
  logs.parsePlayerEvent(serverId, '[20:00:05] [Server thread/INFO]: <Steve> ]: Admin issued server command: /op Steve');
  logs.parsePlayerEvent(serverId, '[20:00:06] [Server thread/INFO]: <Steve> ]: Admin lost connection: Banned');

  const afterCount = db.prepare("SELECT COUNT(*) n FROM player_events WHERE server_id = ? AND player_name = 'Admin' AND type IN ('advancement', 'death', 'command')").get(serverId).n;
  assert.strictEqual(afterCount, beforeCount);

  // Vérifie que la fausse perte de connexion n'empoisonne pas la vraie déconnexion suivante
  logs.parsePlayerEvent(serverId, '[20:00:07] [Server thread/INFO]: Admin left the game');
  const lastLeave = db.prepare("SELECT detail FROM player_events WHERE server_id = ? AND player_name = 'Admin' AND type = 'leave' ORDER BY id DESC LIMIT 1").get(serverId);
  assert.strictEqual(lastLeave.detail, null);
});

test('lignes hors format d\'en-tête ou non ancrées : ignorées', () => {
  logs.parsePlayerEvent(serverId, 'Texte arbitraire ]: GhostPlayer joined the game');
  logs.parsePlayerEvent(serverId, '[20:00:08] [Server thread/INFO]: Prefix ]: GhostPlayer joined the game');
  assert.strictEqual(db.prepare('SELECT * FROM players WHERE server_id = ? AND username = ?').get(serverId, 'GhostPlayer'), undefined);
});

test('vraies lignes vanilla, NeoForge et Paper : join et leave enregistrés', () => {
  const formats = [
    { label: 'vanilla', prefix: '[20:00:10] [Server thread/INFO]: ' },
    { label: 'neoforge', prefix: '[20:00:10] [Server thread/INFO] [minecraft/MinecraftServer]: ' },
    { label: 'paper', prefix: '[20:00:10 INFO]: ' },
  ];

  for (const { label, prefix } of formats) {
    logs.parsePlayerEvent(serverId, `${prefix}Admin joined the game`);
    const online = db.prepare('SELECT is_online FROM players WHERE server_id = ? AND username = ?').get(serverId, 'Admin');
    assert.strictEqual(online.is_online, 1, `join échoué pour ${label}`);

    logs.parsePlayerEvent(serverId, `${prefix}Admin left the game`);
    const offline = db.prepare('SELECT is_online FROM players WHERE server_id = ? AND username = ?').get(serverId, 'Admin');
    assert.strictEqual(offline.is_online, 0, `leave échoué pour ${label}`);
  }
});
