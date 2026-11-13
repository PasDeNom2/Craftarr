const { AUTH_ANY, jsonResp, errResp, pathParam, stdAuthErrors } = require('../helpers');

const serverIdParam = pathParam('id', 'Identifiant UUID du serveur');

const bluemapStateSchema = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    port: { type: ['integer', 'null'] },
    installed: { type: 'boolean' },
  },
};

const bluemapMutationSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    enabled: { type: 'boolean' },
    port: { type: ['integer', 'null'] },
    installed: { type: 'boolean' },
    needs_recreate: { type: 'boolean' },
    server: { type: 'object' },
  },
};

module.exports = {
  '/api/servers/{id}/bluemap': {
    get: {
      tags: ['BlueMap'],
      summary: 'Obtenir l\'état de la carte web BlueMap pour un serveur',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: {
        200: jsonResp('État BlueMap', bluemapStateSchema, { enabled: true, port: 8100, installed: true }),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/bluemap/enable': {
    post: {
      tags: ['BlueMap'],
      summary: 'Activer et installer BlueMap sur un serveur',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: {
        200: jsonResp('BlueMap activé', bluemapMutationSchema),
        400: errResp('BlueMap incompatible avec ce type de serveur'),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/bluemap/disable': {
    post: {
      tags: ['BlueMap'],
      summary: 'Désactiver BlueMap sur un serveur',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: {
        200: jsonResp('BlueMap désactivé', bluemapMutationSchema),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
};
