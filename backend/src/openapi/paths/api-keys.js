const { AUTH_SESSION, jsonBody, jsonResp, errResp, pathParam, queryParam, stdAuthErrors } = require('../helpers');

const kidParam = pathParam('kid', 'Identifiant UUID de la clé API');
const apiKeyRef = { $ref: '#/components/schemas/ApiKey' };

module.exports = {
  '/api/api-keys': {
    get: {
      tags: ['Clés API'],
      summary: 'Lister les clés API de l\'utilisateur connecté (session requise)',
      security: AUTH_SESSION,
      parameters: [
        queryParam('all', 'Admin uniquement : « 1 » pour lister les clés de tous les utilisateurs', { type: 'string', enum: ['0', '1'] }),
      ],
      responses: {
        200: jsonResp('Liste des clés API (sans le secret ni le hash)', { type: 'array', items: apiKeyRef }),
        ...stdAuthErrors,
      },
    },
    post: {
      tags: ['Clés API'],
      summary: 'Créer une nouvelle clé API (affichée une seule fois, session requise)',
      security: AUTH_SESSION,
      requestBody: jsonBody({
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', maxLength: 80, example: 'Bot Discord' },
          read_only: { type: 'boolean', default: false },
          expires_in_days: { type: 'integer', minimum: 1, maximum: 3650, nullable: true },
        },
      }),
      responses: {
        201: jsonResp('Clé API créée avec sa valeur secrète affichée une seule fois', {
          allOf: [
            apiKeyRef,
            { type: 'object', properties: { key: { type: 'string', example: 'cra_...' } }, required: ['key'] },
          ],
        }),
        400: errResp('Paramètres invalides ou limite de 25 clés actives atteinte'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/api-keys/{kid}': {
    delete: {
      tags: ['Clés API'],
      summary: 'Révoquer définitivement une clé API (session requise)',
      security: AUTH_SESSION,
      parameters: [kidParam],
      responses: {
        200: jsonResp('Clé API révoquée', {
          type: 'object',
          properties: { ok: { type: 'boolean' }, id: { type: 'string' }, revoked: { type: 'boolean' } },
        }),
        404: errResp('Clé API introuvable'),
        ...stdAuthErrors,
      },
    },
  },
};
