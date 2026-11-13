const {
  AUTH_ANY, AUTH_PUBLIC, jsonBody, multipartBody, jsonResp, okResp, errResp, pathParam, queryParam, stdAuthErrors,
} = require('../helpers');

const serverIdParam = pathParam('id', 'Identifiant UUID du serveur');
const serverRef = { $ref: '#/components/schemas/Server' };

module.exports = {
  '/api/servers': {
    get: {
      tags: ['Serveurs'],
      summary: 'Lister les serveurs accessibles à l\'utilisateur',
      security: AUTH_ANY,
      responses: {
        200: jsonResp('Liste des serveurs', { type: 'array', items: serverRef }),
        401: stdAuthErrors[401],
      },
    },
    post: {
      tags: ['Serveurs'],
      summary: 'Déployer un nouveau serveur Minecraft (admin)',
      security: AUTH_ANY,
      requestBody: jsonBody({
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', maxLength: 64 },
          modpack_id: { type: 'string' },
          modpack_name: { type: 'string' },
          modpack_source: { type: 'string' },
          modpack_version: { type: 'string' },
          modpack_version_id: { type: 'string' },
          port: { type: 'integer', minimum: 1024, maximum: 65535 },
          ram_mb: { type: 'integer', minimum: 512, maximum: 262144, default: 4096 },
          max_players: { type: 'integer', minimum: 1, maximum: 1000, default: 20 },
          seed: { type: 'string', maxLength: 64 },
          whitelist_enabled: { type: 'boolean', default: false },
          online_mode: { type: 'boolean', default: true },
          mc_version: { type: 'string' },
          loader_type: { type: 'string', default: 'forge' },
          auto_update: { type: 'boolean', default: false },
          pregen_enabled: { type: 'boolean', default: false },
          pregen_radius: { type: 'integer', default: 3000 },
          pregen_worlds: { type: 'array', items: { type: 'string' } },
        },
      }),
      responses: {
        201: jsonResp('Serveur créé, installation lancée', serverRef),
        400: errResp('Paramètres invalides'),
        409: errResp('Port déjà utilisé par un autre serveur'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}': {
    get: {
      tags: ['Serveurs'],
      summary: 'Obtenir les détails d\'un serveur',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: {
        200: jsonResp('Détails du serveur', serverRef),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
    patch: {
      tags: ['Serveurs'],
      summary: 'Modifier les paramètres d\'un serveur',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      requestBody: jsonBody({
        type: 'object',
        properties: {
          name: { type: 'string', maxLength: 64 },
          port: { type: 'integer', minimum: 1024, maximum: 65535 },
          ram_mb: { type: 'integer', minimum: 512, maximum: 262144 },
          max_players: { type: 'integer', minimum: 1, maximum: 1000 },
          update_interval_hours: { type: 'integer', minimum: 1, maximum: 168 },
          motd: { type: ['string', 'null'], maxLength: 256 },
          seed: { type: ['string', 'null'], maxLength: 64 },
          difficulty: { type: 'string', enum: ['peaceful', 'easy', 'normal', 'hard'] },
          view_distance: { type: 'integer', minimum: 2, maximum: 32 },
          spawn_protection: { type: 'integer', minimum: 0, maximum: 1000 },
          whitelist_enabled: { type: 'boolean' },
          auto_update: { type: 'boolean' },
          pregen_enabled: { type: 'boolean' },
          pregen_pause_players: { type: 'boolean' },
          pregen_radius: { type: 'integer' },
          pregen_worlds: { type: 'array', items: { type: 'string' } },
          sleep_mode: { type: 'string', enum: ['off', 'pause', 'stop'] },
          sleep_after_minutes: { type: 'integer', minimum: 1, maximum: 120 },
          hostname: { type: ['string', 'null'] },
        },
      }),
      responses: {
        200: jsonResp('Serveur mis à jour', serverRef),
        400: errResp('Champ invalide ou aucun champ fourni'),
        404: errResp('Serveur introuvable'),
        409: errResp('Port ou sous-domaine déjà utilisé'),
        ...stdAuthErrors,
      },
    },
    delete: {
      tags: ['Serveurs'],
      summary: 'Supprimer un serveur et son container (admin)',
      security: AUTH_ANY,
      parameters: [
        serverIdParam,
        queryParam('deleteBackups', 'Supprimer également les sauvegardes locales (« true »)', { type: 'string', enum: ['true', 'false'] }),
      ],
      responses: {
        200: jsonResp('Serveur supprimé', {
          type: 'object',
          properties: { ok: { type: 'boolean' }, backupsKeptIn: { type: ['string', 'null'] } },
        }),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/install/confirm-client-pack': {
    post: {
      tags: ['Serveurs'],
      summary: 'Confirmer l\'installation d\'un modpack sans server pack',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: { 200: okResp('Confirmation enregistrée'), ...stdAuthErrors },
    },
  },
  '/api/servers/{id}/install/cancel': {
    post: {
      tags: ['Serveurs'],
      summary: 'Annuler une installation en attente de confirmation',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: { 200: okResp('Installation annulée'), ...stdAuthErrors },
    },
  },
  '/api/servers/{id}/install-mods': {
    post: {
      tags: ['Serveurs'],
      summary: 'Télécharger les mods manquants en arrière-plan',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: {
        200: jsonResp('Téléchargement lancé', { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } } }),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/reinstall': {
    post: {
      tags: ['Serveurs'],
      summary: 'Réinstaller depuis zéro un serveur en état d\'erreur',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: {
        200: okResp('Réinstallation démarrée'),
        400: errResp('Le serveur n\'est pas en erreur'),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/recreate': {
    post: {
      tags: ['Serveurs'],
      summary: 'Recréer le container Docker du serveur',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: {
        200: jsonResp('Container recréé et démarré', { type: 'object', properties: { ok: { type: 'boolean' }, status: { type: 'string' } } }),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/start': {
    post: {
      tags: ['Serveurs'],
      summary: 'Démarrer le serveur Minecraft',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: {
        200: jsonResp('Démarrage lancé', { type: 'object', properties: { ok: { type: 'boolean' }, status: { type: 'string' } } }),
        400: errResp('Container non créé'),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/stop': {
    post: {
      tags: ['Serveurs'],
      summary: 'Arrêter proprement le serveur Minecraft',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: {
        200: jsonResp('Serveur arrêté', { type: 'object', properties: { ok: { type: 'boolean' }, status: { type: 'string' } } }),
        400: errResp('Container non créé'),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/restart': {
    post: {
      tags: ['Serveurs'],
      summary: 'Redémarrer le serveur Minecraft',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: {
        200: jsonResp('Redémarrage lancé', { type: 'object', properties: { ok: { type: 'boolean' }, status: { type: 'string' } } }),
        400: errResp('Container non créé'),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/backup': {
    post: {
      tags: ['Serveurs'],
      summary: 'Créer une sauvegarde manuelle immédiate du serveur',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: {
        200: jsonResp('Sauvegarde créée', { type: 'object' }),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/rcon': {
    post: {
      tags: ['Serveurs'],
      summary: 'Exécuter une commande RCON sur le serveur',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      requestBody: jsonBody({
        type: 'object',
        required: ['command'],
        properties: { command: { type: 'string', example: 'list' } },
      }),
      responses: {
        200: jsonResp('Réponse RCON', { type: 'object', properties: { response: { type: 'string' } } }),
        400: errResp('Commande manquante'),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/update': {
    post: {
      tags: ['Serveurs'],
      summary: 'Vérifier et appliquer une mise à jour de modpack',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      requestBody: jsonBody({
        type: 'object',
        properties: { version_id: { type: 'string', description: 'Identifiant de version cible (optionnel)' } },
      }, { required: false }),
      responses: {
        200: jsonResp('Mise à jour lancée ou serveur déjà à jour', {
          type: 'object',
          properties: { ok: { type: 'boolean' }, upToDate: { type: 'boolean' }, message: { type: 'string' }, version: { type: 'string' } },
        }),
        404: errResp('Serveur ou version introuvable'),
        409: errResp('Opération déjà en cours'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/pregen/restart': {
    post: {
      tags: ['Serveurs'],
      summary: 'Relancer la pré-génération du monde depuis zéro',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      responses: {
        200: jsonResp('Pré-génération réinitialisée', serverRef),
        400: errResp('Pré-génération désactivée'),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/icon': {
    get: {
      tags: ['Serveurs'],
      summary: 'Récupérer l\'icône PNG (64×64) du serveur',
      security: AUTH_PUBLIC,
      parameters: [serverIdParam],
      responses: {
        200: { description: 'Image PNG de l\'icône serveur', content: { 'image/png': { schema: { type: 'string', format: 'binary' } } } },
        404: errResp('Serveur ou icône introuvable'),
      },
    },
    post: {
      tags: ['Serveurs'],
      summary: 'Téléverser une icône serveur au format PNG',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      requestBody: multipartBody({
        type: 'object',
        required: ['icon'],
        properties: { icon: { type: 'string', format: 'binary' } },
      }),
      responses: {
        200: jsonResp('Icône mise à jour', { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } } }),
        400: errResp('Fichier manquant ou format non PNG'),
        404: errResp('Serveur introuvable'),
        ...stdAuthErrors,
      },
    },
  },
};
