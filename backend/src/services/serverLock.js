/**
 * Verrou par serveur : une seule opération lourde à la fois (installation, mise à jour,
 * restauration, recréation, démarrage/arrêt…). Sans lui, un clic au mauvais moment pouvait
 * recréer le container pendant la bascule de dossiers d'une mise à jour, ou lancer deux
 * installations en parallèle dans le même dossier.
 *
 * Mémoire du processus uniquement : au redémarrage du backend, les états « installing » /
 * « updating » orphelins sont traités par recoverInterruptedOperations() (voir updater).
 */
const { getDb } = require('../config/database');

const locks = new Map(); // serverId → { op, since }

// États pendant lesquels le serveur appartient à une opération de fond
const BUSY_STATUSES = new Set(['installing', 'updating']);

function current(serverId) {
  return locks.get(serverId) || null;
}

/** Prend le verrou ; lève une erreur 409 si une opération est déjà en cours. */
function acquire(serverId, op) {
  const held = locks.get(serverId);
  if (held) {
    throw Object.assign(new Error(`Opération déjà en cours sur ce serveur (${held.op}) — réessayez dans un instant`), { status: 409 });
  }
  locks.set(serverId, { op, since: Date.now() });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (locks.get(serverId)?.op === op) locks.delete(serverId);
  };
}

/** Exécute fn sous verrou (libéré même en cas d'erreur). */
async function withLock(serverId, op, fn) {
  const release = acquire(serverId, op);
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Vérifie que le serveur est libre (ni verrou, ni installation/mise à jour en cours).
 * Retourne le message d'erreur, ou null si le serveur est disponible.
 */
function busyReason(server) {
  const held = locks.get(server.id);
  if (held) return `Opération déjà en cours sur ce serveur (${held.op})`;
  if (BUSY_STATUSES.has(server.status)) return `Le serveur est en cours d'${server.status === 'updating' ? 'mise à jour' : 'installation'}`;
  return null;
}

/** Middleware Express : 409 si le serveur (req.params.id ou :serverId) est occupé. */
function requireIdle(req, res, next) {
  const id = req.params.id || req.params.serverId;
  const server = getDb().prepare('SELECT id, status FROM servers WHERE id = ?').get(id);
  if (!server) return next();
  const reason = busyReason(server);
  if (reason) return res.status(409).json({ error: reason });
  next();
}

module.exports = { acquire, withLock, busyReason, requireIdle, current, _locks: locks };
