// Migration BlueMap : activation et port hôte dédié sur chaque serveur.
module.exports = [
  'ALTER TABLE servers ADD COLUMN bluemap_enabled INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE servers ADD COLUMN bluemap_port INTEGER',
];
