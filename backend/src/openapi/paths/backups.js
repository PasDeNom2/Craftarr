const {
  AUTH_ANY, AUTH_PUBLIC, jsonResp, okResp, errResp, pathParam, queryParam, stdAuthErrors,
} = require('../helpers');

const serverIdParam = pathParam('serverId', 'Identifiant UUID du serveur');
const backupIdParam = pathParam('backupId', 'Identifiant de la sauvegarde');
const filenameParam = pathParam('filename', 'Nom du fichier archive .zip');

module.exports = {
  '/api/servers/{serverId}/backups': {
    get: {
      tags: ['Sauvegardes'],
      summary: 'Lister les sauvegardes d\'un serveur',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: {
        200: jsonResp('Liste des sauvegardes', { type: 'array', items: { type: 'object' } }),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{serverId}/backups/{backupId}': {
    delete: {
      tags: ['Sauvegardes'],
      summary: 'Supprimer une sauvegarde locale',
      security: AUTH_ANY,
      parameters: [serverIdParam, backupIdParam],
      responses: {
        200: okResp('Sauvegarde supprimée'),
        404: errResp('Sauvegarde introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{serverId}/backups/{backupId}/restore': {
    post: {
      tags: ['Sauvegardes'],
      summary: 'Restaurer une sauvegarde sur le serveur',
      security: AUTH_ANY,
      parameters: [serverIdParam, backupIdParam],
      responses: {
        200: okResp('Sauvegarde restaurée'),
        400: errResp('Archive invalide ou corrompue'),
        404: errResp('Serveur ou sauvegarde introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/backups/orphans': {
    get: {
      tags: ['Sauvegardes'],
      summary: 'Lister les dossiers de sauvegardes orphelines (admin)',
      security: AUTH_ANY,
      responses: {
        200: jsonResp('Sauvegardes orphelines groupées par ancien serveur', { type: 'array', items: { type: 'object' } }),
        ...stdAuthErrors,
      },
    },
  },
  '/api/backups/orphans/{serverId}': {
    delete: {
      tags: ['Sauvegardes'],
      summary: 'Supprimer les sauvegardes orphelines d\'un ancien serveur (admin)',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: {
        200: okResp('Dossier supprimé'),
        404: errResp('Dossier introuvable'),
        409: errResp('Ce serveur existe encore'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/backups/orphans/{serverId}/{filename}/download-token': {
    get: {
      tags: ['Sauvegardes'],
      summary: 'Générer un lien de téléchargement signé pour une sauvegarde orpheline (admin)',
      security: AUTH_ANY,
      parameters: [serverIdParam, filenameParam],
      responses: {
        200: jsonResp('URL signée à usage unique', { type: 'object', properties: { url: { type: 'string' } } }),
        404: errResp('Sauvegarde introuvable'),
        409: errResp('Ce serveur existe encore'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/backups/orphans/{serverId}/{filename}/download': {
    get: {
      tags: ['Sauvegardes'],
      summary: 'Télécharger une sauvegarde orpheline via un jeton signé',
      security: AUTH_PUBLIC,
      parameters: [serverIdParam, filenameParam, queryParam('token', 'Jeton signé', { type: 'string' }, true)],
      responses: {
        200: { description: 'Archive ZIP', content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } } },
        401: errResp('Lien invalide ou expiré'),
        404: errResp('Sauvegarde introuvable'),
      },
    },
  },
};
