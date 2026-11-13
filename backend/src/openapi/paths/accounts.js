const {
  AUTH_ANY, AUTH_PUBLIC, AUTH_SESSION, jsonBody, jsonResp, okResp, errResp, pathParam, queryParam, stdAuthErrors,
} = require('../helpers');

const uidParam = pathParam('uid', 'Identifiant UUID de l\'utilisateur');
const serverIdParam = pathParam('id', 'Identifiant UUID du serveur');

module.exports = {
  '/api/auth/2fa/status': {
    get: {
      tags: ['Comptes & 2FA'],
      summary: 'Vérifier si la 2FA TOTP est activée sur le compte (session requise)',
      security: AUTH_SESSION,
      responses: {
        200: jsonResp('État 2FA', { type: 'object', properties: { enabled: { type: 'boolean' } } }),
        ...stdAuthErrors,
      },
    },
  },
  '/api/auth/2fa/setup': {
    post: {
      tags: ['Comptes & 2FA'],
      summary: 'Initialiser un secret TOTP pour la double authentification (session requise)',
      security: AUTH_SESSION,
      responses: {
        200: jsonResp('Secret et URI otpauth', {
          type: 'object',
          properties: { secret: { type: 'string' }, otpauthUrl: { type: 'string' } },
        }),
        400: errResp('2FA déjà activée'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/auth/2fa/enable': {
    post: {
      tags: ['Comptes & 2FA'],
      summary: 'Confirmer et activer la 2FA TOTP avec un code à 6 chiffres (session requise)',
      security: AUTH_SESSION,
      requestBody: jsonBody({
        type: 'object',
        required: ['code'],
        properties: { code: { type: 'string', example: '123456' } },
      }),
      responses: {
        200: jsonResp('2FA activée et codes de secours générés', {
          type: 'object',
          properties: { ok: { type: 'boolean' }, recoveryCodes: { type: 'array', items: { type: 'string' } } },
        }),
        400: errResp('Code invalide ou 2FA non initialisée'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/auth/2fa/disable': {
    post: {
      tags: ['Comptes & 2FA'],
      summary: 'Désactiver la 2FA TOTP (session requise)',
      security: AUTH_SESSION,
      requestBody: jsonBody({
        type: 'object',
        required: ['password', 'code'],
        properties: {
          password: { type: 'string' },
          code: { type: 'string', description: 'Code TOTP ou code de secours' },
        },
      }),
      responses: {
        200: okResp('2FA désactivée'),
        400: errResp('Code 2FA invalide'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/auth/2fa/verify': {
    post: {
      tags: ['Comptes & 2FA'],
      summary: 'Valider un challenge de connexion 2FA avec un code TOTP ou de secours',
      security: AUTH_PUBLIC,
      requestBody: jsonBody({
        type: 'object',
        required: ['challenge'],
        properties: {
          challenge: { type: 'string' },
          code: { type: 'string' },
          recoveryCode: { type: 'string' },
        },
      }),
      responses: {
        200: jsonResp('Session validée et jeton JWT émis', {
          type: 'object',
          properties: { token: { type: 'string' }, username: { type: 'string' }, role: { type: 'string' } },
        }),
        401: errResp('Code ou challenge invalide'),
        429: errResp('Trop de tentatives'),
      },
    },
  },
  '/api/users': {
    get: {
      tags: ['Comptes & 2FA'],
      summary: 'Lister tous les comptes utilisateurs et leurs permissions (admin)',
      security: AUTH_ANY,
      responses: {
        200: jsonResp('Liste des utilisateurs', { type: 'array', items: { type: 'object' } }),
        ...stdAuthErrors,
      },
    },
    post: {
      tags: ['Comptes & 2FA'],
      summary: 'Créer un compte utilisateur (admin)',
      security: AUTH_ANY,
      requestBody: jsonBody({
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string', minLength: 3, maxLength: 64 },
          password: { type: 'string', minLength: 8 },
          role: { type: 'string', enum: ['admin', 'user'], default: 'user' },
        },
      }),
      responses: {
        201: jsonResp('Utilisateur créé', { type: 'object' }),
        400: errResp('Paramètres invalides'),
        409: errResp('Nom d\'utilisateur déjà utilisé'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/users/{uid}': {
    patch: {
      tags: ['Comptes & 2FA'],
      summary: 'Modifier le rôle, le statut ou le mot de passe d\'un utilisateur (admin)',
      security: AUTH_ANY,
      parameters: [uidParam],
      requestBody: jsonBody({
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['admin', 'user'] },
          disabled: { type: 'boolean' },
          password: { type: 'string', minLength: 8 },
        },
      }),
      responses: {
        200: jsonResp('Utilisateur mis à jour', { type: 'object' }),
        400: errResp('Modification interdite (ex. dernier admin)'),
        404: errResp('Utilisateur introuvable'),
        ...stdAuthErrors,
      },
    },
    delete: {
      tags: ['Comptes & 2FA'],
      summary: 'Supprimer un compte utilisateur (admin)',
      security: AUTH_ANY,
      parameters: [uidParam],
      responses: {
        200: okResp('Utilisateur supprimé'),
        400: errResp('Suppression interdite'),
        404: errResp('Utilisateur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/users/{uid}/servers/{id}': {
    put: {
      tags: ['Comptes & 2FA'],
      summary: 'Définir les permissions d\'un utilisateur sur un serveur (admin)',
      security: AUTH_ANY,
      parameters: [uidParam, serverIdParam],
      requestBody: jsonBody({
        type: 'object',
        required: ['perms'],
        properties: {
          perms: {
            type: 'array',
            items: { type: 'string', enum: ['view', 'console', 'power', 'files', 'players', 'backups', 'manage'] },
          },
        },
      }),
      responses: {
        200: jsonResp('Permissions enregistrées', { type: 'object' }),
        400: errResp('Permission inconnue'),
        404: errResp('Utilisateur ou serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/activity': {
    get: {
      tags: ['Comptes & 2FA'],
      summary: 'Consulter le journal d\'activité filtrable et paginé (admin)',
      security: AUTH_ANY,
      parameters: [
        queryParam('user', 'Filtrer par identifiant ou nom d\'utilisateur'),
        queryParam('server', 'Filtrer par UUID serveur'),
        queryParam('action', 'Filtrer par action (motif)'),
        queryParam('from', 'Date de début (YYYY-MM-DD)'),
        queryParam('to', 'Date de fin (YYYY-MM-DD)'),
        queryParam('page', 'Numéro de page', { type: 'integer', default: 1 }),
        queryParam('limit', 'Taille de page (max 200)', { type: 'integer', default: 50 }),
      ],
      responses: {
        200: jsonResp('Entrées du journal d\'activité', {
          type: 'object',
          properties: {
            items: { type: 'array', items: { type: 'object' } },
            total: { type: 'integer' },
            page: { type: 'integer' },
            limit: { type: 'integer' },
            totalPages: { type: 'integer' },
          },
        }),
        ...stdAuthErrors,
      },
    },
  },
};
