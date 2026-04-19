const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_PATH = process.env.DATA_PATH || '/data';
const DB_PATH = path.join(DATA_PATH, 'craftarr.db');

let db;

function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

function initDb() {
  fs.mkdirSync(DATA_PATH, { recursive: true });
  fs.mkdirSync(path.join(DATA_PATH, 'servers'), { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  // Migrations pour colonnes ajoutées après la création initiale
  const migrations = [
    "ALTER TABLE servers ADD COLUMN motd TEXT",
    "ALTER TABLE servers ADD COLUMN online_mode INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE servers ADD COLUMN difficulty TEXT NOT NULL DEFAULT 'normal'",
    "ALTER TABLE servers ADD COLUMN view_distance INTEGER NOT NULL DEFAULT 10",
    "ALTER TABLE servers ADD COLUMN spawn_protection INTEGER NOT NULL DEFAULT 16",
    `CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      username TEXT NOT NULL,
      uuid TEXT,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen TEXT NOT NULL DEFAULT (datetime('now')),
      is_banned INTEGER NOT NULL DEFAULT 0,
      ban_reason TEXT,
      UNIQUE(server_id, username),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS player_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      player_name TEXT NOT NULL,
      type TEXT NOT NULL,
      detail TEXT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )`,
    "ALTER TABLE servers ADD COLUMN needs_recreate INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE players ADD COLUMN is_banned INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE players ADD COLUMN ban_reason TEXT",
    "ALTER TABLE players ADD COLUMN is_online INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE players ADD COLUMN is_op INTEGER NOT NULL DEFAULT 0",
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* colonne déjà présente */ }
  }

  console.log(`[DB] SQLite initialized at ${DB_PATH}`);
  return db;
}

module.exports = { getDb, initDb };
