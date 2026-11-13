const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { getDb } = require('../../config/database');
const modrinth = require('../modrinth');
const { isMcVersion } = require('../mcVersion');
const { progress } = require('./progress');
const { downloadFile, safeJoin } = require('./download');
const { reportModProblems, writePackMeta, formatFailures } = require('./utils');

const DATA_PATH = process.env.DATA_PATH || '/data';

/**
 * Télécharge et installe la version Modrinth choisie (ou la plus récente), puis enregistre
 * en base la version MC / le loader réellement installés (lus dans l'index du pack).
 */
async function installModrinthModpack(server, serverDir, apiKey) {
  const db = getDb();
  let selectedVersion;
  if (server.modpack_version_id) {
    // Par id : jamais de repli silencieux sur une autre version que celle choisie
    try {
      selectedVersion = await modrinth.getVersion(apiKey, server.modpack_version_id);
    } catch (err) {
      throw new Error(`Version Modrinth ${server.modpack_version_id} introuvable (${err.response?.status || err.message})`);
    }
  } else {
    selectedVersion = (await modrinth.getVersions(apiKey, server.modpack_id))[0];
  }
  if (!selectedVersion) throw new Error('Aucune version Modrinth trouvée pour ' + server.modpack_id);

  const primaryFile = selectedVersion.files.find(f => f.primary) || selectedVersion.files[0];
  if (!primaryFile?.url) throw new Error('Aucun fichier .mrpack trouvé pour la version ' + selectedVersion.id);

  progress(server.id, 'download', 'Téléchargement du modpack Modrinth', 30);
  const mrpackPath = path.join(DATA_PATH, 'servers', server.id, 'modpack.mrpack');
  await downloadFile(primaryFile.url, mrpackPath, pct =>
    progress(server.id, 'download', `Téléchargement : ${pct}%`, 30 + Math.floor(pct * 0.2))
  );

  progress(server.id, 'extract', 'Extraction et installation des mods serveur', 50);
  const packMeta = await installMrpack(server, mrpackPath, serverDir, apiKey);
  fs.unlinkSync(mrpackPath);
  reportModProblems(server, serverDir);

  // L'index du pack fait foi (la liste mcVersions de la version Modrinth peut en contenir plusieurs)
  const mcVersion = packMeta?.mcVersion || selectedVersion.mcVersions?.find(isMcVersion) || server.mc_version;
  const loaderType = packMeta?.loader || selectedVersion.loaders?.[0] || server.loader_type;
  db.prepare('UPDATE servers SET mc_version = ?, loader_type = ?, modpack_download_url = ?, modpack_version = ?, modpack_version_id = ? WHERE id = ?')
    .run(mcVersion, loaderType, primaryFile.url, selectedVersion.versionNumber, selectedVersion.id, server.id);
}

/**
 * Installe un modpack au format .mrpack (Modrinth).
 * Parse modrinth.index.json, filtre les mods côté serveur,
 * télécharge les JARs et extrait overrides/ + server-overrides/.
 */
async function installMrpack(server, mrpackPath, serverDir, apiKey) {
  const modsDir = path.join(serverDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });

  const zip = new AdmZip(mrpackPath);
  const indexEntry = zip.getEntry('modrinth.index.json');
  if (!indexEntry) {
    // Pas un .mrpack standard — extraction brute
    zip.extractAllTo(serverDir, true);
    return;
  }

  const index = JSON.parse(zip.readAsText('modrinth.index.json'));
  console.log(`[Installer] Modrinth index v${index.formatVersion}, ${index.files?.length || 0} fichiers`);

  // Version MC + loader exacts déclarés par le pack (dependencies: minecraft, fabric-loader, neoforge…)
  const deps = index.dependencies || {};
  const loaderKey = ['neoforge', 'forge', 'fabric-loader', 'quilt-loader'].find(k => deps[k]);
  const packMeta = {
    mcVersion: isMcVersion(deps.minecraft) ? deps.minecraft : null,
    loader: loaderKey ? loaderKey.replace('-loader', '') : null,
    loaderVersion: loaderKey ? deps[loaderKey] : null,
  };
  writePackMeta(serverDir, packMeta);

  // Extraire overrides/ puis server-overrides/ (le second écrase le premier, comme le fait Modrinth)
  for (const prefix of ['overrides/', 'server-overrides/']) {
    for (const entry of zip.getEntries()) {
      if (!entry.entryName.startsWith(prefix) || entry.isDirectory) continue;
      const dest = safeJoin(serverDir, entry.entryName.slice(prefix.length));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entry.getData());
    }
  }

  // Spécification Modrinth : env.server = "unsupported" → le fichier ne doit PAS être installé côté serveur
  // (mods de rendu, shaders… qui font crasher un serveur dédié). "optional" et "required" sont gardés.
  const serverFiles = (index.files || []).filter(f => f.env?.server !== 'unsupported');

  const clientOnlySkipped = (index.files?.length || 0) - serverFiles.length;
  if (clientOnlySkipped > 0) {
    console.log(`[Installer] ${clientOnlySkipped} mods client-only ignorés`);
  }
  progress(server.id, 'mods', `Téléchargement de ${serverFiles.length} mods serveur...`, 55);

  let downloaded = 0;
  const failures = [];
  const CONCURRENCY = 5;

  for (let i = 0; i < serverFiles.length; i += CONCURRENCY) {
    const batch = serverFiles.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (file) => {
      // Le chemin dans l'index est relatif à la racine du serveur (ex: "mods/mod.jar")
      const dest = safeJoin(serverDir, file.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (fs.existsSync(dest)) { downloaded++; return; }

      // Hash fourni par l'index (sha512 prioritaire) → détecte les fichiers corrompus
      const expected = file.hashes?.sha512 ? { sha512: file.hashes.sha512 }
        : file.hashes?.sha1 ? { sha1: file.hashes.sha1 } : {};

      // Essayer chaque URL de téléchargement dans l'ordre
      for (const url of file.downloads || []) {
        try {
          await downloadFile(url, dest, null, expected);
          downloaded++;
          return;
        } catch (err) {
          console.warn(`[Installer] ${err.message} (${url})`);
        }
      }
      failures.push(file.path);
    }));
    const pct = Math.min(100, Math.round((i + CONCURRENCY) / serverFiles.length * 100));
    progress(server.id, 'mods', `Mods : ${downloaded}/${serverFiles.length}`, 55 + Math.floor(pct * 0.25));
  }

  console.log(`[Installer] Modrinth mods: ${downloaded} téléchargés, ${failures.length} échoués, ${clientOnlySkipped} client-only ignorés`);
  if (failures.length) {
    throw new Error(`${failures.length} fichier(s) du modpack n'ont pas pu être téléchargés : ${formatFailures(failures)}. Relancez l'installation.`);
  }
  progress(server.id, 'mods_done', `${downloaded} mods installés`, 80);
  return packMeta;
}

module.exports = { installModrinthModpack, installMrpack };
