const { AUTH_ANY, jsonResp, queryParam, stdAuthErrors } = require('../helpers');

module.exports = {
  '/api/vanilla/versions': {
    get: {
      tags: ['Vanilla & Types'],
      summary: 'Lister les versions officielles de Minecraft Vanilla (Mojang)',
      security: AUTH_ANY,
      parameters: [
        queryParam('type', 'Filtrer par type', { type: 'string', enum: ['release', 'snapshot', 'all'], default: 'release' }),
      ],
      responses: {
        200: jsonResp('Manifeste simplifié des versions Vanilla', {
          type: 'object',
          properties: {
            latest: { type: 'object' },
            versions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  type: { type: 'string' },
                  releaseTime: { type: 'string' },
                },
              },
            },
          },
        }),
        401: stdAuthErrors[401],
      },
    },
  },
};
