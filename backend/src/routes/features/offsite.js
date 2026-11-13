// Routes API pour les sauvegardes hors site (restic).
const express = require('express');
const { getDb } = require('../../config/database');
const authMiddleware = require('../../middleware/auth');
const appSettings = require('../../services/appSettings');
const offsite = require('../../services/offsite');
const serverLock = require('../../services/serverLock');
const validate = require('../../services/validate');

const offsiteRouter = express.Router();
const serverRouter = express.Router();

function readPublicSettings() {
  return {
    offsite_repository: appSettings.get('offsite_repository') || '',
    has_password: appSettings.get('offsite_password') !== null,
    has_env: appSettings.get('offsite_env') !== null,
    offsite_keep_daily: offsite.getKeep('daily'),
    offsite_keep_weekly: offsite.getKeep('weekly'),
    offsite_keep_monthly: offsite.getKeep('monthly'),
  };
}

// ─── Réglages globaux (/api/offsite) ─────────────────────────────────────────

// GET /api/offsite/settings — jamais de secrets renvoyés
offsiteRouter.get('/settings', authMiddleware, (req, res, next) => {
  try {
    res.json(readPublicSettings());
  } catch (err) {
    next(err);
  }
});

// PUT /api/offsite/settings
offsiteRouter.put('/settings', authMiddleware, (req, res, next) => {
  try {
    const body = req.body || {};

    if ('offsite_repository' in body) {
      const raw = body.offsite_repository;
      if (raw === null || raw === '') {
        appSettings.set('offsite_repository', null);
      } else {
        const repo = validate.str(raw, { max: 512, field: 'offsite_repository', noNewlines: true });
        if (repo.startsWith('-') || repo.includes('\0')) {
          return res.status(400).json({ error: '«offsite_repository» invalide' });
        }
        appSettings.set('offsite_repository', repo);
      }
    }

    if ('offsite_password' in body) {
      const raw = body.offsite_password;
      if (raw === null || raw === '') {
        appSettings.set('offsite_password', null);
      } else {
        if (typeof raw !== 'string' || /[\r\n\0]/.test(raw) || raw.length > 1024) {
          return res.status(400).json({ error: '«offsite_password» invalide' });
        }
        appSettings.set('offsite_password', raw);
      }
    }

    if ('offsite_env' in body) {
      const raw = body.offsite_env;
      if (raw === null || raw === '') {
        appSettings.set('offsite_env', null);
      } else {
        if (typeof raw !== 'string' || raw.includes('\0') || raw.length > 16384) {
          return res.status(400).json({ error: '«offsite_env» invalide' });
        }
        const cleaned = offsite.sanitizeEnvText(raw);
        appSettings.set('offsite_env', cleaned || null);
      }
    }

    if ('offsite_keep_daily' in body) {
      const n = validate.int(body.offsite_keep_daily, { min: 0, max: 3650, field: 'offsite_keep_daily' });
      appSettings.set('offsite_keep_daily', String(n));
    }

    if ('offsite_keep_weekly' in body) {
      const n = validate.int(body.offsite_keep_weekly, { min: 0, max: 520, field: 'offsite_keep_weekly' });
      appSettings.set('offsite_keep_weekly', String(n));
    }

    if ('offsite_keep_monthly' in body) {
      const n = validate.int(body.offsite_keep_monthly, { min: 0, max: 120, field: 'offsite_keep_monthly' });
      appSettings.set('offsite_keep_monthly', String(n));
    }

    res.json(readPublicSettings());
  } catch (err) {
    next(err);
  }
});

// POST /api/offsite/test
offsiteRouter.post('/test', authMiddleware, async (req, res, next) => {
  try {
    const result = await offsite.test();
    res.json(result);
  } catch (err) {
    if (!err.status) err.status = 400;
    next(err);
  }
});

// POST /api/offsite/init
offsiteRouter.post('/init', authMiddleware, async (req, res, next) => {
  try {
    const result = await offsite.init();
    res.json(result);
  } catch (err) {
    if (!err.status) err.status = 400;
    next(err);
  }
});

// ─── Par serveur (/api/servers) ──────────────────────────────────────────────

// GET /api/servers/:id/offsite
serverRouter.get('/:id/offsite', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT id, offsite_enabled FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });

    const runs = db.prepare('SELECT * FROM offsite_runs WHERE server_id = ? ORDER BY id DESC LIMIT 20').all(server.id);
    const configured = offsite.isConfigured();

    let snapshots = [];
    let snapshotsError = null;
    if (configured) {
      try {
        snapshots = await offsite.listSnapshots(server.id);
      } catch (err) {
        snapshotsError = err.message;
      }
    }

    res.json({
      configured,
      enabled: !!server.offsite_enabled,
      active: offsite.isServerActive(server.id),
      runs,
      snapshots,
      ...(snapshotsError ? { snapshots_error: snapshotsError } : {}),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/servers/:id/offsite/run
serverRouter.post('/:id/offsite/run', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });
    if (!offsite.isConfigured()) {
      return res.status(400).json({ error: 'Dépôt hors site ou mot de passe non configuré' });
    }
    const busy = serverLock.busyReason(server);
    if (busy) return res.status(409).json({ error: busy });

    offsite.enqueueBackup(server).catch(err => {
      console.error(`[Offsite] Exécution manuelle en échec pour ${server.name} :`, err.message);
    });
    res.json({ ok: true, queued: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/servers/:id/offsite/restore
serverRouter.post('/:id/offsite/restore', authMiddleware, async (req, res, next) => {
  try {
    const { snapshotId } = req.body || {};
    if (!offsite.isValidSnapshotId(snapshotId)) {
      return res.status(400).json({ error: 'Identifiant de snapshot invalide' });
    }

    const db = getDb();
    const server = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });

    const busy = serverLock.busyReason(server);
    if (busy) return res.status(409).json({ error: busy });
    if (offsite.isServerActive(server.id)) {
      return res.status(409).json({ error: 'Une copie hors site de ce serveur est en cours' });
    }

    await offsite.restoreSnapshot(server, snapshotId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = [
  { mount: '/api/offsite', router: offsiteRouter },
  { mount: '/api/servers', router: serverRouter },
];
