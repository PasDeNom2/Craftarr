# Craftarr ⛏️

Self-hosted Minecraft server manager with a modern web interface.
Deploy modpacks from CurseForge and Modrinth in a few clicks.

---

## Features

- **Unified catalogue** — CurseForge + Modrinth + custom sources in one view
- **One-click deploy** — smart form, real-time progress bar
- **Server dashboard** — status, metrics (RAM/CPU), live console, RCON
- **Auto-updater** — periodic check, pre-update backup, one-click rollback
- **Automatic backups** — worlds, configs, plugins (timestamped tar.gz)
- **Multi-source** — add your own modpack APIs with a JSON field mapper
- **Multilingual** — 17 languages (EN, FR, ES, DE, PT, IT, RU, ZH, JA, KO, AR, PL, NL, TR, UK, SV, CS)

---

## Quick start

### Requirements

- Docker ≥ 24
- Docker Compose v2

### Install

```bash
git clone https://github.com/PasDeNom2/Craftarr.git
cd Craftarr
cp .env.example .env
```

Edit `.env` and add your CurseForge API key:

```env
CURSEFORGE_API_KEY=your-curseforge-key
```

Admin credentials (JWT secret, encryption key, password) are **auto-generated** on first start and printed in the backend logs.

### Start

```bash
docker-compose up -d
```

Open **http://localhost:8080** — credentials are shown in the logs:

```bash
docker-compose logs backend
```

### Get a CurseForge API key

1. Go to https://console.curseforge.com
2. Sign in or create an account
3. Generate a key under "API Keys"
4. Add it to `.env` or directly in Settings → API Sources

---

## Data structure

```
data/
├── craftarr.db       ← SQLite database (config, servers, backups)
├── secrets.json      ← Auto-generated secrets (never commit this)
└── servers/
    └── {server-id}/
        ├── server/   ← Bind-mounted into the Minecraft container
        │   ├── world/
        │   ├── mods/
        │   └── config/
        └── backups/  ← Timestamped tar.gz snapshots
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `CURSEFORGE_API_KEY` | — | CurseForge API key (required for CurseForge) |
| `MODRINTH_API_KEY` | — | Modrinth API key (optional) |
| `UI_PORT` | `8080` | Web UI port |
| `HOST_DATA_PATH` | `/root/Projet/craftarr/data` | Host path to the data folder |
| `UPDATE_CHECK_INTERVAL_HOURS` | `6` | How often to check for modpack updates |
| `ADMIN_USERNAME` | `admin` | Override auto-generated admin username |
| `ADMIN_PASSWORD` | auto-generated | Override auto-generated admin password |

---

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Node.js 20 + Express + Socket.io |
| Frontend | React 18 + Vite + TailwindCSS |
| Database | SQLite (better-sqlite3) |
| MC containers | itzg/minecraft-server |
| Docker API | dockerode (Docker socket) |
| Encryption | AES-256-GCM (native Node.js crypto) |
| Auth | JWT (7 days) + bcrypt |

---

## Useful commands

```bash
# Stream logs
docker-compose logs -f backend

# Restart after .env changes
docker-compose up -d --force-recreate

# Stop
docker-compose down

# Stop and wipe all data
docker-compose down -v
```

---

## Local development

```bash
# Backend — http://localhost:3000
cd backend && npm install && npm run dev

# Frontend — http://localhost:5173 (proxied to :3000)
cd frontend && npm install && npm run dev
```

---

## Security

- Secrets (JWT, encryption key, admin password) are auto-generated on first start and stored in `data/secrets.json`
- Third-party API keys are stored AES-256-GCM encrypted in SQLite
- Do not expose the UI directly to the internet without a reverse proxy (nginx / traefik + HTTPS)
