// Colonnes pour le crossplay Bedrock (Geyser + Floodgate)
module.exports = [
  'ALTER TABLE servers ADD COLUMN geyser_enabled INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE servers ADD COLUMN geyser_port INTEGER',
  'ALTER TABLE servers ADD COLUMN geyser_floodgate INTEGER NOT NULL DEFAULT 1',
];
