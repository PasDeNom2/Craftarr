const { AUTH_ANY, jsonResp, errResp, pathParam, queryParam, stdAuthErrors } = require('../helpers');

const serverIdParam = pathParam('id', 'Identifiant UUID du serveur');

module.exports = {
  '/api/servers/{id}/metrics/history': {
    get: {
      tags: ['Métriques'],
      summary: 'Récupérer l\'historique des métriques CPU, RAM, joueurs et TPS',
      security: AUTH_ANY,
      parameters: [
        serverIdParam,
        queryParam(
          'range',
          'Fenêtre temporelle souhaitée',
          { type: 'string', enum: ['1h', '6h', '24h', '7d', '30d'], default: '24h' },
        ),
      ],
      responses: {
        200: jsonResp('Série temporelle des métriques', {
          type: 'object',
          properties: {
            range: { type: 'string' },
            points: { type: 'array', items: { type: 'object' } },
          },
        }),
        400: errResp('Plage horaire invalide'),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
};
