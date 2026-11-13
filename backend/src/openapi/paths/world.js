const {
  AUTH_ANY, AUTH_PUBLIC, multipartBody, jsonResp, errResp, pathParam, queryParam, stdAuthErrors,
} = require('../helpers');

const serverIdParam = pathParam('id', 'Identifiant UUID du serveur');

module.exports = {
  '/api/servers/{id}/world-import': {
    post: {
      tags: ['Monde'],
      summary: 'Importer un monde Minecraft depuis une archive ZIP',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      requestBody: multipartBody({
        type: 'object',
        required: ['world'],
        properties: { world: { type: 'string', format: 'binary' } },
      }),
      responses: {
        200: jsonResp('Monde importé avec succès', { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } } }),
        400: errResp('Archive ZIP invalide ou level.dat absent'),
        404: errResp('Serveur introuvable'),
        409: errResp('Une opération est déjà en cours sur le serveur'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/world-download-token': {
    post: {
      tags: ['Monde'],
      summary: 'Générer un lien de téléchargement signé du monde (5 min, usage unique)',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: {
        200: jsonResp('URL signée de téléchargement', { type: 'object', properties: { url: { type: 'string' } } }),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/world-download': {
    get: {
      tags: ['Monde'],
      summary: 'Télécharger l\'archive ZIP du monde via un jeton signé',
      security: AUTH_PUBLIC,
      parameters: [serverIdParam, queryParam('token', 'Jeton signé obtenu via /world-download-token', { type: 'string' }, true)],
      responses: {
        200: { description: 'Archive ZIP du monde', content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } } },
        401: errResp('Lien de téléchargement invalide ou expiré'),
        404: errResp('Serveur ou monde introuvable'),
      },
    },
  },
};
