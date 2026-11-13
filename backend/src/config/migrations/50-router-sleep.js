// Colonnes de veille (sleep_mode, sleep_after_minutes) et sous-domaine mc-router (hostname).
module.exports = [
  "ALTER TABLE servers ADD COLUMN sleep_mode TEXT DEFAULT 'off'",
  "ALTER TABLE servers ADD COLUMN sleep_after_minutes INTEGER DEFAULT 10",
  "ALTER TABLE servers ADD COLUMN hostname TEXT",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_hostname ON servers(hostname) WHERE hostname IS NOT NULL",
];
