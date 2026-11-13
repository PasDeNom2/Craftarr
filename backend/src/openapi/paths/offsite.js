const { AUTH_ANY, jsonBody, jsonResp, okResp, errResp, pathParam, stdAuthErrors } = require('../helpers');

const serverIdParam = pathParam('id', 'Identifiant UUID du serveur');

module.exports = {
  '/api/offsite/settings': {
    get: {
      tags: ['Hors site'],
      summary: 'Lire la configuration des sauvegardes chiffrées hors site (restic)',
      security: AUTH_ANY,
      responses: {
        200: jsonResp('Paramètres hors site (secrets masqués)', { type: 'object' }),
        ...stdAuthErrors,
      },
    },
    put: {
      tags: ['Hors site'],
      summary: 'Mettre à jour la configuration restic hors site (administrateur)',
      security: AUTH_ANY,
      requestBody: jsonBody({
        type: 'object',
        properties: {
          offsite_repository: { type: 'string' },
          offsite_password: { type: 'string' },
          offsite_env: { type: 'object', additionalProperties: { type: 'string' } },
          offsite_keep_daily: { type: 'integer', minimum: 0 },
          offsite_keep_weekly: { type: 'integer', minimum: 0 },
          offsite_keep_monthly: { type: 'integer', minimum: 0 },
        },
      }),
      responses: {
        200: okResp(),
        400: errResp('Paramètres invalides'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/offsite/test': {
    post: {
      tags: ['Hors site'],
      summary: 'Tester la connexion au dépôt restic distant (administrateur)',
      security: AUTH_ANY,
      responses: {
        200: jsonResp('Résultat du test', { type: 'object' }),
        400: errResp('Dépôt inaccessible ou non configuré'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/offsite/init': {
    post: {
      tags: ['Hors site'],
      summary: 'Initialiser le dépôt restic distant (administrateur)',
      security: AUTH_ANY,
      responses: {
        200: jsonResp('Dépôt initialisé', { type: 'object' }),
        400: errResp('Initialisation impossible'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/offsite': {
    get: {
      tags: ['Hors site'],
      summary: 'Lister les instantanés restic disponibles pour un serveur',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: {
        200: jsonResp('Instantanés du serveur', {
          type: 'object',
          properties: { snapshots: { type: 'array', items: { type: 'object' } } },
        }),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/offsite/run': {
    post: {
      tags: ['Hors site'],
      summary: 'Lancer une sauvegarde restic hors site du serveur',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: {
        200: jsonResp('Sauvegarde hors site terminée', { type: 'object' }),
        400: errResp('Dépôt non configuré ou erreur restic'),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/offsite/restore': {
    post: {
      tags: ['Hors site'],
      summary: 'Restaurer un instantané restic sur le serveur',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      requestBody: jsonBody({
        type: 'object',
        required: ['snapshotId'],
        properties: { snapshotId: { type: 'string' } },
      }),
      responses: {
        200: jsonResp('Restauration effectuée', { type: 'object' }),
        400: errResp('Instantané invalide ou erreur restic'),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
};
