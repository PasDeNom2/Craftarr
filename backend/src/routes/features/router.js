// Routes du routeur mc-router (paramètres globaux + état du container).
const express = require('express');
const authMiddleware = require('../../middleware/auth');
const appSettings = require('../../services/appSettings');
const dockerService = require('../../services/docker');
const validate = require('../../services/validate');
const { _internals: { isValidDomain } } = require('../../services/extensions/router-sleep');

const COMPOSE_COMMAND = 'docker compose --profile router up -d';

function buildSettingsPayload() {
  const enabled = appSettings.get('router_enabled') === '1';
  const domain = (appSettings.get('router_domain') || '').trim().toLowerCase();
  return {
    enabled,
    domain,
    composeCommand: COMPOSE_COMMAND,
    wildcardDns: domain ? `*.${domain}` : '*.exemple.fr',
  };
}

const router = express.Router();

// GET /api/router/settings
router.get('/settings', authMiddleware, (req, res) => {
  res.json(buildSettingsPayload());
});

// PUT /api/router/settings
router.put('/settings', authMiddleware, (req, res, next) => {
  try {
    const body = req.body || {};
    const currentEnabled = appSettings.get('router_enabled') === '1';
    const currentDomain = (appSettings.get('router_domain') || '').trim().toLowerCase();

    const nextEnabled = body.enabled !== undefined
      ? validate.bool(body.enabled, 'enabled')
      : currentEnabled;

    let nextDomain = currentDomain;
    if (body.domain !== undefined) {
      if (body.domain === null) {
        nextDomain = '';
      } else if (typeof body.domain !== 'string') {
        return res.status(400).json({ error: '«domain» doit être une chaîne de caractères' });
      } else {
        nextDomain = body.domain.trim().toLowerCase();
        if (nextDomain !== '' && !isValidDomain(nextDomain)) {
          return res.status(400).json({ error: 'Nom de domaine invalide (ex. mc.exemple.fr)' });
        }
      }
    }

    if (nextEnabled && !nextDomain) {
      return res.status(400).json({ error: 'Un nom de domaine valide est requis pour activer le routeur' });
    }

    appSettings.set('router_enabled', nextEnabled ? '1' : '0');
    appSettings.set('router_domain', nextDomain);

    res.json(buildSettingsPayload());
  } catch (err) {
    next(err);
  }
});

// GET /api/router/status
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const containers = await dockerService.docker.listContainers({
      all: true,
      filters: { ancestor: ['itzg/mc-router'] },
    });
    const list = Array.isArray(containers) ? containers : [];
    const matching = list.filter(c => !c.Image || String(c.Image).includes('itzg/mc-router'));
    const runningContainer = matching.find(
      c => c.State === 'running' || String(c.Status || '').toLowerCase().startsWith('up')
    );
    const anyContainer = runningContainer || matching[0] || null;
    res.json({
      running: Boolean(runningContainer),
      exists: Boolean(anyContainer),
      state: anyContainer?.State || 'missing',
      containerId: anyContainer?.Id ? String(anyContainer.Id).slice(0, 12) : null,
    });
  } catch (err) {
    res.json({
      running: false,
      exists: false,
      state: 'unavailable',
      containerId: null,
      error: err.message,
    });
  }
});

module.exports = { mount: '/api/router', router };
