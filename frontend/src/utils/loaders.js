// Libellé affiché d'un loader (la capitalisation CSS donnait « Neoforge »)
export const LOADER_LABEL = {
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  quilt: 'Quilt',
  vanilla: 'Vanilla',
  paper: 'Paper',
  purpur: 'Purpur',
  spigot: 'Spigot',
  bukkit: 'Bukkit',
  folia: 'Folia',
};

export const PLUGIN_LOADERS = new Set(['paper', 'purpur', 'spigot', 'bukkit', 'folia']);

export const isPluginLoader = (loader) => PLUGIN_LOADERS.has(String(loader || '').toLowerCase());

export const loaderLabel = (loader) => LOADER_LABEL[String(loader || '').toLowerCase()] || loader || '';
