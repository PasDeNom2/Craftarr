const { AUTH_ANY, jsonResp, errResp, pathParam, queryParam, stdAuthErrors } = require('../helpers');

module.exports = {
  '/api/vanilla/server-types/{type}/versions': {
    get: {
      tags: ['Vanilla & Types'],
      summary: 'Lister les versions Minecraft disponibles pour Paper ou Purpur',
      security: AUTH_ANY,
      parameters: [
        {
          ...pathParam('type', 'Type de serveur alternatif'),
          schema: { type: 'string', enum: ['paper', 'purpur'] },
        },
        queryParam('refresh', 'Forcer l\'actualisation du cache', { type: 'string', enum: ['0', '1'] }),
      ],
      responses: {
        200: jsonResp('Versions disponibles', {
          type: 'object',
          properties: {
            type: { type: 'string' },
            versions: { type: 'array', items: { type: 'object' } },
          },
        }),
        400: errResp('Type de serveur non supporté'),
        ...stdAuthErrors,
      },
    },
  },
};
