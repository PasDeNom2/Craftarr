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
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* colonne déjà présente */ }
  }

  console.log(`[DB] SQLite initialized at ${DB_PATH}`);
  return db;
}

module.exports = { getDb, initDb };
