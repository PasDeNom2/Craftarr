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
    // Anciennes bases : la date des événements s'appelait created_at
    "ALTER TABLE player_events RENAME COLUMN created_at TO timestamp",
    // Joueurs : sessions (connexion → déconnexion) et dernière IP
    `CREATE TABLE IF NOT EXISTS player_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      username TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      left_at TEXT,
      reason TEXT,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )`,
    "CREATE INDEX IF NOT EXISTS idx_sessions_server ON player_sessions(server_id, joined_at)",
    "CREATE INDEX IF NOT EXISTS idx_sessions_player ON player_sessions(server_id, username)",
    "CREATE INDEX IF NOT EXISTS idx_events_player ON player_events(server_id, player_name, id)",
    "ALTER TABLE players ADD COLUMN last_ip TEXT",
    // Pré-génération du monde (Chunky)
    "ALTER TABLE servers ADD COLUMN pregen_enabled INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE servers ADD COLUMN pregen_radius INTEGER NOT NULL DEFAULT 3000",
    "ALTER TABLE servers ADD COLUMN pregen_pause_players INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE servers ADD COLUMN pregen_status TEXT",
    "ALTER TABLE servers ADD COLUMN pregen_progress REAL NOT NULL DEFAULT 0",
    "ALTER TABLE servers ADD COLUMN pregen_eta TEXT",
    "ALTER TABLE servers ADD COLUMN pregen_message TEXT",
    // Dimensions à pré-générer (liste séparée par des virgules) et index de celle en cours
    "ALTER TABLE servers ADD COLUMN pregen_worlds TEXT NOT NULL DEFAULT 'minecraft:overworld'",
    "ALTER TABLE servers ADD COLUMN pregen_world_index INTEGER NOT NULL DEFAULT 0",
    // Incrémenté à chaque changement de mot de passe : invalide toutes les sessions ouvertes
    "ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0",
    // Réglages globaux modifiables dans l'interface (webhook de notifications…)
    "CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)",
  ];
  for (const sql of migrations) {
    try {
      db.exec(sql);
    } catch (err) {
      // Migrations idempotentes : seul « déjà appliquée » est normal. Toute autre erreur est
      // signalée (avant, elle était avalée et une colonne pouvait manquer sans que personne le sache).
      if (!/duplicate column|already exists|no such column/i.test(err.message)) {
        console.error(`[DB] Migration en échec : ${sql.trim().slice(0, 80)} — ${err.message}`);
      }
    }
  }
  // Jamais bloquant : un historique non reconstitué ne doit pas empêcher Craftarr de démarrer
  try { backfillSessions(db); } catch (err) { console.error('[DB] Reconstitution des sessions impossible :', err.message); }

  console.log(`[DB] SQLite initialized at ${DB_PATH}`);
  return db;
}

/**
 * Reconstitue les sessions à partir des anciens événements join/leave (une seule fois, quand la
 * table des sessions est vide). Une connexion sans déconnexion connue est ignorée (durée inconnue).
 */
function backfillSessions(db) {
  if (db.prepare('SELECT COUNT(*) n FROM player_sessions').get().n > 0) return;
  const events = db.prepare("SELECT server_id, player_name, type, detail, timestamp FROM player_events WHERE type IN ('join', 'leave') AND server_id IN (SELECT id FROM servers) ORDER BY id").all();
  if (!events.length) return;
  const open = new Map();
  const insert = db.prepare('INSERT INTO player_sessions (server_id, username, joined_at, left_at, reason) VALUES (?, ?, ?, ?, ?)');
  db.transaction(() => {
    for (const e of events) {
      const k = e.server_id + '|' + e.player_name;
      if (e.type === 'join') {
        // Connexion précédente sans déconnexion connue : durée inconnue, on l'ignore
        open.set(k, e.timestamp);
      } else if (open.has(k)) {
        insert.run(e.server_id, e.player_name, open.get(k), e.timestamp, e.detail || null);
        open.delete(k);
      }
    }
  })();
  console.log(`[DB] Sessions joueurs reconstituées depuis ${events.length} événements`);
}

module.exports = { getDb, initDb };
