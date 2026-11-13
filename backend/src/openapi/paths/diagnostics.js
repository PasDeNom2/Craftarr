const { AUTH_ANY, jsonBody, jsonResp, errResp, pathParam, queryParam, stdAuthErrors } = require('../helpers');

const serverIdParam = pathParam('id', 'Identifiant UUID du serveur');

module.exports = {
  '/api/servers/{id}/diagnostics': {
    get: {
      tags: ['Diagnostics'],
      summary: 'Lister l\'état spark, les rapports de crash et les journaux d\'un serveur',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: {
        200: jsonResp('Informations de diagnostic', {
          type: 'object',
          properties: {
            spark: { type: 'object' },
            crashReports: { type: 'array', items: { type: 'object' } },
            logs: { type: 'array', items: { type: 'object' } },
          },
        }),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/diagnostics/file': {
    get: {
      tags: ['Diagnostics'],
      summary: 'Lire le contenu d\'un rapport de crash ou fichier de log',
      security: AUTH_ANY,
      parameters: [
        serverIdParam,
        queryParam('name', 'Nom du fichier de diagnostic à lire', { type: 'string' }, true),
      ],
      responses: {
        200: jsonResp('Contenu du fichier', {
          type: 'object',
          properties: { name: { type: 'string' }, content: { type: 'string' } },
        }),
        400: errResp('Nom de fichier manquant ou invalide'),
        404: errResp('Serveur ou fichier introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/diagnostics/spark/install': {
    post: {
      tags: ['Diagnostics'],
      summary: 'Installer le profiler spark sur le serveur',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: {
        200: jsonResp('spark installé', { type: 'object' }),
        400: errResp('Type de serveur incompatible avec spark'),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/diagnostics/spark/profile': {
    post: {
      tags: ['Diagnostics'],
      summary: 'Lancer un profilage CPU ou un instantané mémoire via spark',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      requestBody: jsonBody({
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['profiler', 'heap'], default: 'profiler' },
        },
      }, { required: false, example: { kind: 'profiler' } }),
      responses: {
        200: jsonResp('Profilage déclenché', { type: 'object' }),
        400: errResp('Serveur arrêté ou spark absent'),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/diagnostics/share': {
    post: {
      tags: ['Diagnostics'],
      summary: 'Partager un fichier de log ou crash report sur mclo.gs',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      requestBody: jsonBody({
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      }, { example: { name: 'latest.log' } }),
      responses: {
        200: jsonResp('Lien de partage généré', {
          type: 'object',
          properties: { url: { type: 'string' }, raw: { type: 'string' } },
        }),
        400: errResp('Paramètre invalide ou partage impossible'),
        404: errResp('Serveur ou fichier introuvable'),
        ...stdAuthErrors,
      },
    },
  },
};
