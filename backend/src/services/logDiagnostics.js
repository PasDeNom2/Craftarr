/**
 * Reconnaît les erreurs de démarrage Minecraft les plus fréquentes dans les logs d'un serveur
 * et renvoie une explication + la marche à suivre, affichée dans la console Craftarr.
 * Évite de devoir déchiffrer une stacktrace Java pour un problème connu.
 */
const RULES = [
  {
    re: /UnsupportedClassVersionError(?:.*class file version (\d+)\.0)?/,
    hint: m => {
      const javaByClass = { 61: 17, 65: 21, 69: 25 };
      const java = m[1] ? javaByClass[m[1]] : null;
      return `Mauvaise version de Java${java ? ` (le pack exige Java ${java})` : ''}. `
        + 'Recréez le container (bouton « Recréer ») pour que Craftarr choisisse la bonne image.';
    },
  },
  {
    re: /Missing or unsupported mandatory dependencies|Mod loading has failed/i,
    hint: () => 'Mod manquant ou de mauvaise version. Réinstallez le modpack, ou retirez le mod ajouté manuellement.',
  },
  {
    re: /Found duplicate mods|Duplicate mods found|DuplicateModsFoundException|Mod ID .* is provided by multiple/i,
    hint: () => 'Le même mod est présent en double dans mods/ (deux versions). Supprimez l\'ancien jar, ou réinstallez le modpack.',
  },
  {
    // « requires … which is missing » / « Incompatible mod set » bloquent le démarrage.
    // « recommends / suggests … which is missing » ne sont que des suggestions : ignorées.
    re: /Incompatible mods? (?:found|set)|requires .* which is missing/i,
    skip: /\b(recommends|suggests)\b/i,
    hint: () => 'Fabric/Quilt : un mod requis manque ou n\'est pas dans la bonne version. Le message ci-dessus indique lequel.',
  },
  {
    // Seules les erreurs Mixin fatales : MixinApplyError, ou une injection en échec remontée comme cause d'un crash.
    // Un mixin optionnel qui échoue est loggé en WARN (+ sa trace) et le serveur continue : pas un problème.
    re: /MixinApplyError|Caused by: \S*InvalidInjectionException|Mixin apply(?: for mod \S+)? failed/,
    skip: /\/WARN\]/,
    hint: () => 'Conflit entre deux mods (Mixin). Souvent un mod ajouté à la main ou une version non prévue par le pack : retirez-le ou réinstallez le modpack.',
  },
  {
    re: /OutOfMemoryError|Could not reserve enough space for .* object heap/,
    hint: () => 'Mémoire insuffisante. Augmentez la RAM du serveur (8 Go+ pour un gros modpack) puis recréez le container.',
  },
  {
    re: /FAILED TO BIND TO PORT|Address already in use/i,
    hint: () => 'Port déjà utilisé par un autre programme/serveur. Changez le port du serveur.',
  },
  {
    re: /Attempted to load class net\/minecraft\/client|Dist\.CLIENT|invalid dist DEDICATED_SERVER/i,
    hint: () => 'Un mod client-only (rendu, shaders, HUD…) est installé sur le serveur. Supprimez-le du dossier mods/.',
  },
  {
    re: /Failed to (?:download|install) .*(?:neoforge|forge|fabric)|Failed to run (?:neo)?forge installer/i,
    hint: () => 'Installation du loader échouée (réseau ?). Redémarrez le serveur pour réessayer.',
  },
];

/** Retourne un message de diagnostic pour une ligne de log, ou null. */
function diagnoseLine(line) {
  for (const rule of RULES) {
    const m = line.match(rule.re);
    if (m && !(rule.skip && rule.skip.test(line))) return rule.hint(m);
  }
  return null;
}

/**
 * Crée un diagnostiqueur par serveur qui n'émet chaque conseil qu'une fois par période
 * (un crash-loop répète la même erreur toutes les 10 s).
 */
function createDiagnoser(cooldownMs = 10 * 60 * 1000) {
  const lastSent = new Map();
  return (line) => {
    const hint = diagnoseLine(line);
    if (!hint) return null;
    const now = Date.now();
    if (now - (lastSent.get(hint) || 0) < cooldownMs) return null;
    lastSent.set(hint, now);
    return `[Craftarr] ⚠ Diagnostic : ${hint}`;
  };
}

module.exports = { diagnoseLine, createDiagnoser };
