const { AUTH_ANY, jsonBody, jsonResp, okResp, errResp, pathParam, stdAuthErrors } = require('../helpers');

const serverIdParam = pathParam('id', 'Identifiant UUID du serveur');
const scheduleIdParam = pathParam('sid', 'Identifiant UUID de la tâche planifiée');

const scheduleSchema = {
  type: 'object',
  required: ['name', 'trigger_type', 'steps'],
  properties: {
    name: { type: 'string' },
    enabled: { type: 'boolean', default: true },
    trigger_type: { type: 'string', enum: ['cron', 'interval', 'event'] },
    cron: { type: ['string', 'null'], example: '0 4 * * *' },
    interval_minutes: { type: ['integer', 'null'] },
    event: { type: ['string', 'null'] },
    only_if_players: { type: 'boolean' },
    steps: { type: 'array', items: { type: 'object' } },
  },
};

module.exports = {
  '/api/schedule-presets': {
    get: {
      tags: ['Planificateur'],
      summary: 'Lister les modèles prédéfinis de tâches planifiées',
      security: AUTH_ANY,
      responses: {
        200: jsonResp('Préréglages disponibles', {
          type: 'object',
          properties: { presets: { type: 'array', items: { type: 'object' } } },
        }),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/schedules': {
    get: {
      tags: ['Planificateur'],
      summary: 'Lister les tâches planifiées d\'un serveur',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: {
        200: jsonResp('Tâches planifiées', {
          type: 'object',
          properties: { schedules: { type: 'array', items: { type: 'object' } } },
        }),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
    post: {
      tags: ['Planificateur'],
      summary: 'Créer une tâche planifiée pour un serveur',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      requestBody: jsonBody(scheduleSchema),
      responses: {
        201: jsonResp('Tâche créée', { type: 'object' }),
        400: errResp('Définition de tâche invalide'),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/schedules/{sid}': {
    patch: {
      tags: ['Planificateur'],
      summary: 'Modifier une tâche planifiée',
      security: AUTH_ANY,
      parameters: [serverIdParam, scheduleIdParam],
      requestBody: jsonBody({
        type: 'object',
        properties: scheduleSchema.properties,
      }),
      responses: {
        200: jsonResp('Tâche mise à jour', { type: 'object' }),
        400: errResp('Paramètres invalides'),
        404: errResp('Serveur ou tâche introuvable'),
        ...stdAuthErrors,
      },
    },
    delete: {
      tags: ['Planificateur'],
      summary: 'Supprimer une tâche planifiée',
      security: AUTH_ANY,
      parameters: [serverIdParam, scheduleIdParam],
      responses: {
        200: okResp(),
        404: errResp('Serveur ou tâche introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/schedules/{sid}/run': {
    post: {
      tags: ['Planificateur'],
      summary: 'Exécuter immédiatement une tâche planifiée',
      security: AUTH_ANY,
      parameters: [serverIdParam, scheduleIdParam],
      responses: {
        200: jsonResp('Exécution terminée ou démarrée', { type: 'object' }),
        404: errResp('Serveur ou tâche introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/schedules/{sid}/runs': {
    get: {
      tags: ['Planificateur'],
      summary: 'Consulter l\'historique d\'exécution d\'une tâche planifiée',
      security: AUTH_ANY,
      parameters: [serverIdParam, scheduleIdParam],
      responses: {
        200: jsonResp('Historique des exécutions', {
          type: 'object',
          properties: { runs: { type: 'array', items: { type: 'object' } } },
        }),
        404: errResp('Serveur ou tâche introuvable'),
        ...stdAuthErrors,
      },
    },
  },
};
