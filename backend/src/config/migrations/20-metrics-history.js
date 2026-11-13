// Migration : tables d'historique des métriques (échantillons à la minute et agrégats horaires).
module.exports = [
  `CREATE TABLE IF NOT EXISTS metrics_samples (
    server_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    cpu REAL,
    mem_mb INTEGER,
    players INTEGER,
    tps REAL,
    PRIMARY KEY (server_id, ts)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_metrics_samples_ts ON metrics_samples(ts)`,
  `CREATE TABLE IF NOT EXISTS metrics_hourly (
    server_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    cpu REAL,
    mem_mb INTEGER,
    players INTEGER,
    tps REAL,
    cpu_max REAL,
    mem_max INTEGER,
    players_max INTEGER,
    PRIMARY KEY (server_id, ts)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_metrics_hourly_ts ON metrics_hourly(ts)`,
];
