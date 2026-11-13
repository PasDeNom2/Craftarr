// Assemblage du document OpenAPI 3.1 à partir des fragments dans paths/*.js.
const fs = require('fs');
const path = require('path');
const { AUTH_ANY, AUTH_PUBLIC, jsonResp } = require('./helpers');

const TAGS = [
  { name: 'Système', description: 'État de santé et spécification OpenAPI' },
  { name: 'Authentification', description: 'Configuration initiale, connexion, mot de passe et profil' },
  { name: 'Clés API', description: 'Création, consultation et révocation de clés API (session requise)' },
  { name: 'Comptes & 2FA', description: 'Gestion des comptes utilisateurs, permissions, 2FA TOTP et journal d\'activité' },
  { name: 'Serveurs', description: 'Déploiement, cycle de vie, paramètres et icône des serveurs Minecraft' },
  { name: 'Fichiers', description: 'Explorateur, édition texte/NBT, envoi et téléchargement de fichiers' },
  { name: 'Joueurs', description: 'Historique, profils, modération (kick/ban/op) et liste blanche' },
  { name: 'Mods', description: 'Gestion des mods installés, recherche et mise à jour Modrinth/CurseForge' },
  { name: 'Sauvegardes', description: 'Sauvegardes locales et sauvegardes orphelines' },
  { name: 'Hors site', description: 'Sauvegardes chiffrées hors site via restic' },
  { name: 'Monde', description: 'Import et téléchargement du monde Minecraft' },
  { name: 'Catalogue', description: 'Recherche et détails de modpacks (CurseForge, Modrinth, sources personnalisées)' },
  { name: 'Vanilla & Types', description: 'Versions Minecraft Vanilla, Paper et Purpur' },
  { name: 'Sources', description: 'Configuration des sources de modpacks' },
  { name: 'Paramètres', description: 'Réglages globaux et notifications' },
  { name: 'Planificateur', description: 'Tâches planifiées, exécutions et préréglages' },
  { name: 'Profils', description: 'Profils d\'installation multiples par serveur' },
  { name: 'BlueMap', description: 'Carte web 3D BlueMap' },
  { name: 'Geyser', description: 'Crossplay Minecraft Bedrock (Geyser + Floodgate)' },
  { name: 'Diagnostics', description: 'Profilage spark, journaux et partage mclo.gs' },
  { name: 'Métriques', description: 'Historique CPU, RAM, joueurs et TPS' },
  { name: 'Routeur', description: 'Routage par sous-domaine (mc-router)' },
];

let cachedSpec = null;

function buildOpenApiSpec({ fresh = false } = {}) {
  if (cachedSpec && !fresh) return cachedSpec;

  const paths = {
    '/api/health': {
      get: {
        tags: ['Système'],
        summary: 'Vérifier la disponibilité du backend',
        security: AUTH_PUBLIC,
        responses: {
          200: jsonResp('Backend opérationnel', {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
          }, { ok: true }),
        },
      },
    },
    '/api/openapi.json': {
      get: {
        tags: ['Système'],
        summary: 'Récupérer la spécification OpenAPI 3.1 complète',
        security: AUTH_PUBLIC,
        responses: {
          200: jsonResp('Document OpenAPI 3.1.0 au format JSON', { type: 'object' }),
        },
      },
    },
  };

  const pathsDir = path.join(__dirname, 'paths');
  if (fs.existsSync(pathsDir)) {
    const files = fs.readdirSync(pathsDir).filter(n => n.endsWith('.js')).sort();
    for (const file of files) {
      const fragment = require(path.join(pathsDir, file));
      const fragPaths = fragment.paths || fragment;
      for (const [p, ops] of Object.entries(fragPaths)) {
        paths[p] = { ...(paths[p] || {}), ...ops };
      }
    }
  }

  const spec = {
    openapi: '3.1.0',
    info: {
      title: 'Craftarr API',
      version: '1.0.0',
      description: 'API HTTP de gestion de serveurs Minecraft Craftarr. Authentification via jeton JWT de session (`Authorization: Bearer <jwt>`) ou clé API (`X-API-Key: cra_…` ou `Authorization: Bearer cra_…`).',
    },
    servers: [
      { url: '/', description: 'Instance Craftarr courante' },
    ],
    tags: TAGS,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT | cra_...',
          description: 'Jeton JWT de session (7 jours) ou clé API (`Authorization: Bearer cra_…`).',
        },
        apiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'Clé API Craftarr (`cra_…`), révocable par l\'utilisateur.',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string', description: 'Message d\'erreur lisible' },
          },
          required: ['error'],
        },
        Server: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            modpack_id: { type: 'string' },
            modpack_name: { type: 'string' },
            modpack_source: { type: 'string' },
            modpack_version: { type: ['string', 'null'] },
            port: { type: 'integer' },
            ram_mb: { type: 'integer' },
            max_players: { type: 'integer' },
            status: { type: 'string', enum: ['installing', 'starting', 'running', 'stopped', 'updating', 'error'] },
            mc_version: { type: ['string', 'null'] },
            loader_type: { type: ['string', 'null'] },
            whitelist_enabled: { type: 'boolean' },
            online_mode: { type: 'boolean' },
            auto_update: { type: 'boolean' },
            needs_recreate: { type: 'boolean' },
            my_perms: { type: 'array', items: { type: 'string' } },
          },
        },
        ApiKey: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            user_id: { type: 'string', format: 'uuid' },
            username: { type: 'string' },
            name: { type: 'string' },
            prefix: { type: 'string', description: '8 premiers caractères après cra_' },
            read_only: { type: 'boolean' },
            created_at: { type: 'string' },
            last_used_at: { type: ['string', 'null'] },
            expires_at: { type: ['string', 'null'] },
            revoked: { type: 'boolean' },
          },
        },
      },
    },
    security: AUTH_ANY,
    paths,
  };

  if (!fresh) cachedSpec = spec;
  return spec;
}

module.exports = { buildOpenApiSpec };
