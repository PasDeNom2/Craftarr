// Routes CRUD, exécution immédiate, historique et préréglages du planificateur de tâches.
const express = require('express');
const { randomUUID: uuidv4 } = require('crypto');
const { getDb } = require('../../config/database');
const authMiddleware = require('../../middleware/auth');
const validate = require('../../services/validate');
const scheduler = require('../../services/scheduler');

const router = express.Router();

const TRIGGER_TYPES = ['cron', 'interval', 'event'];
const PLAYER_CONDITIONS = ['any', 'online', 'empty'];
const STEP_TYPES = ['command', 'say', 'wait', 'power', 'backup'];
const POWER_ACTIONS = ['start', 'stop', 'restart'];

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function formatSchedule(row) {
  let steps = [];
  try {
    steps = JSON.parse(row.steps_json || '[]');
  } catch {
    steps = [];
  }
  return {
    ...row,
    enabled: !!row.enabled,
    steps,
  };
}

/**
 * Valide un tableau de 1 à 20 étapes et retourne sa forme normalisée.
 */
function validateSteps(rawSteps) {
  let steps = rawSteps;
  if (typeof steps === 'string') {
    try {
      steps = JSON.parse(steps);
    } catch {
      throw badRequest('«steps» doit être un tableau JSON valide');
    }
  }
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 20) {
    throw badRequest('«steps» doit contenir entre 1 et 20 étapes');
  }

  return steps.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw badRequest(`Étape ${index + 1} invalide`);
    }
    const type = validate.oneOf(step.type, STEP_TYPES, `steps[${index}].type`);
    switch (type) {
      case 'command': {
        const command = validate.str(step.command, {
          max: 256,
          field: `steps[${index}].command`,
          noNewlines: true,
        });
        return { type, command };
      }
      case 'say': {
        const message = validate.str(step.message, {
          max: 256,
          field: `steps[${index}].message`,
          noNewlines: true,
        });
        return { type, message };
      }
      case 'wait': {
        const seconds = validate.int(step.seconds, {
          min: 1,
          max: 3600,
          field: `steps[${index}].seconds`,
        });
        return { type, seconds };
      }
      case 'power': {
        const action = validate.oneOf(step.action, POWER_ACTIONS, `steps[${index}].action`);
        return { type, action };
      }
      case 'backup':
        return { type };
      default:
        throw badRequest(`Type d'étape non supporté : ${type}`);
    }
  });
}

/**
 * Valide et normalise les champs du déclencheur (cron, interval ou event).
 */
function validateTrigger(triggerType, rawCron, rawInterval, rawEvent) {
  const trigger_type = validate.oneOf(triggerType, TRIGGER_TYPES, 'trigger_type');

  if (trigger_type === 'cron') {
    const cron = validate.str(rawCron, { max: 100, field: 'cron', noNewlines: true });
    try {
      scheduler.parseCron(cron);
    } catch (err) {
      throw badRequest(`Expression cron invalide : ${err.message}`);
    }
    return { trigger_type, cron, interval_minutes: null, event: null };
  }

  if (trigger_type === 'interval') {
    const interval_minutes = validate.int(rawInterval, {
      min: 1,
      max: 525600,
      field: 'interval_minutes',
    });
    return { trigger_type, cron: null, interval_minutes, event: null };
  }

  const event = validate.oneOf(rawEvent, scheduler.VALID_EVENTS, 'event');
  return { trigger_type, cron: null, interval_minutes: null, event };
}

// GET /api/schedule-presets — monté hors de /api/servers : la route cœur GET /api/servers/:id
// (montée avant les fonctionnalités) intercepterait « schedule-presets » comme identifiant.
const presetsRouter = express.Router();
presetsRouter.get('/', authMiddleware, (req, res) => {
  res.json(scheduler.PRESETS);
});

// Au-delà de ce délai, « Exécuter maintenant » répond 202 et la tâche continue en arrière-plan
// (une tâche avec des attentes peut durer plusieurs minutes).
const RUN_RESPONSE_WAIT_MS = 15_000;

// GET /api/servers/:id/schedules
router.get('/:id/schedules', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT id FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });

    const rows = db.prepare(
      'SELECT * FROM schedules WHERE server_id = ? ORDER BY created_at DESC, rowid DESC'
    ).all(req.params.id);
    res.json(rows.map(formatSchedule));
  } catch (err) {
    next(err);
  }
});

// POST /api/servers/:id/schedules
router.post('/:id/schedules', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT id FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });

    const name = validate.str(req.body.name, { max: 100, field: 'name', noNewlines: true });
    const enabled = req.body.enabled === undefined
      ? 1
      : (validate.bool(req.body.enabled, 'enabled') ? 1 : 0);
    const trigger = validateTrigger(
      req.body.trigger_type,
      req.body.cron,
      req.body.interval_minutes,
      req.body.event,
    );
    const only_if_players = req.body.only_if_players === undefined
      ? 'any'
      : validate.oneOf(req.body.only_if_players, PLAYER_CONDITIONS, 'only_if_players');
    const rawSteps = req.body.steps !== undefined ? req.body.steps : req.body.steps_json;
    const steps = validateSteps(rawSteps);
    const steps_json = JSON.stringify(steps);

    const next_run_at = scheduler.computeNextRunAt({
      enabled,
      trigger_type: trigger.trigger_type,
      cron: trigger.cron,
      interval_minutes: trigger.interval_minutes,
    });

    const id = uuidv4();
    db.prepare(`
      INSERT INTO schedules (
        id, server_id, name, enabled, trigger_type, cron, interval_minutes, event,
        only_if_players, steps_json, next_run_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      server.id,
      name,
      enabled,
      trigger.trigger_type,
      trigger.cron,
      trigger.interval_minutes,
      trigger.event,
      only_if_players,
      steps_json,
      next_run_at,
    );

    const created = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
    res.status(201).json(formatSchedule(created));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/servers/:id/schedules/:sid
router.patch('/:id/schedules/:sid', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM schedules WHERE id = ? AND server_id = ?')
      .get(req.params.sid, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Tâche planifiée introuvable' });

    const hasUpdatable = [
      'name', 'enabled', 'trigger_type', 'cron', 'interval_minutes', 'event', 'only_if_players', 'steps', 'steps_json',
    ].some(k => req.body[k] !== undefined);
    if (!hasUpdatable) {
      throw badRequest('Aucun champ modifiable fourni');
    }

    const name = req.body.name !== undefined
      ? validate.str(req.body.name, { max: 100, field: 'name', noNewlines: true })
      : existing.name;
    const enabled = req.body.enabled !== undefined
      ? (validate.bool(req.body.enabled, 'enabled') ? 1 : 0)
      : existing.enabled;

    const nextTriggerType = req.body.trigger_type !== undefined ? req.body.trigger_type : existing.trigger_type;
    const nextCron = req.body.cron !== undefined ? req.body.cron : existing.cron;
    const nextInterval = req.body.interval_minutes !== undefined ? req.body.interval_minutes : existing.interval_minutes;
    const nextEvent = req.body.event !== undefined ? req.body.event : existing.event;
    const trigger = validateTrigger(nextTriggerType, nextCron, nextInterval, nextEvent);

    const only_if_players = req.body.only_if_players !== undefined
      ? validate.oneOf(req.body.only_if_players, PLAYER_CONDITIONS, 'only_if_players')
      : existing.only_if_players;

    let steps_json = existing.steps_json;
    if (req.body.steps !== undefined || req.body.steps_json !== undefined) {
      const rawSteps = req.body.steps !== undefined ? req.body.steps : req.body.steps_json;
      steps_json = JSON.stringify(validateSteps(rawSteps));
    }

    const scheduleChanged = (
      enabled !== existing.enabled ||
      trigger.trigger_type !== existing.trigger_type ||
      trigger.cron !== existing.cron ||
      trigger.interval_minutes !== existing.interval_minutes ||
      !existing.next_run_at
    );

    const next_run_at = !enabled || trigger.trigger_type === 'event'
      ? null
      : (scheduleChanged
          ? scheduler.computeNextRunAt({
              enabled,
              trigger_type: trigger.trigger_type,
              cron: trigger.cron,
              interval_minutes: trigger.interval_minutes,
            })
          : existing.next_run_at);

    db.prepare(`
      UPDATE schedules
      SET name = ?, enabled = ?, trigger_type = ?, cron = ?, interval_minutes = ?,
          event = ?, only_if_players = ?, steps_json = ?, next_run_at = ?
      WHERE id = ? AND server_id = ?
    `).run(
      name,
      enabled,
      trigger.trigger_type,
      trigger.cron,
      trigger.interval_minutes,
      trigger.event,
      only_if_players,
      steps_json,
      next_run_at,
      existing.id,
      req.params.id,
    );

    const updated = db.prepare('SELECT * FROM schedules WHERE id = ?').get(existing.id);
    res.json(formatSchedule(updated));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/servers/:id/schedules/:sid
router.delete('/:id/schedules/:sid', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const existing = db.prepare('SELECT id FROM schedules WHERE id = ? AND server_id = ?')
      .get(req.params.sid, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Tâche planifiée introuvable' });

    db.prepare('DELETE FROM schedules WHERE id = ? AND server_id = ?')
      .run(req.params.sid, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/servers/:id/schedules/:sid/run
router.post('/:id/schedules/:sid/run', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const schedule = db.prepare('SELECT * FROM schedules WHERE id = ? AND server_id = ?')
      .get(req.params.sid, req.params.id);
    if (!schedule) return res.status(404).json({ error: 'Tâche planifiée introuvable' });

    if (scheduler._internals.runningSchedules.has(schedule.id)) {
      return res.status(409).json({ error: "Tâche déjà en cours d'exécution" });
    }
    const runPromise = scheduler.executeSchedule(schedule);
    runPromise.catch(err => console.error(`[Scheduler] Erreur tâche ${schedule.id} :`, err?.message || err));
    let timer;
    const pending = new Promise(resolve => {
      timer = setTimeout(() => resolve('pending'), RUN_RESPONSE_WAIT_MS);
    });
    const result = await Promise.race([runPromise, pending]);
    clearTimeout(timer);
    if (result === 'pending') {
      return res.status(202).json({ status: 'running', schedule_id: schedule.id });
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/servers/:id/schedules/:sid/runs
router.get('/:id/schedules/:sid/runs', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const existing = db.prepare('SELECT id FROM schedules WHERE id = ? AND server_id = ?')
      .get(req.params.sid, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Tâche planifiée introuvable' });

    const runs = db.prepare(
      'SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 50'
    ).all(req.params.sid);
    res.json(runs);
  } catch (err) {
    next(err);
  }
});

module.exports = [
  { mount: '/api/schedule-presets', router: presetsRouter },
  { mount: '/api/servers', router },
];
