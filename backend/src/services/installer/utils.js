const path = require('path');
const fs = require('fs');
const { readModInfo, analyze: analyzeMods, describeProblems, listJars } = require('../modJar');
const { isMcVersion } = require('../mcVersion');
const { emit, progress } = require('./progress');

/** Loader déclaré par le pack (.craftarr-pack.json), ou null. */
function packLoader(serverDir) {
  try { return JSON.parse(fs.readFileSync(path.join(serverDir, '.craftarr-pack.json'), 'utf8')).loader || null; } catch { return null; }
}

/**
 * Vérifie le dossier mods/ avant le premier démarrage (dépendances manquantes, doublons,
 * incompatibilités déclarées) et l'affiche dans la console. Jamais bloquant : l'analyse
 * des métadonnées n'est pas infaillible, mais elle évite de chercher dans une stacktrace.
 */
function reportModProblems(server, serverDir) {
  try {
    const prefer = packLoader(serverDir) || server.loader_type || null;
    const lines = describeProblems(analyzeMods(listJars(path.join(serverDir, 'mods')), f => readModInfo(f, { prefer })));
    if (!lines.length) return;
    progress(server.id, 'warn', `${lines.length} problème(s) potentiel(s) détecté(s) dans les mods — voir la console`, 80);
    for (const l of lines.slice(0, 30)) emit(server.id, 'log', { line: `[Craftarr] ⚠ ${l}`, timestamp: Date.now() });
    if (lines.length > 30) emit(server.id, 'log', { line: `[Craftarr] ⚠ … et ${lines.length - 30} autre(s)`, timestamp: Date.now() });
    console.warn(`[Installer][${server.id.slice(0, 8)}] ${lines.length} problème(s) de mods :\n  ${lines.join('\n  ')}`);
  } catch (err) {
    console.warn('[Installer] Analyse des mods impossible :', err.message);
  }
}

/**
 * Métadonnées du pack (version MC + loader exact) écrites dans serverDir/.craftarr-pack.json.
 * Lues par docker.js pour épingler la version du loader (FORGE_VERSION, FABRIC_LOADER_VERSION…)
 * au lieu de laisser itzg prendre la dernière — cause classique de crash au démarrage.
 */
function writePackMeta(serverDir, meta) {
  try {
    fs.writeFileSync(path.join(serverDir, '.craftarr-pack.json'), JSON.stringify(meta, null, 2));
  } catch (err) {
    console.warn('[Installer] Impossible d\'écrire .craftarr-pack.json :', err.message);
  }
}

/**
 * RAM conseillée selon le nombre de mods (ordre de grandeur usuel des modpacks) :
 * < 50 mods → 4 Go, < 150 → 6 Go, < 250 → 8 Go, au-delà → 10 Go.
 * Retourne un message d'avertissement si le serveur en a moins, sinon null.
 */
function ramAdvice(modsDir, ramMb) {
  let mods = 0;
  try { mods = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar')).length; } catch {}
  const recommendedGb = mods < 50 ? 4 : mods < 150 ? 6 : mods < 250 ? 8 : 10;
  if (!ramMb || ramMb >= recommendedGb * 1024) return null;
  return `⚠ ${mods} mods pour ${Math.round(ramMb / 1024 * 10) / 10} Go de RAM : ${recommendedGb} Go recommandés `
    + '(Paramètres du serveur → RAM, puis recréer le container). Risque de lag ou de crash.';
}

/** Formate une liste d'échecs pour un message d'erreur lisible. */
function formatFailures(failures) {
  const shown = failures.slice(0, 10).join(', ');
  return failures.length > 10 ? `${shown} … (+${failures.length - 10})` : shown;
}

function extractMcVer(versions = []) {
  // Minecraft : 1.x.y ou schéma annuel 26.x.y (voir mcVersion.js).
  // Ignore les versions Forge (47.2.0) et les tags de loader ("NeoForge", "Server"…).
  return versions.find(isMcVersion) || null;
}

function detectLoader(versions = []) {
  const v = versions.map(s => s.toLowerCase());
  if (v.some(s => s.includes('neoforge'))) return 'neoforge';
  if (v.some(s => s.includes('forge'))) return 'forge';
  if (v.some(s => s.includes('fabric'))) return 'fabric';
  if (v.some(s => s.includes('quilt'))) return 'quilt';
  return 'forge';
}

/**
 * Avant une réinstallation (serveur en erreur) : vide le dossier serveur en gardant le monde
 * et les fichiers de l'utilisateur. Sinon les mods/loader d'une tentative précédente restaient
 * à côté des nouveaux → mods en double, mauvaise version du loader.
 */
function cleanForReinstall(serverDir) {
  if (!fs.existsSync(serverDir)) return;
  const backupService = require('../backup');
  const keep = new Set([
    ...backupService.getWorldDirs(serverDir),
    'server.properties', 'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json', 'usercache.json',
  ]);
  for (const name of fs.readdirSync(serverDir)) {
    if (!keep.has(name)) fs.rmSync(path.join(serverDir, name), { recursive: true, force: true });
  }
}

module.exports = {
  packLoader,
  reportModProblems,
  writePackMeta,
  ramAdvice,
  formatFailures,
  extractMcVer,
  detectLoader,
  cleanForReinstall,
};
