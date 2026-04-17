# Craftarr ⛏️

Gestionnaire de serveurs Minecraft auto-hébergé avec interface web moderne.
Déployez des modpacks depuis CurseForge et Modrinth en quelques clics.

---

## Fonctionnalités

- **Catalogue unifié** — CurseForge + Modrinth + sources tierces en une vue
- **Déploiement en 3 clics** — formulaire intelligent, progression en temps réel
- **Dashboard serveur** — statut, métriques (RAM/CPU), console live, RCON
- **Auto-updater** — vérification périodique, backup pre-update, rollback 1 clic
- **Sauvegardes automatiques** — worlds, configs, plugins (tar.gz horodatés)
- **Multi-sources** — ajoutez vos propres APIs de modpacks avec mapper JSON
- **Multilingue** — 17 langues (FR, EN, ES, DE, PT, IT, RU, ZH, JA, KO, AR, PL, NL, TR, UK, SV, CS)

---

## Démarrage rapide

### Prérequis

- Docker ≥ 24
- Docker Compose v2

### Installation

```bash
git clone https://github.com/PasDeNom2/MCManager.git craftarr
cd craftarr
cp .env.example .env
```

Éditez `.env` :

```env
CURSEFORGE_API_KEY=votre-cle-curseforge   # Requis pour CurseForge
```

Les secrets (JWT, chiffrement, mot de passe admin) sont générés automatiquement au premier démarrage et affichés dans les logs du backend.

### Lancement

```bash
docker-compose up -d
```

Interface disponible sur **http://localhost:8080**

Les identifiants admin sont affichés dans les logs au premier démarrage :

```bash
docker-compose logs backend
```

### Obtenir une clé CurseForge

1. Rendez-vous sur https://console.curseforge.com
2. Créez un compte ou connectez-vous
3. Générez une clé API dans "API Keys"
4. Ajoutez-la dans `.env` ou directement dans Paramètres → Sources API

---

## Structure des données

```
data/
├── craftarr.db       ← Base SQLite (config, serveurs, backups)
├── secrets.json      ← Secrets auto-générés (ne pas committer)
└── servers/
    └── {server-id}/
        ├── server/   ← Volume monté dans le container Minecraft
        │   ├── world/
        │   ├── mods/
        │   └── config/
        └── backups/  ← Snapshots tar.gz horodatés
```

---

## Variables d'environnement

| Variable | Défaut | Description |
|---|---|---|
| `CURSEFORGE_API_KEY` | — | Clé API CurseForge (requis pour CurseForge) |
| `MODRINTH_API_KEY` | — | Clé API Modrinth (optionnelle) |
| `UI_PORT` | `8080` | Port de l'interface web |
| `HOST_DATA_PATH` | `/root/Projet/craftarr/data` | Chemin hôte du dossier data |
| `UPDATE_CHECK_INTERVAL_HOURS` | `6` | Fréquence de vérification des mises à jour |
| `ADMIN_USERNAME` | `admin` | Surcharge du nom admin (optionnel) |
| `ADMIN_PASSWORD` | auto-généré | Surcharge du mot de passe admin (optionnel) |

---

## Architecture technique

| Couche | Technologie |
|---|---|
| Backend | Node.js 20 + Express + Socket.io |
| Frontend | React 18 + Vite + TailwindCSS |
| Base de données | SQLite (better-sqlite3) |
| Containers MC | itzg/minecraft-server |
| Communication Docker | dockerode (Docker socket) |
| Chiffrement | AES-256-GCM (crypto natif Node.js) |
| Auth | JWT (7 jours) + bcrypt |

---

## Commandes utiles

```bash
# Voir les logs en temps réel
docker-compose logs -f backend

# Redémarrer après modification du .env
docker-compose up -d --force-recreate

# Arrêt propre
docker-compose down

# Arrêt + suppression des volumes (repart de zéro)
docker-compose down -v
```

---

## Développement local

```bash
# Backend (port 3000)
cd backend && npm install && npm run dev

# Frontend (port 5173, proxie vers localhost:3000)
cd frontend && npm install && npm run dev
```

---

## Sécurité

- Les secrets (JWT, clé de chiffrement, mot de passe admin) sont auto-générés au premier démarrage dans `data/secrets.json`
- Les clés API tierces sont stockées chiffrées en AES-256-GCM dans SQLite
- Ne pas exposer l'interface directement sur internet sans reverse proxy (nginx/traefik + HTTPS)
