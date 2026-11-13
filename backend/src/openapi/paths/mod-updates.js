const { AUTH_ANY, jsonBody, jsonResp, errResp, pathParam, queryParam, stdAuthErrors } = require('../helpers');

const serverIdParam = pathParam('id', 'Identifiant UUID du serveur');

module.exports = {
  '/api/servers/{id}/mods/updates': {
    get: {
      tags: ['Mods'],
      summary: 'Rechercher les mises à jour disponibles pour les mods/plugins du serveur',
      security: AUTH_ANY,
      parameters: [
        serverIdParam,
        queryParam('refresh', 'Forcer l\'actualisation du cache', { type: 'string', enum: ['0', '1'] }),
        queryParam('force', 'Alias pour ignorer le cache', { type: 'string', enum: ['0', '1'] }),
      ],
      responses: {
        200: jsonResp('Mises à jour disponibles', { type: 'object' }),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
    post: {
      tags: ['Mods'],
      summary: 'Appliquer les mises à jour de mods/plugins sélectionnés',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      requestBody: jsonBody({
        type: 'object',
        required: ['files'],
        properties: {
          files: {
            oneOf: [
              { type: 'string', enum: ['all'] },
              { type: 'array', items: { type: 'string' } },
            ],
          },
        },
      }, { example: { files: 'all' } }),
      responses: {
        200: jsonResp('Résultat des mises à jour', { type: 'object' }),
        400: errResp('Sélection invalide'),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
};
