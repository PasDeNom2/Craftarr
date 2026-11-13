// Sauvegardes hors site (restic) : activation par serveur et historique des exécutions.
module.exports = [
  'ALTER TABLE servers ADD COLUMN offsite_enabled INTEGER NOT NULL DEFAULT 0',
  `CREATE TABLE IF NOT EXISTS offsite_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    snapshot_id TEXT,
    added_bytes INTEGER DEFAULT 0,
    message TEXT,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  )`,
  'CREATE INDEX IF NOT EXISTS idx_offsite_runs_server ON offsite_runs(server_id, id DESC)',
];
