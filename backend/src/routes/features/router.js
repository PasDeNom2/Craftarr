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

/**
 * État du container mc-router. Filtre sur le nom d'image (l'image est épinglée, ex.
 * itzg/mc-router:1.55.0 : le filtre Docker « ancestor » sans tag ne la trouverait pas).
 */
async function routerContainerStatus() {
  const containers = await dockerService.docker.listContainers({ all: true });
  const matching = (Array.isArray(containers) ? containers : [])
    .filter(c => String(c.Image || '').startsWith('itzg/mc-router'));
  const runningContainer = matching.find(
    c => c.State === 'running' || String(c.Status || '').toLowerCase().startsWith('up')
  );
  const anyContainer = runningContainer || matching[0] || null;
  return {
    running: Boolean(runningContainer),
    exists: Boolean(anyContainer),
    state: anyContainer?.State || 'missing',
    containerId: anyContainer?.Id ? String(anyContainer.Id).slice(0, 12) : null,
  };
}

// PUT /api/router/settings
router.put('/settings', authMiddleware, async (req, res, next) => {
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
    // Activer le routeur retire la publication des ports de jeu : sans mc-router lancé, tous les
    // serveurs deviendraient injoignables (constaté en test réel).
    if (nextEnabled && !currentEnabled) {
      let status = null;
      try { status = await routerContainerStatus(); } catch { /* Docker indisponible */ }
      if (!status?.running) {
        return res.status(409).json({
          error: 'mc-router ne tourne pas : lancez d\'abord « docker compose --profile router up -d », puis activez le routeur',
        });
      }
    }

    appSettings.set('router_enabled', nextEnabled ? '1' : '0');
    appSettings.set('router_domain', nextDomain);
    // Publication des ports et labels changent : les containers existants doivent être recréés
    // (appliqué au prochain démarrage/redémarrage de chaque serveur)
    if (nextEnabled !== currentEnabled || (nextEnabled && nextDomain !== currentDomain)) {
      require('../../config/database').getDb().prepare('UPDATE servers SET needs_recreate = 1 WHERE container_id IS NOT NULL').run();
    }

    res.json(buildSettingsPayload());
  } catch (err) {
    next(err);
  }
});

// GET /api/router/status
router.get('/status', authMiddleware, async (req, res) => {
  try {
    res.json(await routerContainerStatus());
  } catch (err) {
    res.json({ running: false, exists: false, state: 'unavailable', containerId: null, error: err.message });
  }
});

module.exports = { mount: '/api/router', router };
