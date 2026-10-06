// Réglages globaux (Paramètres) : notifications…
const express = require('express');
const authMiddleware = require('../middleware/auth');
const settings = require('../services/appSettings');
const notify = require('../services/notify');

const router = express.Router();

function validateWebhook(url) {
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch { return 'URL invalide'; }
  if (!['https:', 'http:'].includes(u.protocol)) return 'URL http(s) requise';
  return null;
}

// GET /api/settings
router.get('/', authMiddleware, (req, res) => {
  res.json({ ...settings.all(), notify_env_configured: !!process.env.NOTIFY_WEBHOOK_URL });
});

// PATCH /api/settings
router.patch('/', authMiddleware, (req, res, next) => {
  try {
    const body = req.body || {};
    if ('notify_webhook_url' in body) {
      const url = String(body.notify_webhook_url || '').trim();
      const invalid = validateWebhook(url);
      if (invalid) return res.status(400).json({ error: invalid });
      settings.set('notify_webhook_url', url);
    }
    res.json({ ...settings.all(), notify_env_configured: !!process.env.NOTIFY_WEBHOOK_URL });
  } catch (err) {
    next(err);
  }
});

// POST /api/settings/notify-test — envoie une notification de test
router.post('/notify-test', authMiddleware, async (req, res) => {
  const url = notify.webhookUrl();
  if (!url) return res.status(400).json({ error: 'Aucun webhook configuré' });
  const ok = await notify.send({ title: 'Test', message: 'Les notifications Craftarr fonctionnent ✓', level: 'success' });
  if (!ok) return res.status(502).json({ error: 'Le webhook a refusé la notification (URL incorrecte ?)' });
  res.json({ ok: true });
});

module.exports = router;
