const { AUTH_ANY, jsonBody, jsonResp, errResp, stdAuthErrors } = require('../helpers');

module.exports = {
  '/api/router/settings': {
    get: {
      tags: ['Routeur'],
      summary: 'Lire la configuration du routeur par sous-domaine (mc-router)',
      security: AUTH_ANY,
      responses: {
        200: jsonResp('Paramètres du routeur', {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            domain: { type: 'string' },
          },
        }),
        ...stdAuthErrors,
      },
    },
    put: {
      tags: ['Routeur'],
      summary: 'Activer/désactiver mc-router et configurer le domaine (administrateur)',
      security: AUTH_ANY,
      requestBody: jsonBody({
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          domain: { type: 'string', example: 'mc.example.com' },
        },
      }),
      responses: {
        200: jsonResp('Paramètres mis à jour', { type: 'object' }),
        400: errResp('Configuration invalide'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/router/status': {
    get: {
      tags: ['Routeur'],
      summary: 'Consulter l\'état en direct du conteneur mc-router et des routes actives',
      security: AUTH_ANY,
      responses: {
        200: jsonResp('État du routeur', { type: 'object' }),
        ...stdAuthErrors,
      },
    },
  },
};
