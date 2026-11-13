// Migration C1 : rôles, comptes multiples, 2FA, permissions par serveur et journal d'activité.
module.exports = [
  "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'",
  "ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN totp_secret TEXT",
  "ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN recovery_codes TEXT",
  "ALTER TABLE users ADD COLUMN last_login_at TEXT",
  "ALTER TABLE users ADD COLUMN totp_last_step INTEGER",
  `CREATE TABLE IF NOT EXISTS server_permissions (
    user_id TEXT NOT NULL,
    server_id TEXT NOT NULL,
    perms TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, server_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    user_id TEXT,
    username TEXT,
    ip TEXT,
    action TEXT NOT NULL,
    server_id TEXT,
    status INTEGER,
    details TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS idx_activity_at ON activity_log(at)",
  "CREATE INDEX IF NOT EXISTS idx_activity_server_at ON activity_log(server_id, at)",
];
