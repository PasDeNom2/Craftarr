# Ajouter une fonctionnalité à Craftarr (points d'extension)

Craftarr = gestionnaire de serveurs Minecraft (backend Node 22 CommonJS Express 5 + SQLite better-sqlite3 ;
frontend React 18 + Vite 8 + Tailwind + React Query + Zustand). Containers Minecraft = image itzg/minecraft-server,
pilotés par dockerode. Interface en français (i18n), commentaires en français.

## Points d'extension (n'ajoute PAS de code aux fichiers centraux sauf si la spec le demande)
Backend :
- `backend/src/config/migrations/<NN>-<fonction>.js` → `module.exports = [ 'CREATE TABLE IF NOT EXISTS …', 'ALTER TABLE servers ADD COLUMN …' ]` (SQL idempotent ; « duplicate column » est ignoré). Lire `backend/src/config/database.js`.
- `backend/src/routes/features/<fonction>.js` → `module.exports = { mount: '/api/…', router }` (ou un tableau). Chaque route protégée par `require('../../middleware/auth')`. Erreurs : `next(err)` avec `err.status`. Modèle : `backend/src/routes/backups.js`.
- `backend/src/services/extensions/<fonction>.js` → voir l'en-tête de `backend/src/services/extensions.js` (env, ports, labels, publishGamePort, fields, decorate, init({ events, io, app })).
- Bus d'événements : `backend/src/services/events.js` (liste des événements dans l'en-tête).
- Réglages globaux : `require('../services/appSettings').register('ma_cle', { secret })` puis get/set.
- Installer un projet Modrinth sur un serveur : `backend/src/services/modrinthInstall.js` (`ensureProject(server, slug)`).
- Validation : `backend/src/services/validate.js` (int, bool, str, oneOf → erreurs 400).
- Verrou par serveur : `backend/src/services/serverLock.js` (`requireIdle`, `withLock`).
- RCON : `backend/src/services/rcon.js` (`sendCommand(server, cmd)`). Docker : `backend/src/services/docker.js`.
- Dossier d'un serveur : `<DATA_PATH>/servers/<id>/server` (DATA_PATH = process.env.DATA_PATH || '/data').
Frontend :
- `frontend/src/extensions/registry.js` (lire l'en-tête) : onglets serveur `frontend/src/components/extensions/tabs/*.jsx`, sections Paramètres `…/extensions/settings/*.jsx`, blocs de paramètres d'un serveur `…/extensions/server-settings/*.jsx`, pages `…/extensions/pages/*.jsx`.
- Appels API : `import api from '../../../services/api'` (instance axios, baseURL /api, jeton inclus). Ne PAS modifier `frontend/src/services/api.js` : chaque fonctionnalité met ses fonctions dans `frontend/src/services/features/<fonction>.js`.
- Traductions : `frontend/src/i18n/locales/features/<fonction>.fr.json` et `<fonction>.en.json` (objets imbriqués, clés préfixées par le nom de la fonction, ex. `{ "scheduler": { "title": "…" } }`). Utiliser `const { t } = useI18n()` (`frontend/src/i18n/index.jsx`).
- Style : classes existantes de `frontend/src/index.css` (`card`, `btn-primary`, `btn-secondary`, `btn-ghost`, `input`, `label`, `glass`), icônes `lucide-react`, toasts `react-hot-toast`, données via `@tanstack/react-query`. Composants réutilisables : `frontend/src/components/ui/Modal.jsx`, `ConfirmDialog.jsx`, `Switch.jsx`, `Segmented.jsx`.

## Règles
- Aucune nouvelle dépendance npm sauf si la spec l'autorise explicitement (alors l'ajouter au package.json concerné, NE PAS lancer npm).
- Ne pas modifier les tests existants. Ajouter des tests backend `backend/test/<fonction>.test.js` (node:test ; modèles : `backend/test/players.test.js` pour une mini-app Express avec un vrai JWT, `backend/test/updater.test.js` pour simuler Docker via require.cache). Pas d'accès réseau ni Docker réel dans les tests (simuler axios/dockerode).
- Accessibilité : labels reliés (htmlFor/id), aria-label sur les boutons icône.
- Sécurité : valider toutes les entrées, chemins de fichiers via `require('../routes/servers/files').resolveSafe` si l'utilisateur fournit un chemin, jamais de secret renvoyé à l'interface.

## Vérification (doit passer)
- `cd backend && npm test && npm run typecheck`
- `cd frontend && npm run lint && npm test && npm run build`
