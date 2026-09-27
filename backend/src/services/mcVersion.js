const fs = require('fs');
const path = require('path');

/**
 * Helpers de versions Minecraft / NeoForge.
 *
 * Depuis 2026, Minecraft utilise un schéma annuel (26.1, 26.1.2, 26.2…) en plus de
 * l'ancien schéma 1.x.y. NeoForge suit ce schéma : NeoForge 26.1.2.97 = MC 26.1.2,
 * NeoForge 26.2.0.88 = MC 26.2. L'ancien schéma NeoForge (20.x.y / 21.x.y) = MC 1.20.x / 1.21.x.
 */

// 1.x / 1.x.y (patch sur 1–2 chiffres : 1.21.11 existe) ou 26.x / 26.x.y … 29.x.y
const MC_VERSION_RE = /^(1\.\d{1,2}(\.\d{1,2})?|2[6-9]\.\d{1,2}(\.\d{1,2})?)$/;

function isMcVersion(v) {
  return typeof v === 'string' && MC_VERSION_RE.test(v);
}

function numericParts(v) {
  return String(v).replace(/-.*$/, '').split('.').map(n => parseInt(n, 10) || 0);
}

/** Déduit la version MC d'une version NeoForge, ou null si impossible. */
function mcVersionFromNeoForge(nfVersion) {
  if (!nfVersion) return null;
  const [a, b, c] = numericParts(nfVersion);
  let mc = null;
  if (a >= 26 && b !== undefined) {
    // 26.1.2.97 → 26.1.2  |  26.2.0.88 → 26.2
    mc = c ? `${a}.${b}.${c}` : `${a}.${b}`;
  } else if (a >= 20 && a <= 21 && b !== undefined) {
    // 21.1.226 → 1.21.1  |  20.4.x → 1.20.4
    mc = b ? `1.${a}.${b}` : `1.${a}`;
  }
  return isMcVersion(mc) ? mc : null;
}

/** Tag Java (8/16/17/21/25) requis pour une version MC / NeoForge donnée. */
function requiredJava(mcVersion, neoforgeVersion) {
  if (neoforgeVersion && numericParts(neoforgeVersion)[0] >= 26) return 25;
  if (!mcVersion) return 21; // défaut raisonnable
  const [major, minor, patch = 0] = numericParts(mcVersion);
  if (major >= 26) return 25;
  if (major === 1) {
    if (minor < 17) return 8;
    if (minor === 17) return 16;
    if (minor < 20 || (minor === 20 && patch < 5)) return 17;
  }
  return 21;
}

/** Lit loaderVersion dans server-setup-config.yaml (ou .yaml.done après setup thin pack). */
function loaderVersionFromSetupConfig(serverDir) {
  for (const name of ['server-setup-config.yaml', 'server-setup-config.yaml.done']) {
    try {
      const content = fs.readFileSync(path.join(serverDir, name), 'utf8');
      const m = content.match(/^\s*loaderVersion:\s*["']?([0-9][^\s"'#]*)["']?/m);
      if (m) return m[1];
    } catch {}
  }
  return null;
}

module.exports = { isMcVersion, mcVersionFromNeoForge, requiredJava, loaderVersionFromSetupConfig };
