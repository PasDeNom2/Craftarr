const {
  AUTH_ANY, jsonBody, jsonResp, okResp, errResp, pathParam, queryParam, stdAuthErrors,
} = require('../helpers');

const serverIdParam = pathParam('id', 'Identifiant UUID du serveur');
const usernameParam = pathParam('username', 'Nom du joueur Minecraft');
const reasonBody = jsonBody({
  type: 'object',
  properties: { reason: { type: 'string' } },
}, { required: false });

module.exports = {
  '/api/servers/{id}/players': {
    get: {
      tags: ['Joueurs'],
      summary: 'Lister les joueurs connus du serveur et leurs statistiques',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: {
        200: jsonResp('Liste des joueurs', { type: 'array', items: { type: 'object' } }),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/players/overview': {
    get: {
      tags: ['Joueurs'],
      summary: 'Obtenir la vue d\'ensemble et les sessions joueurs sur une période',
      security: AUTH_ANY,
      parameters: [
        serverIdParam,
        queryParam('days', 'Nombre de jours (1 à 365, défaut 30)', { type: 'integer', minimum: 1, maximum: 365 }),
      ],
      responses: {
        200: jsonResp('Totaux et sessions de la période', { type: 'object' }),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/players/{username}/profile': {
    get: {
      tags: ['Joueurs'],
      summary: 'Consulter la fiche complète d\'un joueur',
      security: AUTH_ANY,
      parameters: [serverIdParam, usernameParam],
      responses: {
        200: jsonResp('Fiche détaillée du joueur', { type: 'object' }),
        404: errResp('Joueur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/players/{username}/events': {
    get: {
      tags: ['Joueurs'],
      summary: 'Lister les événements d\'un joueur (chat, morts, succès…)',
      security: AUTH_ANY,
      parameters: [
        serverIdParam,
        usernameParam,
        queryParam('type', 'Types séparés par des virgules'),
        queryParam('q', 'Filtre texte'),
        queryParam('before', 'ID maximum (pagination curseur)', { type: 'integer' }),
        queryParam('offset', 'Décalage', { type: 'integer' }),
        queryParam('limit', 'Nombre max (max 500)', { type: 'integer' }),
      ],
      responses: {
        200: jsonResp('Liste des événements', { type: 'array', items: { type: 'object' } }),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/players/{username}/kick': {
    post: {
      tags: ['Joueurs'],
      summary: 'Expulser un joueur connecté via RCON',
      security: AUTH_ANY,
      parameters: [serverIdParam, usernameParam],
      requestBody: reasonBody,
      responses: { 200: okResp('Joueur expulsé'), 404: errResp('Serveur introuvable'), ...stdAuthErrors },
    },
  },
  '/api/servers/{id}/players/{username}/warn': {
    post: {
      tags: ['Joueurs'],
      summary: 'Envoyer un avertissement à un joueur',
      security: AUTH_ANY,
      parameters: [serverIdParam, usernameParam],
      requestBody: reasonBody,
      responses: { 200: okResp('Avertissement envoyé'), 404: errResp('Serveur introuvable'), ...stdAuthErrors },
    },
  },
  '/api/servers/{id}/players/{username}/ban': {
    post: {
      tags: ['Joueurs'],
      summary: 'Bannir un joueur du serveur',
      security: AUTH_ANY,
      parameters: [serverIdParam, usernameParam],
      requestBody: reasonBody,
      responses: { 200: okResp('Joueur banni'), 404: errResp('Serveur introuvable'), ...stdAuthErrors },
    },
    delete: {
      tags: ['Joueurs'],
      summary: 'Débannir un joueur du serveur',
      security: AUTH_ANY,
      parameters: [serverIdParam, usernameParam],
      responses: { 200: okResp('Joueur débanni'), 404: errResp('Serveur introuvable'), ...stdAuthErrors },
    },
  },
  '/api/servers/{id}/players/{username}/op': {
    post: {
      tags: ['Joueurs'],
      summary: 'Accorder les droits opérateur (OP) à un joueur',
      security: AUTH_ANY,
      parameters: [serverIdParam, usernameParam],
      responses: { 200: okResp('Droits OP accordés'), 404: errResp('Serveur introuvable'), ...stdAuthErrors },
    },
    delete: {
      tags: ['Joueurs'],
      summary: 'Retirer les droits opérateur (OP) d\'un joueur',
      security: AUTH_ANY,
      parameters: [serverIdParam, usernameParam],
      responses: { 200: okResp('Droits OP retirés'), 404: errResp('Serveur introuvable'), ...stdAuthErrors },
    },
  },
  '/api/servers/{id}/whitelist': {
    get: {
      tags: ['Joueurs'],
      summary: 'Lire la liste blanche (whitelist.json) du serveur',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: {
        200: jsonResp('Entrées de la liste blanche', { type: 'array', items: { type: 'object' } }),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
    post: {
      tags: ['Joueurs'],
      summary: 'Ajouter un joueur à la liste blanche',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      requestBody: jsonBody({
        type: 'object',
        required: ['username'],
        properties: { username: { type: 'string' } },
      }),
      responses: {
        200: okResp('Joueur ajouté à la liste blanche'),
        400: errResp('Nom d\'utilisateur requis'),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/whitelist/{username}': {
    delete: {
      tags: ['Joueurs'],
      summary: 'Retirer un joueur de la liste blanche',
      security: AUTH_ANY,
      parameters: [serverIdParam, usernameParam],
      responses: { 200: okResp('Joueur retiré'), 404: errResp('Serveur introuvable'), ...stdAuthErrors },
    },
  },
};
