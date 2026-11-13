module.exports = [
  `CREATE TABLE IF NOT EXISTS server_profiles (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    name TEXT NOT NULL,
    modpack_id TEXT,
    modpack_name TEXT,
    modpack_source TEXT,
    modpack_version TEXT,
    modpack_version_id TEXT,
    modpack_download_url TEXT,
    mc_version TEXT,
    loader_type TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  )`,
  // URL du pack (MODPACK= pour itzg) : conservée avec le profil pour une bascule sans perte
  'ALTER TABLE server_profiles ADD COLUMN modpack_download_url TEXT',
  'CREATE INDEX IF NOT EXISTS idx_server_profiles_server ON server_profiles(server_id)',
  'ALTER TABLE servers ADD COLUMN active_profile_name TEXT',
];
