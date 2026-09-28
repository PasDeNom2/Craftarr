// Base créée par une ancienne version : player_events.created_at au lieu de timestamp.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Database = require('better-sqlite3');
const { useTempDataPath, src } = require('./helpers');

const DATA = useTempDataPath();

test('ancienne base : colonne renommée, sessions reconstituées, démarrage sans erreur', () => {
  const old = new Database(path.join(DATA, 'craftarr.db'));
  old.exec(require('fs').readFileSync(src('config/schema.sql'), 'utf8'));
  old.prepare("INSERT INTO servers (id, name, modpack_id, modpack_name, modpack_source, rcon_password) VALUES ('s1', 'S', '1', 'S', 'curseforge', 'x')").run();
  old.exec(`CREATE TABLE player_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, server_id TEXT NOT NULL, player_name TEXT NOT NULL,
    type TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const ins = old.prepare('INSERT INTO player_events (server_id, player_name, type, created_at) VALUES (?, ?, ?, ?)');
  ins.run('s1', 'Steve', 'join', '2026-09-27 18:00:00');
  ins.run('s1', 'Steve', 'leave', '2026-09-27 19:30:00');
  ins.run('s1', 'Alex', 'join', '2026-09-27 18:10:00'); // jamais reparti : ignoré
  ins.run('supprime', 'Bob', 'join', '2026-09-26 10:00:00'); // serveur supprimé depuis
  ins.run('supprime', 'Bob', 'leave', '2026-09-26 11:00:00');
  old.close();

  const { initDb } = require(src('config/database'));
  const db = initDb();
  const cols = db.prepare('PRAGMA table_info(player_events)').all().map(c => c.name);
  assert.ok(cols.includes('timestamp') && !cols.includes('created_at'), cols.join(','));
  const sessions = db.prepare('SELECT * FROM player_sessions').all();
  assert.deepStrictEqual(sessions.map(s => [s.username, s.joined_at, s.left_at]), [['Steve', '2026-09-27 18:00:00', '2026-09-27 19:30:00']]);
});
