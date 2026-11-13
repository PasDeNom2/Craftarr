const { AUTH_ANY, jsonBody, jsonResp, errResp, pathParam, stdAuthErrors } = require('../helpers');

const serverIdParam = pathParam('id', 'Identifiant UUID du serveur');

module.exports = {
  '/api/servers/{id}/geyser': {
    get: {
      tags: ['Geyser'],
      summary: 'Consulter l\'état Geyser / Floodgate (crossplay Bedrock) d\'un serveur',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: {
        200: jsonResp('Configuration Geyser', { type: 'object' }),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/geyser/enable': {
    post: {
      tags: ['Geyser'],
      summary: 'Activer Geyser (et optionnellement Floodgate) sur un serveur',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      requestBody: jsonBody({
        type: 'object',
        properties: { floodgate: { type: 'boolean', default: true } },
      }, { required: false, example: { floodgate: true } }),
      responses: {
        200: jsonResp('Geyser activé', { type: 'object' }),
        400: errResp('Serveur incompatible avec Geyser'),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/geyser/disable': {
    post: {
      tags: ['Geyser'],
      summary: 'Désactiver Geyser / Floodgate sur un serveur',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: {
        200: jsonResp('Geyser désactivé', { type: 'object' }),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
};
