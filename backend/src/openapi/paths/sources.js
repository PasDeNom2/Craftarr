const { AUTH_ANY, jsonBody, jsonResp, okResp, errResp, pathParam, stdAuthErrors } = require('../helpers');

const idParam = pathParam('id', 'Identifiant de la source API');

module.exports = {
  '/api/sources': {
    get: {
      tags: ['Sources'],
      summary: 'Lister les sources de modpacks configurées (admin)',
      security: AUTH_ANY,
      responses: {
        200: jsonResp('Liste des sources', { type: 'array', items: { type: 'object' } }),
        ...stdAuthErrors,
      },
    },
    post: {
      tags: ['Sources'],
      summary: 'Ajouter une source personnalisée de modpacks (admin)',
      security: AUTH_ANY,
      requestBody: jsonBody({
        type: 'object',
        required: ['name', 'base_url', 'format'],
        properties: {
          name: { type: 'string' },
          base_url: { type: 'string', format: 'uri' },
          api_key: { type: 'string' },
          format: { type: 'string', enum: ['curseforge', 'modrinth', 'custom'] },
          field_mapping_json: { type: ['object', 'null'] },
        },
      }),
      responses: {
        201: jsonResp('Source créée', { type: 'object' }),
        400: errResp('Champs requis manquants'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/sources/{id}': {
    patch: {
      tags: ['Sources'],
      summary: 'Modifier une source API ou sa clé (admin)',
      security: AUTH_ANY,
      parameters: [idParam],
      requestBody: jsonBody({
        type: 'object',
        properties: {
          name: { type: 'string' },
          base_url: { type: 'string' },
          api_key: { type: ['string', 'null'] },
          format: { type: 'string' },
          field_mapping_json: { type: ['object', 'null'] },
          enabled: { type: 'boolean' },
        },
      }),
      responses: {
        200: jsonResp('Source mise à jour', { type: 'object' }),
        404: errResp('Source introuvable'),
        ...stdAuthErrors,
      },
    },
    delete: {
      tags: ['Sources'],
      summary: 'Supprimer une source personnalisée (admin)',
      security: AUTH_ANY,
      parameters: [idParam],
      responses: {
        200: okResp('Source supprimée'),
        403: errResp('Impossible de supprimer une source native'),
        404: errResp('Source introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/sources/{id}/test': {
    post: {
      tags: ['Sources'],
      summary: 'Tester la connexion à une source API (admin)',
      security: AUTH_ANY,
      parameters: [idParam],
      responses: {
        200: jsonResp('Résultat du test de connexion', { type: 'object' }),
        404: errResp('Source introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/sources/export': {
    get: {
      tags: ['Sources'],
      summary: 'Exporter les sources personnalisées en JSON (admin)',
      security: AUTH_ANY,
      responses: {
        200: jsonResp('Tableau des sources personnalisées', { type: 'array', items: { type: 'object' } }),
        ...stdAuthErrors,
      },
    },
  },
  '/api/sources/import': {
    post: {
      tags: ['Sources'],
      summary: 'Importer des sources personnalisées depuis un JSON (admin)',
      security: AUTH_ANY,
      requestBody: jsonBody({ type: 'array', items: { type: 'object' } }),
      responses: {
        200: jsonResp('Nombre de sources importées', { type: 'object', properties: { imported: { type: 'integer' } } }),
        400: errResp('Format invalide'),
        ...stdAuthErrors,
      },
    },
  },
};
