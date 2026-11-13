// Moteur de tâches planifiées par serveur (cron sans dépendance, intervalle, événements).
const { randomUUID: uuidv4 } = require('crypto');
const { getDb } = require('../config/database');

const TICK_MS = 30_000;
const MAX_RUNS_PER_SCHEDULE = 50;
const VALID_EVENTS = [
  'server:started',
  'server:stopped',
  'server:crashed',
  'player:join',
  'player:leave',
  'server:empty',
];
const BUS_EVENTS = [
  'server:started',
  'server:stopped',
  'server:crashed',
  'player:join',
  'player:leave',
];

const PRESETS = [
  {
    id: 'announced-restart',
    name: 'Redémarrage annoncé',
    description: 'Prévient les joueurs 5 min puis 1 min avant de redémarrer le serveur.',
    trigger_type: 'cron',
    cron: '0 4 * * *',
    only_if_players: 'any',
    steps: [
      { type: 'say', message: 'Redémarrage du serveur dans 5 minutes' },
      { type: 'wait', seconds: 240 },
      { type: 'say', message: 'Redémarrage du serveur dans 1 minute' },
      { type: 'wait', seconds: 60 },
      { type: 'power', action: 'restart' },
    ],
  },
  {
    id: 'daily-backup',
    name: 'Sauvegarde quotidienne',
    description: 'Annonce la sauvegarde automatique puis crée un backup du monde.',
    trigger_type: 'cron',
    cron: '0 3 * * *',
    only_if_players: 'any',
    steps: [
      { type: 'say', message: 'Sauvegarde automatique du monde en cours…' },
      { type: 'backup' },
      { type: 'say', message: 'Sauvegarde terminée' },
    ],
  },
];

const MAX_DAYS_PER_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Parse un champ cron (`*`, listes `,`, plages `-`, pas `/`) et retourne l'ensemble des valeurs autorisées.
 * @param {string} field
 * @param {number} min
 * @param {number} max
 * @param {{ isDow?: boolean }} [opts]
 * @returns {Set<number>}
 */
function parseCronField(field, min, max, { isDow = false } = {}) {
  if (typeof field !== 'string' || field.length === 0) {
    throw new Error('Champ cron vide');
  }
  const tokens = field.split(',');
  const values = new Set();

  for (const token of tokens) {
    if (!token) throw new Error(`Champ cron invalide : « ${field} »`);
    const slashParts = token.split('/');
    if (slashParts.length > 2) throw new Error(`Pas cron invalide : « ${token} »`);

    const [rangeStr, stepStr] = slashParts;
    let step = 1;
    const hasStep = stepStr !== undefined;
    if (hasStep) {
      if (!/^[1-9]\d*$/.test(stepStr)) {
        throw new Error(`Pas cron invalide : « ${token} »`);
      }
      step = Number(stepStr);
    }

    let start;
    let end;
    if (rangeStr === '*') {
      start = min;
      end = max;
    } else if (rangeStr.includes('-')) {
      const dashParts = rangeStr.split('-');
      if (dashParts.length !== 2 || !/^\d+$/.test(dashParts[0]) || !/^\d+$/.test(dashParts[1])) {
        throw new Error(`Plage cron invalide : « ${token} »`);
      }
      start = Number(dashParts[0]);
      end = Number(dashParts[1]);
      if (start < min || end > max || start > end) {
        throw new Error(`Plage cron hors bornes (${min}-${max}) : « ${token} »`);
      }
    } else {
      if (!/^\d+$/.test(rangeStr)) {
        throw new Error(`Valeur cron invalide : « ${token} »`);
      }
      const val = Number(rangeStr);
      if (val < min || val > max) {
        throw new Error(`Valeur cron hors bornes (${min}-${max}) : « ${token} »`);
      }
      start = val;
      end = hasStep ? max : val;
    }

    for (let v = start; v <= end; v += step) {
      values.add(isDow && v === 7 ? 0 : v);
    }
  }

  if (values.size === 0) throw new Error(`Champ cron vide : « ${field} »`);
  return values;
}

/**
 * Parse une expression cron à 5 champs (`minute heure jour mois jourSemaine`).
 * @param {string} expr
 */
function parseCron(expr) {
  if (typeof expr !== 'string') throw new Error('Expression cron invalide');
  const trimmed = expr.trim();
  if (!trimmed) throw new Error('Expression cron vide');
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error('L\'expression cron doit contenir exactement 5 champs');
  }

  const minutes = parseCronField(parts[0], 0, 59);
  const hours = parseCronField(parts[1], 0, 23);
  const dom = parseCronField(parts[2], 1, 31);
  const months = parseCronField(parts[3], 1, 12);
  const dow = parseCronField(parts[4], 0, 7, { isDow: true });
  const domWild = parts[2] === '*';
  const dowWild = parts[4] === '*';

  // Vérifie qu'au moins un couple (mois, jour) existe dans le calendrier lorsque seul dom est contraint
  if (!domWild && dowWild) {
    let possible = false;
    for (const m of months) {
      for (const d of dom) {
        if (d <= MAX_DAYS_PER_MONTH[m]) {
          possible = true;
          break;
        }
      }
      if (possible) break;
    }
    if (!possible) {
      throw new Error('Expression cron sans date valide dans le calendrier');
    }
  }

  return { minutes, hours, dom, months, dow, domWild, dowWild };
}

/**
 * Calcule la prochaine exécution (en heure locale du conteneur) strictement postérieure à fromDate.
 * @param {string} cron
 * @param {Date | number | string} [fromDate=new Date()]
 * @returns {Date}
 */
function nextRun(cron, fromDate = new Date()) {
  const spec = parseCron(cron);
  const base = fromDate instanceof Date ? new Date(fromDate.getTime()) : new Date(fromDate);
  if (Number.isNaN(base.getTime())) {
    throw new Error('Date de référence invalide');
  }

  const d = new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    base.getHours(),
    base.getMinutes() + 1,
    0,
    0,
  );

  const maxYear = d.getFullYear() + 8;
  while (d.getFullYear() <= maxYear) {
    if (!spec.months.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }

    const domMatch = spec.dom.has(d.getDate());
    const dowMatch = spec.dow.has(d.getDay());
    const dayOk = (!spec.domWild && !spec.dowWild)
      ? (domMatch || dowMatch)
      : (domMatch && dowMatch);
    if (!dayOk) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }

    if (!spec.hours.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }

    if (!spec.minutes.has(d.getMinutes())) {
      d.setTime(d.getTime() + 60_000);
      continue;
    }

    return d;
  }

  throw new Error('Aucune prochaine exécution trouvée pour cette expression cron');
}

/**
 * Calcule la prochaine date d'exécution ISO (UTC) d'une tâche, ou null pour une tâche événementielle/inactive.
 */
function computeNextRunAt(schedule, fromDate = new Date()) {
  if (!schedule || !schedule.enabled) return null;
  if (schedule.trigger_type === 'cron') {
    return nextRun(schedule.cron, fromDate).toISOString();
  }
  if (schedule.trigger_type === 'interval') {
    const mins = Number(schedule.interval_minutes);
    if (!(mins > 0)) return null;
    return new Date(fromDate.getTime() + mins * 60_000).toISOString();
  }
  return null;
}

// ─── État du moteur ───────────────────────────────────────────
const runningSchedules = new Set();
let loopTimer = null;
let started = false;
let currentIo = null;
let unsubs = [];

function sleep(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Exécute une action d'alimentation (start/stop/restart) en respectant serverLock et l'état en base.
 */
async function executePowerAction(serverId, action) {
  const db = getDb();
  const dockerService = require('./docker');
  const serverLock = require('./serverLock');
  const events = require('./events');

  await serverLock.withLock(serverId, `tâche planifiée (${action})`, async () => {
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
    if (!server) throw new Error('Serveur introuvable');
    if (['installing', 'updating'].includes(server.status)) {
      throw new Error(`Le serveur est en cours d'${server.status === 'updating' ? 'mise à jour' : 'installation'}`);
    }
    if (!server.container_id) throw new Error('Container non créé');

    if (action === 'stop') {
      await dockerService.stopContainer(server.container_id);
      db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('stopped', server.id);
      db.prepare('UPDATE players SET is_online = 0 WHERE server_id = ?').run(server.id);
      if (currentIo) currentIo.emit('server:status', { serverId: server.id, status: 'stopped' });
      events.emit('server:power', { serverId: server.id, action: 'stop' });
      return;
    }

    if (action === 'start' || action === 'restart') {
      if (server.needs_recreate) {
        if (server.container_id) {
          await dockerService.removeContainer(server.container_id).catch(() => {});
        }
        db.prepare("UPDATE servers SET container_id = NULL, container_name = NULL, status = 'stopped' WHERE id = ?")
          .run(server.id);
        const fresh = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);
        let created;
        try {
          created = await dockerService.createServerContainer(fresh);
        } catch (err) {
          db.prepare("UPDATE servers SET status = 'error' WHERE id = ?").run(server.id);
          throw err;
        }
        db.prepare('UPDATE servers SET container_id = ?, container_name = ?, needs_recreate = 0 WHERE id = ?')
          .run(created.containerId, created.containerName, server.id);
        const ready = db.prepare('SELECT * FROM servers WHERE id = ?').get(server.id);
        await dockerService.startContainer(created.containerId, ready);
        db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('starting', server.id);
        if (currentIo) require('../websocket/logs').startLogStream(currentIo, server.id);
      } else if (action === 'start') {
        await dockerService.startContainer(server.container_id, server);
        db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('starting', server.id);
        if (currentIo) require('../websocket/logs').startLogStream(currentIo, server.id);
      } else {
        await dockerService.restartContainer(server.container_id, server);
        db.prepare('UPDATE servers SET status = ? WHERE id = ?').run('starting', server.id);
        if (currentIo) require('../websocket/logs').startLogStream(currentIo, server.id);
      }
      if (currentIo) currentIo.emit('server:status', { serverId: server.id, status: 'starting' });
      events.emit('server:power', { serverId: server.id, action });
      return;
    }

    throw new Error(`Action power inconnue : ${action}`);
  });
}

async function runStep(server, step) {
  const rcon = require('./rcon');
  const backupService = require('./backup');

  switch (step.type) {
    case 'command':
      await rcon.sendCommand(server, step.command);
      return;
    case 'say':
      await rcon.sendCommand(server, `say ${step.message}`);
      return;
    case 'wait':
      await sleep(step.seconds * 1000);
      return;
    case 'power':
      await executePowerAction(server.id, step.action);
      return;
    case 'backup':
      await backupService.createBackup(server, 'scheduled');
      return;
    default:
      throw new Error(`Type d'étape inconnu : ${step.type}`);
  }
}

/**
 * Enregistre le résultat d'une exécution et conserve uniquement les 50 dernières entrées par tâche.
 */
function recordRun(scheduleId, startedAt, status, message) {
  const db = getDb();
  const existingSchedule = db.prepare('SELECT id FROM schedules WHERE id = ?').get(scheduleId);
  if (!existingSchedule) return null;

  const finishedAt = new Date().toISOString();
  const runId = uuidv4();

  db.prepare(`
    INSERT INTO schedule_runs (id, schedule_id, started_at, finished_at, status, message)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(runId, scheduleId, startedAt, finishedAt, status, message || null);

  db.prepare(`
    DELETE FROM schedule_runs
    WHERE schedule_id = ?
      AND id NOT IN (
        SELECT id FROM schedule_runs
        WHERE schedule_id = ?
        ORDER BY started_at DESC, rowid DESC
        LIMIT ?
      )
  `).run(scheduleId, scheduleId, MAX_RUNS_PER_SCHEDULE);

  db.prepare(`
    UPDATE schedules
    SET last_run_at = ?, last_status = ?, last_error = ?
    WHERE id = ?
  `).run(startedAt, status, status === 'failed' ? (message || 'Erreur inconnue') : null, scheduleId);

  return db.prepare('SELECT * FROM schedule_runs WHERE id = ?').get(runId);
}

/**
 * Exécute une tâche planifiée étape par étape.
 * Si une étape échoue, les suivantes sont annulées et l'erreur est enregistrée.
 */
async function executeSchedule(schedule) {
  if (runningSchedules.has(schedule.id)) {
    throw Object.assign(new Error('Tâche déjà en cours d\'exécution'), { status: 409 });
  }
  runningSchedules.add(schedule.id);
  const startedAt = new Date().toISOString();

  try {
    const db = getDb();
    let server = db.prepare('SELECT * FROM servers WHERE id = ?').get(schedule.server_id);
    if (!server) {
      return recordRun(schedule.id, startedAt, 'failed', 'Serveur introuvable');
    }

    let steps;
    try {
      steps = JSON.parse(schedule.steps_json || '[]');
      if (!Array.isArray(steps)) throw new Error('Format des étapes invalide');
    } catch (err) {
      return recordRun(schedule.id, startedAt, 'failed', err.message);
    }

    if (schedule.only_if_players === 'online' || schedule.only_if_players === 'empty') {
      const rcon = require('./rcon');
      const playerList = await rcon.getPlayerList(server);
      const onlineCount = Number(playerList?.online || 0);
      if (schedule.only_if_players === 'online' && onlineCount <= 0) {
        return recordRun(schedule.id, startedAt, 'skipped', 'Condition joueurs non remplie : aucun joueur en ligne');
      }
      if (schedule.only_if_players === 'empty' && onlineCount > 0) {
        return recordRun(schedule.id, startedAt, 'skipped', `Condition joueurs non remplie : ${onlineCount} joueur(s) en ligne`);
      }
    }

    for (const step of steps) {
      // Vérifie que serveur et tâche existent toujours entre deux étapes (ex. après un wait)
      server = db.prepare('SELECT * FROM servers WHERE id = ?').get(schedule.server_id);
      if (!server) {
        return recordRun(schedule.id, startedAt, 'failed', 'Serveur supprimé pendant l\'exécution');
      }
      const stillExists = db.prepare('SELECT id FROM schedules WHERE id = ?').get(schedule.id);
      if (!stillExists) return null;

      await runStep(server, step);
    }

    return recordRun(schedule.id, startedAt, 'success', `${steps.length} étape(s) exécutée(s)`);
  } catch (err) {
    return recordRun(schedule.id, startedAt, 'failed', err?.message || 'Erreur inconnue');
  } finally {
    runningSchedules.delete(schedule.id);
  }
}

/**
 * Vérifie les tâches dues et lance leur exécution sans bloquer la boucle.
 */
async function tick() {
  let db;
  try {
    db = getDb();
  } catch {
    return;
  }

  const now = new Date();
  const nowIso = now.toISOString();

  // Filet de sécurité : complète next_run_at si une tâche active n'en a pas encore
  const missingNext = db.prepare(`
    SELECT * FROM schedules
    WHERE enabled = 1 AND trigger_type IN ('cron', 'interval') AND next_run_at IS NULL
  `).all();
  for (const s of missingNext) {
    try {
      const next = computeNextRunAt(s, now);
      db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(next, s.id);
    } catch {}
  }

  const due = db.prepare(`
    SELECT * FROM schedules
    WHERE enabled = 1 AND trigger_type IN ('cron', 'interval') AND next_run_at IS NOT NULL AND next_run_at <= ?
  `).all(nowIso);

  for (const schedule of due) {
    try {
      const next = computeNextRunAt(schedule, now);
      db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(next, schedule.id);
    } catch (err) {
      console.error(`[Scheduler] Calcul next_run_at impossible pour ${schedule.id} :`, err.message);
    }

    if (runningSchedules.has(schedule.id)) continue;
    executeSchedule(schedule).catch(err => {
      if (err?.status !== 409) {
        console.error(`[Scheduler] Erreur tâche ${schedule.id} :`, err?.message || err);
      }
    });
  }
}

function triggerEventSchedules(serverId, eventName) {
  if (!serverId) return;
  let db;
  try {
    db = getDb();
  } catch {
    return;
  }
  const schedules = db.prepare(`
    SELECT * FROM schedules
    WHERE server_id = ? AND enabled = 1 AND trigger_type = 'event' AND event = ?
  `).all(serverId, eventName);

  for (const schedule of schedules) {
    if (runningSchedules.has(schedule.id)) continue;
    executeSchedule(schedule).catch(err => {
      if (err?.status !== 409) {
        console.error(`[Scheduler] Erreur événement ${eventName} (${schedule.id}) :`, err?.message || err);
      }
    });
  }
}

function scheduleNextTick() {
  if (!started) return;
  loopTimer = setTimeout(async () => {
    try {
      await tick();
    } catch (err) {
      console.error('[Scheduler] Erreur boucle :', err?.message || err);
    } finally {
      scheduleNextTick();
    }
  }, TICK_MS);
  loopTimer.unref?.();
}

/**
 * Démarre la boucle de planification et les abonnements aux événements.
 * @param {{ events?: any, io?: any }} [opts]
 */
function start({ events = require('./events'), io = null } = {}) {
  if (io) currentIo = io;
  if (started) return;
  started = true;

  for (const evName of BUS_EVENTS) {
    const off = events.on(evName, payload => {
      const serverId = payload?.serverId;
      if (!serverId) return;
      triggerEventSchedules(serverId, evName);
      if (evName === 'player:leave') {
        try {
          const row = getDb()
            .prepare('SELECT COUNT(*) AS count FROM players WHERE server_id = ? AND is_online = 1')
            .get(serverId);
          if (row && row.count === 0) {
            triggerEventSchedules(serverId, 'server:empty');
          }
        } catch {}
      }
    });
    unsubs.push(off);
  }

  scheduleNextTick();
}

function stop() {
  started = false;
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
  for (const off of unsubs) {
    try { off(); } catch {}
  }
  unsubs = [];
}

module.exports = {
  parseCron,
  nextRun,
  computeNextRunAt,
  executeSchedule,
  tick,
  start,
  stop,
  PRESETS,
  VALID_EVENTS,
  _internals: { runningSchedules, TICK_MS },
};
