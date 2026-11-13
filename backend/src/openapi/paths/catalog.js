const { AUTH_ANY, jsonResp, errResp, pathParam, queryParam, stdAuthErrors } = require('../helpers');

const sourceParam = pathParam('source', 'Identifiant de la source (ex: curseforge, modrinth)');
const idParam = pathParam('id', 'Identifiant du modpack sur la source');

module.exports = {
  '/api/catalog': {
    get: {
      tags: ['Catalogue'],
      summary: 'Rechercher des modpacks dans les sources configurées',
      security: AUTH_ANY,
      parameters: [
        queryParam('query', 'Mot-clé de recherche'),
        queryParam('mcVersion', 'Version Minecraft (ex: 1.20.1)'),
        queryParam('loader', 'Mod loader (forge, fabric, neoforge, quilt)'),
        queryParam('category', 'Catégorie'),
        queryParam('source', 'Filtrer sur une source'),
        queryParam('limit', 'Nombre max de résultats (défaut 20)', { type: 'integer' }),
        queryParam('offset', 'Décalage de pagination', { type: 'integer' }),
      ],
      responses: {
        200: jsonResp('Résultats agrégés du catalogue', {
          type: 'object',
          properties: { data: { type: 'array', items: { type: 'object' } }, total: { type: 'integer' } },
        }),
        401: stdAuthErrors[401],
      },
    },
  },
  '/api/catalog/{source}/{id}': {
    get: {
      tags: ['Catalogue'],
      summary: 'Obtenir la fiche détaillée d\'un modpack',
      security: AUTH_ANY,
      parameters: [sourceParam, idParam],
      responses: {
        200: jsonResp('Détails du modpack', { type: 'object' }),
        404: errResp('Modpack introuvable'),
        401: stdAuthErrors[401],
      },
    },
  },
  '/api/catalog/{source}/{id}/mods': {
    get: {
      tags: ['Catalogue'],
      summary: 'Lister les mods inclus dans un modpack',
      security: AUTH_ANY,
      parameters: [sourceParam, idParam],
      responses: {
        200: jsonResp('Liste des mods', {
          type: 'object',
          properties: { mods: { type: 'array', items: { type: 'object' } }, total: { type: 'integer' } },
        }),
        404: errResp('Source inconnue'),
        401: stdAuthErrors[401],
      },
    },
  },
  '/api/catalog/{source}/{id}/versions': {
    get: {
      tags: ['Catalogue'],
      summary: 'Lister les versions disponibles d\'un modpack',
      security: AUTH_ANY,
      parameters: [sourceParam, idParam],
      responses: {
        200: jsonResp('Versions du modpack', { type: 'array', items: { type: 'object' } }),
        401: stdAuthErrors[401],
      },
    },
  },
};
