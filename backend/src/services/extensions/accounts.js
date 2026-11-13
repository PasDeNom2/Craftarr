// Extension comptes & audit : purge quotidienne du journal d'activité (rétention 90 jours).
const { getDb } = require('../../config/database');

const DAY_MS = 24 * 60 * 60 * 1000;
let purgeTimer = null;

function purgeOldActivity() {
  try {
    const res = getDb().prepare("DELETE FROM activity_log WHERE at < datetime('now', '-90 days')").run();
    if (res.changes > 0) {
      console.log(`[Accounts] ${res.changes} entrée(s) du journal d'activité purgée(s) (> 90 jours)`);
    }
  } catch (err) {
    console.error('[Accounts] Purge du journal impossible :', err.message);
  }
}

function init() {
  purgeOldActivity();
  if (purgeTimer) clearInterval(purgeTimer);
  purgeTimer = setInterval(purgeOldActivity, DAY_MS);
  purgeTimer.unref?.();
}

module.exports = {
  name: 'accounts',
  init,
  purgeOldActivity,
};
