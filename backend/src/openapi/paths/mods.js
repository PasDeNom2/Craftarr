const {
  AUTH_ANY, jsonBody, multipartBody, jsonResp, errResp, pathParam, queryParam, stdAuthErrors,
} = require('../helpers');

const serverIdParam = pathParam('id', 'Identifiant UUID du serveur');

module.exports = {
  '/api/servers/{id}/mods': {
    get: {
      tags: ['Mods'],
      summary: 'Lister les mods installés et les dépendances manquantes',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: {
        200: jsonResp('Liste des mods installés', { type: 'object' }),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
    patch: {
      tags: ['Mods'],
      summary: 'Activer ou désactiver un mod installé',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      requestBody: jsonBody({
        type: 'object',
        required: ['file', 'enabled'],
        properties: { file: { type: 'string' }, enabled: { type: 'boolean' } },
      }),
      responses: {
        200: jsonResp('Mod mis à jour', { type: 'object', properties: { ok: { type: 'boolean' }, file: { type: 'string' }, restartRequired: { type: 'boolean' } } }),
        404: errResp('Serveur ou mod introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/mods/trash': {
    post: {
      tags: ['Mods'],
      summary: 'Déplacer des mods vers la corbeille (.craftarr/trash/mods)',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      requestBody: jsonBody({
        type: 'object',
        required: ['files'],
        properties: { files: { type: 'array', items: { type: 'string' } } },
      }),
      responses: {
        200: jsonResp('Mods déplacés', { type: 'object', properties: { ok: { type: 'boolean' }, moved: { type: 'array', items: { type: 'string' } }, restartRequired: { type: 'boolean' } } }),
        400: errResp('Aucun mod sélectionné'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/mods/search': {
    get: {
      tags: ['Mods'],
      summary: 'Rechercher des mods compatibles avec le serveur',
      security: AUTH_ANY,
      parameters: [
        serverIdParam,
        queryParam('q', 'Terme de recherche'),
        queryParam('source', 'Filtrer par source', { type: 'string', enum: ['modrinth', 'curseforge'] }),
      ],
      responses: {
        200: jsonResp('Résultats de recherche', { type: 'object' }),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/mods/install': {
    post: {
      tags: ['Mods'],
      summary: 'Installer un mod depuis Modrinth ou CurseForge',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      requestBody: jsonBody({
        type: 'object',
        required: ['source', 'projectId'],
        properties: {
          source: { type: 'string', enum: ['modrinth', 'curseforge'] },
          projectId: { type: 'string' },
        },
      }),
      responses: {
        200: jsonResp('Mod installé', { type: 'object' }),
        400: errResp('Paramètres invalides'),
        404: errResp('Serveur ou mod introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/mods/fix-dependencies': {
    post: {
      tags: ['Mods'],
      summary: 'Installer automatiquement les dépendances manquantes',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: {
        200: jsonResp('Dépendances installées', { type: 'object' }),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/mods/upload': {
    post: {
      tags: ['Mods'],
      summary: 'Téléverser des fichiers .jar de mods',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      requestBody: multipartBody({
        type: 'object',
        required: ['files'],
        properties: { files: { type: 'array', items: { type: 'string', format: 'binary' } } },
      }),
      responses: {
        200: jsonResp('Mods enregistrés', { type: 'object' }),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
};
