const {
  AUTH_ANY, AUTH_PUBLIC, jsonBody, multipartBody, jsonResp, okResp, errResp, pathParam, queryParam, stdAuthErrors,
} = require('../helpers');

const serverIdParam = pathParam('id', 'Identifiant UUID du serveur');

module.exports = {
  '/api/servers/{id}/files': {
    get: {
      tags: ['Fichiers'],
      summary: 'Lister le contenu d\'un dossier du serveur',
      security: AUTH_ANY,
      parameters: [serverIdParam, queryParam('path', 'Chemin relatif dans le dossier du serveur')],
      responses: {
        200: jsonResp('Liste des fichiers et dossiers', {
          type: 'object',
          properties: {
            path: { type: 'string' },
            entries: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  isDir: { type: 'boolean' },
                  size: { type: ['integer', 'null'] },
                  mtime: { type: ['number', 'null'] },
                },
              },
            },
          },
        }),
        404: errResp('Serveur ou chemin introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/files/content': {
    get: {
      tags: ['Fichiers'],
      summary: 'Lire le contenu texte d\'un fichier du serveur',
      security: AUTH_ANY,
      parameters: [serverIdParam, queryParam('path', 'Chemin relatif du fichier', { type: 'string' }, true)],
      responses: {
        200: jsonResp('Contenu texte et métadonnées', {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
            mtime: { type: 'number' },
            size: { type: 'integer' },
          },
        }),
        404: errResp('Fichier introuvable'),
        413: errResp('Fichier trop volumineux (> 5 Mo)'),
        415: errResp('Fichier binaire non éditable'),
        ...stdAuthErrors,
      },
    },
    put: {
      tags: ['Fichiers'],
      summary: 'Écrire un fichier texte du serveur (détection de conflit mtime)',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      requestBody: jsonBody({
        type: 'object',
        required: ['path', 'content'],
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          baseMtime: { type: 'number' },
          force: { type: 'boolean' },
        },
      }),
      responses: {
        200: jsonResp('Fichier enregistré', { type: 'object', properties: { ok: { type: 'boolean' }, mtime: { type: 'number' } } }),
        400: errResp('Chemin ou contenu invalide'),
        409: errResp('Conflit : fichier modifié sur le disque'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/files/nbt': {
    get: {
      tags: ['Fichiers'],
      summary: 'Lire un fichier NBT (level.dat, *.nbt) converti en SNBT',
      security: AUTH_ANY,
      parameters: [serverIdParam, queryParam('path', 'Chemin relatif du fichier NBT', { type: 'string' }, true)],
      responses: {
        200: jsonResp('Contenu SNBT et métadonnées NBT', { type: 'object' }),
        404: errResp('Fichier introuvable'),
        415: errResp('Format NBT illisible'),
        ...stdAuthErrors,
      },
    },
    put: {
      tags: ['Fichiers'],
      summary: 'Enregistrer un fichier NBT à partir de son contenu SNBT',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      requestBody: jsonBody({
        type: 'object',
        required: ['path', 'content'],
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          baseMtime: { type: 'number' },
          force: { type: 'boolean' },
        },
      }),
      responses: {
        200: jsonResp('Fichier NBT enregistré', { type: 'object', properties: { ok: { type: 'boolean' }, mtime: { type: 'number' }, size: { type: 'integer' } } }),
        400: errResp('SNBT invalide'),
        409: errResp('Conflit de modification'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/files/mkdir': {
    post: {
      tags: ['Fichiers'],
      summary: 'Créer un dossier dans le répertoire du serveur',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      requestBody: jsonBody({ type: 'object', required: ['path'], properties: { path: { type: 'string' } } }),
      responses: {
        200: jsonResp('Dossier créé', { type: 'object', properties: { ok: { type: 'boolean' }, path: { type: 'string' } } }),
        400: errResp('Nom de dossier invalide'),
        409: errResp('Le dossier existe déjà'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/files/rename': {
    post: {
      tags: ['Fichiers'],
      summary: 'Renommer ou déplacer un fichier ou dossier',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      requestBody: jsonBody({
        type: 'object',
        required: ['from', 'to'],
        properties: { from: { type: 'string' }, to: { type: 'string' } },
      }),
      responses: {
        200: jsonResp('Fichier renommé', { type: 'object', properties: { ok: { type: 'boolean' }, path: { type: 'string' } } }),
        404: errResp('Source introuvable'),
        409: errResp('Destination déjà existante'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/files/delete': {
    post: {
      tags: ['Fichiers'],
      summary: 'Supprimer un ou plusieurs fichiers ou dossiers',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      requestBody: jsonBody({
        type: 'object',
        required: ['paths'],
        properties: { paths: { type: 'array', items: { type: 'string' } } },
      }),
      responses: {
        200: jsonResp('Suppression effectuée', { type: 'object', properties: { ok: { type: 'boolean' }, deleted: { type: 'integer' } } }),
        400: errResp('Chemins invalides'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/files/upload': {
    post: {
      tags: ['Fichiers'],
      summary: 'Envoyer un ou plusieurs fichiers dans un dossier du serveur',
      security: AUTH_ANY,
      parameters: [
        serverIdParam,
        queryParam('path', 'Dossier cible relatif'),
        queryParam('overwrite', 'Écraser les fichiers existants (« 1 »)', { type: 'string', enum: ['0', '1'] }),
      ],
      requestBody: multipartBody({
        type: 'object',
        required: ['files'],
        properties: { files: { type: 'array', items: { type: 'string', format: 'binary' } } },
      }),
      responses: {
        200: jsonResp('Résultat de l\'envoi', {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            saved: { type: 'array', items: { type: 'string' } },
            skipped: { type: 'array', items: { type: 'string' } },
          },
        }),
        404: errResp('Dossier cible introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/files/raw': {
    get: {
      tags: ['Fichiers'],
      summary: 'Télécharger le contenu brut d\'un fichier (aperçu)',
      security: AUTH_ANY,
      parameters: [serverIdParam, queryParam('path', 'Chemin relatif du fichier', { type: 'string' }, true)],
      responses: {
        200: { description: 'Contenu brut du fichier', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        404: errResp('Fichier introuvable'),
        413: errResp('Fichier trop volumineux (> 20 Mo)'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/files/download-token': {
    post: {
      tags: ['Fichiers'],
      summary: 'Générer un lien de téléchargement signé à usage unique (5 min)',
      security: AUTH_ANY,
      parameters: [serverIdParam],
      requestBody: jsonBody({
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' } },
          path: { type: 'string' },
        },
      }),
      responses: {
        200: jsonResp('URL signée de téléchargement', { type: 'object', properties: { url: { type: 'string' } } }),
        400: errResp('Chemin requis'),
        404: errResp('Fichier introuvable'),
        ...stdAuthErrors,
      },
    },
  },
  '/api/servers/{id}/files/download': {
    get: {
      tags: ['Fichiers'],
      summary: 'Télécharger des fichiers ou dossiers via un jeton signé à usage unique',
      security: AUTH_PUBLIC,
      parameters: [serverIdParam, queryParam('token', 'Jeton signé obtenu via /download-token', { type: 'string' }, true)],
      responses: {
        200: { description: 'Fichier brut ou archive ZIP streamée', content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } } },
        401: errResp('Lien invalide ou expiré'),
        404: errResp('Fichier introuvable'),
      },
    },
  },
};
