// Extension : démarre l'échantillonneur d'historique des métriques et nettoie à la suppression d'un serveur.
const metricsHistory = require('../metricsHistory');

let unsubscribe = null;
let sigtermBound = false;

module.exports = {
  name: 'metrics-history',
  init({ events }) {
    metricsHistory.start();
    unsubscribe?.();
    unsubscribe = events?.on
      ? events.on('server:deleted', ({ serverId }) => {
          try {
            metricsHistory.deleteServerMetrics(serverId);
          } catch (err) {
            console.error('[MetricsHistory] Erreur nettoyage serveur supprimé :', err.message);
          }
        })
      : null;

    if (!sigtermBound) {
      sigtermBound = true;
      process.once('SIGTERM', () => metricsHistory.stop());
    }
  },
};
