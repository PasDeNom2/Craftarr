# MCManager ⛏️

Gestionnaire de serveurs Minecraft auto-hébergé avec interface web moderne.
Déployez des modpacks depuis CurseForge et Modrinth en 3 clics.

## Fonctionnalités

- **Catalogue unifié** — CurseForge + Modrinth + sources tierces en une vue
- **Déploiement en 3 clics** — formulaire intelligent, progress bar temps réel
- **Dashboard** — statut, métriques (RAM/CPU/TPS), console live, RCON
- **Auto-updater** — vérification périodique, backup pre-update, rollback 1 clic
- **Sauvegardes automatiques** — worlds, configs, plugins (tar.gz horodatés)
- **Multi-sources** — ajoutez vos propres APIs de modpacks avec mapper JSON

## Déploiement rapide (5 minutes)

### Prérequis
- Docker ≥ 24
- Docker Compose v2

### Installation

```bash
git clone <repo>
cd mcmanager
cp .env.example .env
```

Éditez `.env` :

```env
JWT_SECRET=votre-secret-tres-long-et-aleatoire
ADMIN_USERNAME=admin
ADMIN_PASSWORD=votre-mot-de-passe
CURSEFORGE_API_KEY=votre-cle-curseforge   # Requis pour CurseForge
ENCRYPTION_KEY=32-caracteres-aleatoires   # Exactement 32 chars
```

### Lancement

```bash
docker-compose up -d
```

L'interface est disponible sur **http://localhost:8080**

Connexion avec le compte défini dans `.env` (`admin` / `changeme` par défaut).

### Obtenir une clé CurseForge

1. Rendez-vous sur https://console.curseforge.com
2. Créez un compte / connectez-vous
3. Générez une clé API dans "API Keys"
4. Ajoutez-la dans `.env` ou directement dans Paramètres → Clés API

## Structure des données

```
data/
├── mcmanager.db          ← Base SQLite (config, serveurs, backups)
└── servers/
    └── {server-id}/
        ├── server/       ← Volume monté dans le container Minecraft
        │   ├── world/    ← JAMAIS modifié par l'updater
        │   ├── mods/     ← Remplacé à chaque update
        │   ├── config/   ← Merge intelligent
        │   └── server.jar
        ├── backups/      ← Snapshots zip horodatés
        └── mcmanager.json
```

## Variables d'environnement

| Variable | Défaut | Description |
|---|---|---|
| `JWT_SECRET` | `change-me` | Secret JWT (changez impérativement) |
| `ADMIN_USERNAME` | `admin` | Nom de l'administrateur |
| `ADMIN_PASSWORD` | `changeme` | Mot de passe admin |
| `UI_PORT` | `8080` | Port de l'interface web |
| `ENCRYPTION_KEY` | `01234...` | Clé AES-256 (32 chars) pour chiffrer les clés API |
| `CURSEFORGE_API_KEY` | — | Clé API CurseForge |
| `MODRINTH_API_KEY` | — | Clé API Modrinth (optionnelle) |
| `UPDATE_CHECK_INTERVAL_HOURS` | `6` | Fréquence de vérification des updates |

## Architecture technique

| Couche | Technologie |
|---|---|
| Backend | Node.js 20 + Express + socket.io |
| Frontend | React 18 + Vite + TailwindCSS |
| Base de données | SQLite (better-sqlite3) |
| Containers MC | itzg/minecraft-server |
| Communication Docker | dockerode (Docker socket) |
| Chiffrement | AES-256-GCM (crypto natif) |

## Commandes utiles

```bash
# Voir les logs
docker-compose logs -f backend

# Redémarrer après modif .env
docker-compose up -d --force-recreate

# Arrêt propre
docker-compose down

# Arrêt + suppression des volumes (efface tout)
docker-compose down -v
```

## Sécurité

- Changez `JWT_SECRET` et `ADMIN_PASSWORD` avant toute exposition sur internet
- Les clés API tierces sont stockées chiffrées en AES-256-GCM dans SQLite
- L'interface n'est pas conçue pour être exposée directement sur internet sans reverse proxy (nginx/traefik + HTTPS)

## Développement local

```bash
# Backend
cd backend && npm install && npm run dev

# Frontend (autre terminal)
cd frontend && npm install && npm run dev
```

Frontend disponible sur http://localhost:5173, API proxiée vers http://localhost:3000.
