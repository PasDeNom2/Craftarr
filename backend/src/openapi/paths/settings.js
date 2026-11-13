const { AUTH_ANY, jsonBody, jsonResp, okResp, errResp, stdAuthErrors } = require('../helpers');

module.exports = {
  '/api/settings': {
    get: {
      tags: ['Paramètres'],
      summary: 'Lire les réglages globaux de Craftarr (admin)',
      security: AUTH_ANY,
      responses: {
        200: jsonResp('Réglages globaux', { type: 'object' }),
        ...stdAuthErrors,
      },
    },
    patch: {
      tags: ['Paramètres'],
      summary: 'Mettre à jour les réglages globaux (admin)',
      security: AUTH_ANY,
      requestBody: jsonBody({
        type: 'object',
        properties: {
          notify_webhook_url: { type: 'string', description: 'URL http(s) du webhook de notification' },
        },
      }),
      responses: {
        200: jsonResp('Réglages mis à jour', { type: 'object' }),
        400: errResp('URL de webhook invalide'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/settings/notify-test': {
    post: {
      tags: ['Paramètres'],
      summary: 'Envoyer une notification de test vers le webhook configuré (admin)',
      security: AUTH_ANY,
      responses: {
        200: okResp('Notification envoyée'),
        400: errResp('Aucun webhook configuré'),
        502: errResp('Le webhook a refusé la notification'),
        ...stdAuthErrors,
      },
    },
  },
};
