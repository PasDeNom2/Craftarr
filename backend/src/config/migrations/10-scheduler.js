// Migrations SQLite pour le planificateur de tâches par serveur.
module.exports = [
  `CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    trigger_type TEXT NOT NULL,
    cron TEXT,
    interval_minutes INTEGER,
    event TEXT,
    only_if_players TEXT NOT NULL DEFAULT 'any',
    steps_json TEXT NOT NULL DEFAULT '[]',
    last_run_at TEXT,
    next_run_at TEXT,
    last_status TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS schedule_runs (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    message TEXT,
    FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE
  )`,
  'CREATE INDEX IF NOT EXISTS idx_schedules_server ON schedules(server_id)',
  'CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, trigger_type, next_run_at)',
  'CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule ON schedule_runs(schedule_id, started_at DESC)',
];
