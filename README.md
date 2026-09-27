# Craftarr ⛏️

Self-hosted Minecraft server manager with a modern web interface.  
Deploy vanilla, modpacks (CurseForge / Modrinth) and custom packs in a few clicks — all from your browser.

![GitHub tag](https://img.shields.io/github/v/tag/PasDeNom2/Craftarr?label=version)
![License](https://img.shields.io/github/license/PasDeNom2/Craftarr)

---

## Features

- **Unified catalogue** — CurseForge + Modrinth + custom sources in one view
- **One-click deploy** — smart install form with real-time progress bar
- **Server dashboard** — status, RAM/CPU metrics, live console, RCON commands
- **Players panel** — online status in real-time, join/leave history, ban/unban
- **Auto-updater** — periodic modpack update check, pre-update backup, one-click rollback
- **Automatic backups** — worlds, configs, plugins saved as timestamped `.tar.gz`
- **Multi-source** — add your own modpack APIs with a JSON field mapper
- **Multilingual** — 17 languages (EN, FR, ES, DE, PT, IT, RU, ZH, JA, KO, AR, PL, NL, TR, UK, SV, CS)

---

## Quick start

### Requirements

- **Docker** ≥ 24
- **Docker Compose** v2
- A **CurseForge API key** (free) if you want to browse CurseForge modpacks

### 1 — Clone the repo

```bash
git clone https://github.com/PasDeNom2/Craftarr.git
cd Craftarr
```

### 2 — Start

**Linux / macOS:**
```bash
chmod +x setup.sh && ./setup.sh
```

**Windows (PowerShell / CMD):**
```bat
setup.bat
```

The setup scripts automatically set `HOST_DATA_PATH` to the current directory and launch the stack with `docker compose up -d`.

> **Manual start** — if you prefer not to use the scripts:
> ```bash
> cp .env.example .env
> # Edit .env to set HOST_DATA_PATH to the absolute path of this folder
> docker compose up -d
> ```

### 3 — Open the UI

```
http://localhost:1024
```

On first start, the UI asks you to create the admin account. To prove you own the server, it asks for a **setup token** printed in the backend logs:

```bash
docker compose logs backend | grep -i "jeton"
```

### 4 — Add a CurseForge API key *(optional)*

1. Go to <https://console.curseforge.com>
2. Sign in or create a free account
3. Generate a key under **API Keys**
4. Paste it in `.env` → `CURSEFORGE_API_KEY=your-key`  
   **or** directly in the UI: **Settings → API Sources**

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `HOST_DATA_PATH` | *(required)* | Absolute path on the host where data is stored (set automatically by the setup scripts) |
| `UI_PORT` | `1024` | Port exposed for the web UI |
| `CURSEFORGE_API_KEY` | — | CurseForge API key (required for CurseForge catalogue) |
| `MODRINTH_API_KEY` | — | Modrinth API key (optional) |
| `UPDATE_CHECK_INTERVAL_HOURS` | `6` | How often Craftarr checks for modpack updates |
| `BACKUP_INTERVAL_HOURS` | `6` | Automatic backups of running servers (`0` = disabled) |
| `BACKUP_KEEP` | `8` | Number of automatic backups kept per server (manual backups are never pruned) |

> Secrets (JWT secret, encryption key) are **auto-generated** on first start and stored in `data/secrets.json`. Never commit this file.

---

## Data structure

```
data/
├── craftarr.db        ← SQLite database (servers, players, backups metadata)
├── secrets.json       ← Auto-generated secrets — do NOT commit
├── backups/
│   └── {server-id}/   ← Timestamped .zip snapshots (kept when a server is deleted)
└── servers/
    └── {server-id}/
        └── server/    ← Bind-mounted into the Minecraft container
            ├── world/
            ├── mods/
            └── config/
```

---

## Useful commands

```bash
# View backend logs
docker compose logs -f backend

# View frontend logs
docker compose logs -f frontend

# Restart after .env changes
docker compose up -d --force-recreate

# Stop
docker compose down

# Stop and delete all data (irreversible)
docker compose down -v
```

---

## Reverse proxy (HTTPS)

It is strongly recommended **not** to expose Craftarr directly to the internet.  
Use a reverse proxy such as **Nginx Proxy Manager**, **Traefik**, or **Caddy**.

Example minimal Nginx config:

```nginx
server {
    listen 443 ssl;
    server_name craftarr.yourdomain.com;

    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

> The `Upgrade` / `Connection` headers are required for WebSocket (live console, metrics).

---

## Troubleshooting

**The UI shows "no server deployed" after a backend restart**  
→ This is fixed in v2.2.0 — the sidebar reconnects automatically via WebSocket.

**Minecraft servers are not visible in Docker after a host reboot**  
→ Make sure `HOST_DATA_PATH` points to the correct absolute path. Run `./setup.sh` again to fix it.

**Port already in use**  
→ Change `UI_PORT` in `.env` and run `docker compose up -d --force-recreate`.

**Admin password lost**  
→ Reset it from the backend container (a random password is printed if you omit it):  
```bash
docker exec -it craftarr-backend node src/scripts/reset-password.js [username] [new-password]
```

**Simple Voice Chat doesn't work**  
→ Craftarr publishes the voice chat on the **same port number as the server, in UDP**. Forward that port in **UDP** on your router (in addition to TCP), then click **Recreate** on the server once.

**Lag, rubber-banding or high ping on Windows (Docker Desktop)**  
→ Docker Desktop relays every connection through a userspace proxy, which adds latency and hides players' real IPs. Enabling WSL mirrored networking removes it: add `networkingMode=mirrored` under `[wsl2]` in `%UserProfile%.wslconfig`, then run `wsl --shutdown` and restart Docker Desktop (this stops every container).

**CurseForge modpacks don't appear**  
→ Check that `CURSEFORGE_API_KEY` is set and valid in `.env` or in Settings → API Sources.

---

## Local development

Requires **Node.js 22+** (the Docker images use Node 24 LTS).

```bash
# Backend — http://localhost:3000
cd backend && npm ci && npm run dev

# Frontend — http://localhost:5173 (proxied to :3000)
cd frontend && npm ci && npm run dev
```

### Tests

```bash
cd backend && npm test
```

The suite covers installs (downloads, hashes, `.mrpack`, zip-slip), modpack updates with rollback, backups/restore/world import, auth hardening and the HTTP API (a real backend is started on a temporary data folder — no Docker needed). CI runs it on every push (`.github/workflows/ci.yml`).

---

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Node.js 24 + Express + Socket.io |
| Frontend | React 18 + Vite + TailwindCSS |
| Database | SQLite (better-sqlite3) |
| Minecraft containers | itzg/minecraft-server |
| Docker API | dockerode (Docker socket) |
| Encryption | AES-256-GCM (native Node.js crypto) |
| Auth | JWT (7 days) + bcrypt |

---

## Security

- All secrets are auto-generated on first start and stored in `data/secrets.json` — keep this file private
- Third-party API keys are stored **AES-256-GCM encrypted** in SQLite
- Do **not** expose the UI directly to the internet without a reverse proxy + HTTPS
- The Docker socket (`/var/run/docker.sock`) is mounted read-write — treat the host as trusted
