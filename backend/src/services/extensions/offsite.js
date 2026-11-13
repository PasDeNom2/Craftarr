// Extension sauvegardes hors site : champ serveur `offsite_enabled` et déclenchement sur `backup:created`.
const { getDb } = require('../../config/database');
const validate = require('../validate');
const offsite = require('../offsite');

let unsubscribe = null;

module.exports = {
  name: 'offsite',

  fields: {
    offsite_enabled: {
      parse: v => (validate.bool(v, 'offsite_enabled') ? 1 : 0),
      container: false,
    },
  },

  decorate(row) {
    return { offsite_enabled: !!row.offsite_enabled };
  },

  init({ events }) {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    if (!events || typeof events.on !== 'function') return;
    unsubscribe = events.on('backup:created', ({ serverId, backup }) => {
      if (!backup || !['scheduled', 'manual'].includes(backup.trigger)) return;
      const server = getDb().prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
      if (!server || !server.offsite_enabled) return;
      if (!offsite.isConfigured()) return;
      offsite.enqueueBackup(server).catch(err => {
        console.error(`[Offsite] Échec de la copie hors site pour ${server.name} :`, err.message);
      });
    });
  },
};
