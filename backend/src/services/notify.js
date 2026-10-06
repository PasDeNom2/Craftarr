/**
 * Notifications sortantes (webhook Discord, ou compatible Slack) : crash en boucle, mise à jour
 * réussie ou annulée, backup planifié en échec. Avant, on ne découvrait un serveur planté
 * qu'en ouvrant Craftarr.
 *
 * URL : réglage « notify_webhook_url » (Paramètres → Notifications), sinon NOTIFY_WEBHOOK_URL.
 * Jamais bloquant : une notification qui échoue est seulement journalisée.
 */
const axios = require('axios');
const settings = require('./appSettings');

const LEVEL_COLOR = { error: 0xF2555A, warn: 0xF5B83D, success: 0x3DD68C, info: 0x5B9DF5 };

function webhookUrl() {
  return settings.get('notify_webhook_url') || process.env.NOTIFY_WEBHOOK_URL || '';
}

/** Charge utile : embed Discord + champ « text » lu par Slack et la plupart des webhooks génériques. */
function buildPayload({ title, message, level = 'info', serverName }) {
  const head = serverName ? `${serverName} — ${title}` : title;
  return {
    username: 'Craftarr',
    text: `${head}\n${message}`,
    embeds: [{ title: head, description: message, color: LEVEL_COLOR[level] || LEVEL_COLOR.info, timestamp: new Date().toISOString() }],
  };
}

async function send(event, { url = webhookUrl() } = {}) {
  if (!url) return false;
  try {
    await axios.post(url, buildPayload(event), { timeout: 10000 });
    return true;
  } catch (err) {
    console.warn(`[Notify] Envoi impossible (${err.response?.status || err.message})`);
    return false;
  }
}

/** Fire-and-forget pour les services. */
function notify(event) {
  send(event).catch(() => {});
}

module.exports = { notify, send, buildPayload, webhookUrl };
