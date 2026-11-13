const { AUTH_ANY, jsonBody, jsonResp, okResp, errResp, pathParam, stdAuthErrors } = require('../helpers');

const serverIdParam = pathParam('id', 'Identifiant UUID du serveur');
const profileIdParam = pathParam('pid', 'Identifiant UUID du profil');

module.exports = {
  '/api/servers/{id}/profiles': {
    get: {
      tags: ['Profils'],
      summary: 'Lister les profils d\'installation d\'un serveur',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: {
        200: jsonResp('Liste des profils', {
          type: 'object',
          properties: {
            profiles: { type: 'array', items: { type: 'object' } },
            activeId: { type: ['string', 'null'] },
          },
        }),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
    post: {
      tags: ['Profils'],
      summary: 'Sauvegarder la configuration actuelle comme nouveau profil',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      requestBody: jsonBody({
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', minLength: 1 } },
      }, { example: { name: 'Survie 1.21' } }),
      responses: {
        201: jsonResp('Profil créé', { type: 'object' }),
        400: errResp('Nom invalide'),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/profiles/new': {
    post: {
      tags: ['Profils'],
      summary: 'Créer et activer un nouveau profil avec une installation vierge ou modpack',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      requestBody: jsonBody({
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          source: { type: 'string' },
          modpack_id: { type: 'string' },
          modpack_name: { type: 'string' },
          modpack_version_id: { type: 'string' },
          modpack_version_name: { type: 'string' },
          mc_version: { type: 'string' },
          loader: { type: 'string' },
          server_type: { type: 'string' },
        },
      }),
      responses: {
        201: jsonResp('Nouveau profil créé et activé', { type: 'object' }),
        400: errResp('Paramètres invalides'),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/profiles/{pid}/activate': {
    post: {
      tags: ['Profils'],
      summary: 'Basculer le serveur vers un autre profil',
      security: AUTH_ANY,
      parameters: [serverIdParam, profileIdParam],
      responses: {
        200: jsonResp('Profil activé', { type: 'object' }),
        400: errResp('Le serveur doit être arrêté'),
        404: errResp('Serveur ou profil introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/profiles/{pid}': {
    patch: {
      tags: ['Profils'],
      summary: 'Renommer un profil existant',
      security: AUTH_ANY,
      parameters: [serverIdParam, profileIdParam],
      requestBody: jsonBody({
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', minLength: 1 } },
      }),
      responses: {
        200: jsonResp('Profil renommé', { type: 'object' }),
        400: errResp('Nom invalide'),
        404: errResp('Serveur ou profil introuvable'),
        ...stdAuthErrors,
      },
    },
    delete: {
      tags: ['Profils'],
      summary: 'Supprimer un profil inactif',
      security: AUTH_ANY,
      parameters: [serverIdParam, profileIdParam],
      responses: {
        200: okResp(),
        400: errResp('Impossible de supprimer le profil actif'),
        404: errResp('Serveur ou profil introuvable'),
        ...stdAuthErrors,
      },
    },
  },
};
