// @ts-check
/**
 * Bus d'événements interne : les fonctionnalités (planificateur, veille, journal d'activité…)
 * réagissent à la vie des serveurs sans modifier le code qui les émet.
 *
 * Événements émis par le cœur (payload toujours avec serverId) :
 *   server:created { serverId }            server:deleted { serverId }
 *   server:started { serverId }            (ligne « Done » de Minecraft)
 *   server:stopped { serverId }            (fin du flux de logs, container arrêté)
 *   server:crashed { serverId, restarts }  (coupe-circuit des crashs)
 *   server:power   { serverId, action, userId? }  (start/stop/restart demandés via l'API)
 *   player:join    { serverId, username }  player:leave { serverId, username, reason }
 *   backup:created { serverId, backup }
 */
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(50);

/**
 * Émet sans jamais faire échouer l'appelant : une extension qui plante ne doit pas casser
 * le démarrage d'un serveur ou l'enregistrement d'un joueur.
 * @param {string} type
 * @param {Record<string, any>} payload
 */
function emit(type, payload) {
  for (const listener of bus.listeners(type)) {
    try {
      const r = /** @type {any} */ (listener)(payload);
      if (r && typeof r.catch === 'function') r.catch(err => console.error(`[events] ${type} :`, err.message));
    } catch (err) {
      console.error(`[events] ${type} :`, /** @type {Error} */ (err).message);
    }
  }
}

/** @param {string} type @param {(payload: any) => any} fn */
function on(type, fn) { bus.on(type, fn); return () => bus.off(type, fn); }

module.exports = { emit, on, bus };
