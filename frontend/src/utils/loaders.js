// Libellé affiché d'un loader (la capitalisation CSS donnait « Neoforge »)
export const LOADER_LABEL = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt', vanilla: 'Vanilla', paper: 'Paper' };

export const loaderLabel = (loader) => LOADER_LABEL[String(loader || '').toLowerCase()] || loader || '';
