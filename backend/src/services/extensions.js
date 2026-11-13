// @ts-check
/**
 * Registre des extensions de serveur. Chaque fichier de services/extensions/*.js peut exporter :
 *
 *   name: string                                   identifiant (journal, erreurs)
 *   env(server, ctx) => string[]                   variables d'environnement du container itzg
 *   ports(server, ctx) => { exposed: {}, bindings: {} }   ports supplémentaires (ex. '19132/udp')
 *   labels(server) => Record<string,string>        labels Docker (ex. mc-router)
 *   publishGamePort(server) => boolean             false = ne pas publier le port de jeu sur l'hôte
 *   hostConfig(server) => Record<string, any>      options fusionnées dans HostConfig Docker
 *   fields: { [colonne]: { parse(value) => any, container?: boolean } }
 *                                                  colonnes de `servers` modifiables via PATCH
                                                 (parse reçoit aussi la ligne du serveur modifié) ;
 *                                                  container: true = recréation du container nécessaire
 *   decorate(row) => object                        champs ajoutés à la réponse JSON d'un serveur
 *   init({ events, io, app }) => void              démarrage (tâches de fond, abonnements au bus)
 *
 * ctx = { serverDir, javaVersion, packMeta }. Toute exception d'une extension est journalisée
 * et ignorée : une extension défaillante ne doit pas empêcher un serveur de démarrer.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'extensions');
/** @type {any[] | null} */
let cache = null;

/** @returns {any[]} */
function list() {
  if (cache) return cache;
  cache = [];
  let files = [];
  try { files = fs.readdirSync(DIR).filter(f => f.endsWith('.js')).sort(); } catch { /* dossier absent */ }
  for (const f of files) {
    try {
      const mod = require(path.join(DIR, f));
      cache.push({ name: mod.name || f.replace(/\.js$/, ''), ...mod });
    } catch (err) {
      console.error(`[extensions] ${f} ignorée :`, /** @type {Error} */ (err).message);
    }
  }
  return cache;
}

/** @param {string} hook @param {(ext: any) => any} fn @returns {any[]} */
function collect(hook, fn) {
  const out = [];
  for (const ext of list()) {
    if (typeof ext[hook] !== 'function' && hook !== 'fields') continue;
    try { out.push(fn(ext)); } catch (err) {
      console.error(`[extensions] ${ext.name}.${hook} :`, /** @type {Error} */ (err).message);
    }
  }
  return out;
}

/** @returns {string[]} */
function env(server, ctx) {
  return collect('env', ext => ext.env(server, ctx) || []).flat().filter(Boolean);
}

/** @returns {{ exposed: Record<string, object>, bindings: Record<string, any[]> }} */
function ports(server, ctx) {
  /** @type {Record<string, object>} */
  const exposed = {};
  /** @type {Record<string, any[]>} */
  const bindings = {};
  for (const p of collect('ports', ext => ext.ports(server, ctx))) {
    if (!p) continue;
    Object.assign(exposed, p.exposed || {});
    Object.assign(bindings, p.bindings || {});
  }
  return { exposed, bindings };
}

/** @returns {Record<string, string>} */
function labels(server) {
  return Object.assign({}, ...collect('labels', ext => ext.labels(server) || {}));
}

/** Le port de jeu est publié sauf si une extension (ex. routeur par sous-domaine) le refuse. */
function publishGamePort(server) {
  return collect('publishGamePort', ext => ext.publishGamePort(server)).every(v => v !== false);
}

/** @returns {Record<string, any>} */
function hostConfig(server) {
  return Object.assign({}, ...collect('hostConfig', ext => ext.hostConfig(server) || {}));
}

/** @returns {Record<string, { parse: (v: any) => any, container?: boolean }>} */
function fields() {
  /** @type {Record<string, { parse: (v: any) => any, container?: boolean }>} */
  const out = {};
  for (const ext of list()) if (ext.fields) Object.assign(out, ext.fields);
  return out;
}

/** @param {Record<string, any>} row */
function decorate(row) {
  return Object.assign({}, ...collect('decorate', ext => ext.decorate(row) || {}));
}

/** @param {{ events: any, io: any, app: any }} deps */
function init(deps) {
  collect('init', ext => ext.init(deps));
}

/** Pour les tests : force le rechargement du dossier. */
function _reset() { cache = null; }

module.exports = { list, env, ports, labels, publishGamePort, hostConfig, fields, decorate, init, _reset };
