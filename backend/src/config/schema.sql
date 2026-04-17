-- Craftarr Database Schema

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key_encrypted TEXT,
  format TEXT NOT NULL DEFAULT 'curseforge',  -- curseforge | modrinth | custom
  field_mapping_json TEXT,                     -- JSON mapper pour sources custom
  enabled INTEGER NOT NULL DEFAULT 1,
  is_builtin INTEGER NOT NULL DEFAULT 0,       -- sources natives (CurseForge, Modrinth)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  modpack_id TEXT NOT NULL,
  modpack_name TEXT NOT NULL,
  modpack_source TEXT NOT NULL,                -- source id
  modpack_version TEXT,
  modpack_version_id TEXT,
  modpack_download_url TEXT,
  container_id TEXT,
  container_name TEXT,
  port INTEGER NOT NULL DEFAULT 25565,
  rcon_port INTEGER NOT NULL DEFAULT 25575,
  rcon_password TEXT NOT NULL,
  ram_mb INTEGER NOT NULL DEFAULT 4096,
  max_players INTEGER NOT NULL DEFAULT 20,
  seed TEXT,
  whitelist_enabled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'installing',   -- installing|running|stopped|error|updating
  mc_version TEXT,
  loader_type TEXT,                            -- forge|fabric|quilt|neoforge|vanilla
  auto_update INTEGER NOT NULL DEFAULT 1,
  update_interval_hours INTEGER NOT NULL DEFAULT 6,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT
);

CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  path TEXT NOT NULL,
  size_bytes INTEGER DEFAULT 0,
  trigger TEXT NOT NULL DEFAULT 'manual',      -- manual|pre-update|scheduled
  modpack_version_at_backup TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS update_history (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  from_version TEXT,
  to_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending|success|failed|rolled-back
  changelog TEXT,
  backup_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
);

-- Sources built-in par défaut
INSERT OR IGNORE INTO api_sources (id, name, base_url, format, enabled, is_builtin) VALUES
  ('curseforge', 'CurseForge', 'https://api.curseforge.com', 'curseforge', 1, 1),
  ('modrinth', 'Modrinth', 'https://api.modrinth.com/v2', 'modrinth', 1, 1);
