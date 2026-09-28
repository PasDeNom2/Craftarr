import {
  Folder, FileText, FileCode2, FileJson, Settings2, Image as ImageIcon, Package, Archive,
  ScrollText, Database, Globe, Terminal, File,
} from 'lucide-react';

const TEXT = new Set([
  'txt', 'log', 'json', 'json5', 'jsonc', 'yaml', 'yml', 'toml', 'properties', 'cfg', 'conf', 'config', 'ini',
  'xml', 'sh', 'bat', 'cmd', 'md', 'js', 'ts', 'zs', 'java', 'py', 'env', 'mcmeta', 'mcfunction', 'snbt', 'csv',
  'lang', 'html', 'css', 'gitignore', 'secret', 'list',
]);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg']);
const BINARY = new Set(['jar', 'zip', 'gz', 'tar', 'mca', 'mcr', 'dat', 'dat_old', 'nbt', 'db', 'sqlite', 'class', 'so', 'dll', 'exe', 'bin', 'lock']);

export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** 'text' | 'image' | 'binary' | 'unknown' (inconnu → on tente le texte, le serveur refuse le binaire) */
export function kindOf(name) {
  const ext = extOf(name);
  if (TEXT.has(ext) || /^(eula|ops|whitelist|banned-.*)\.(txt|json)$/.test(name)) return 'text';
  if (IMAGE.has(ext)) return 'image';
  if (BINARY.has(ext)) return 'binary';
  return 'unknown';
}

/** Langage pour la coloration syntaxique */
export function languageOf(name) {
  const ext = extOf(name);
  if (['json', 'json5', 'jsonc', 'mcmeta'].includes(ext)) return 'json';
  if (['toml', 'ini', 'cfg', 'conf', 'config'].includes(ext)) return 'toml';
  if (['yaml', 'yml'].includes(ext)) return 'yaml';
  if (ext === 'properties' || ext === 'env' || ext === 'lang') return 'properties';
  if (ext === 'log') return 'log';
  if (['js', 'ts', 'zs', 'java', 'py', 'sh', 'bat', 'mcfunction', 'snbt'].includes(ext)) return 'code';
  return 'plain';
}

export const LANGUAGE_LABEL = {
  json: 'JSON', toml: 'TOML', yaml: 'YAML', properties: 'Properties', log: 'Log', code: 'Script', plain: 'Texte',
};

/** Icône + couleur (les couleurs restent discrètes : l'UI est en noir et blanc) */
export function iconOf(entry) {
  if (entry.isDir) {
    const special = {
      mods: Package, config: Settings2, defaultconfigs: Settings2, logs: ScrollText, crash_reports: ScrollText,
      world: Globe, kubejs: FileCode2, scripts: FileCode2, libraries: Archive, backups: Archive,
    }[entry.name.toLowerCase()];
    return { Icon: special || Folder, color: 'var(--info)' };
  }
  const ext = extOf(entry.name);
  if (entry.name === 'server.properties') return { Icon: Settings2, color: 'var(--accent)' };
  if (['json', 'json5', 'mcmeta'].includes(ext)) return { Icon: FileJson, color: 'var(--warn)' };
  if (['toml', 'cfg', 'ini', 'properties', 'yaml', 'yml', 'conf'].includes(ext)) return { Icon: Settings2, color: 'var(--fg-2)' };
  if (ext === 'log' || ext === 'gz') return { Icon: ScrollText, color: 'var(--fg-3)' };
  if (IMAGE.has(ext)) return { Icon: ImageIcon, color: 'var(--purple)' };
  if (ext === 'jar') return { Icon: Package, color: 'var(--orange)' };
  if (['zip', 'tar'].includes(ext)) return { Icon: Archive, color: 'var(--orange)' };
  if (['mca', 'dat', 'nbt', 'db', 'sqlite', 'dat_old'].includes(ext)) return { Icon: Database, color: 'var(--fg-3)' };
  if (['sh', 'bat', 'cmd'].includes(ext)) return { Icon: Terminal, color: 'var(--fg-2)' };
  if (['js', 'ts', 'zs', 'java', 'py', 'mcfunction'].includes(ext)) return { Icon: FileCode2, color: 'var(--fg-2)' };
  if (TEXT.has(ext)) return { Icon: FileText, color: 'var(--fg-2)' };
  return { Icon: File, color: 'var(--fg-3)' };
}

export function formatSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
  return `${(bytes / 1024 ** 3).toFixed(2)} Go`;
}

export const joinPath = (dir, name) => (dir ? `${dir}/${name}` : name);
export const parentOf = (p) => p.split('/').slice(0, -1).join('/');
