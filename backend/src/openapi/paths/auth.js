const { AUTH_ANY, AUTH_PUBLIC, AUTH_SESSION, jsonBody, jsonResp, errResp } = require('../helpers');

module.exports = {
  '/api/auth/setup-needed': {
    get: {
      tags: ['Authentification'],
      summary: 'Vérifier si la configuration initiale du compte admin est requise',
      security: AUTH_PUBLIC,
      responses: {
        200: jsonResp('État du setup initial', {
          type: 'object',
          properties: { needed: { type: 'boolean' } },
          required: ['needed'],
        }, { needed: false }),
      },
    },
  },
  '/api/auth/setup': {
    post: {
      tags: ['Authentification'],
      summary: 'Créer le premier compte administrateur avec le jeton de démarrage',
      security: AUTH_PUBLIC,
      requestBody: jsonBody({
        type: 'object',
        required: ['username', 'password', 'setupToken'],
        properties: {
          username: { type: 'string', minLength: 3 },
          password: { type: 'string', minLength: 8 },
          setupToken: { type: 'string', description: 'Jeton affiché dans les logs du backend' },
        },
      }),
      responses: {
        200: jsonResp('Compte admin créé et jeton JWT émis', {
          type: 'object',
          properties: {
            token: { type: 'string' },
            username: { type: 'string' },
            role: { type: 'string' },
          },
        }),
        400: errResp('Paramètres invalides'),
        403: errResp('Jeton de configuration invalide ou compte déjà existant'),
      },
    },
  },
  '/api/auth/login': {
    post: {
      tags: ['Authentification'],
      summary: 'Se connecter avec nom d\'utilisateur et mot de passe',
      security: AUTH_PUBLIC,
      requestBody: jsonBody({
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string' },
          password: { type: 'string' },
        },
      }),
      responses: {
        200: jsonResp('Jeton JWT ou challenge 2FA si activé', {
          type: 'object',
          properties: {
            token: { type: 'string' },
            username: { type: 'string' },
            role: { type: 'string' },
            twoFactorRequired: { type: 'boolean' },
            challenge: { type: 'string' },
          },
        }),
        400: errResp('Identifiants manquants'),
        401: errResp('Identifiants invalides ou compte désactivé'),
        429: errResp('Trop de tentatives'),
      },
    },
  },
  '/api/auth/password': {
    post: {
      tags: ['Authentification'],
      summary: 'Modifier le mot de passe du compte connecté (session requise)',
      security: AUTH_SESSION,
      requestBody: jsonBody({
        type: 'object',
        required: ['currentPassword', 'newPassword'],
        properties: {
          currentPassword: { type: 'string' },
          newPassword: { type: 'string', minLength: 8 },
        },
      }),
      responses: {
        200: jsonResp('Mot de passe modifié et nouveau jeton JWT émis', {
          type: 'object',
          properties: {
            token: { type: 'string' },
            username: { type: 'string' },
            role: { type: 'string' },
          },
        }),
        400: errResp('Mot de passe trop court ou champs manquants'),
        401: errResp('Non authentifié'),
        403: errResp('Mot de passe actuel incorrect ou clé API refusée'),
      },
    },
  },
  '/api/auth/me': {
    get: {
      tags: ['Authentification'],
      summary: 'Obtenir le profil de l\'utilisateur authentifié',
      security: AUTH_ANY,
      responses: {
        200: jsonResp('Profil utilisateur', {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            username: { type: 'string' },
            role: { type: 'string', enum: ['admin', 'user'] },
            totp_enabled: { type: 'boolean' },
          },
        }),
        401: errResp('Authentification manquante ou invalide'),
      },
    },
  },
};
