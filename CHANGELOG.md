# Changelog — MCManager → Craftarr

## v2.0.0 — Craftarr (2026-04-17)

Complete rewrite of MCManager under the new name **Craftarr**.

---

### New features

#### Auto-generated secrets
MCManager required you to manually set `JWT_SECRET`, `ADMIN_PASSWORD`, and `ENCRYPTION_KEY` in `.env` before first start — wrong or missing values caused silent failures.  
Craftarr generates all secrets automatically on first start and prints them in the backend logs. The `.env` only needs a CurseForge API key.

#### Multi-language UI (17 languages)
The interface is now fully translated in 17 languages: English, French, Spanish, German, Portuguese, Italian, Russian, Chinese, Japanese, Korean, Arabic, Polish, Dutch, Turkish, Ukrainian, Swedish, Czech.  
MCManager was French-only.

#### Smart client-only mod filtering
When installing a modpack from a CurseForge client pack, Craftarr now automatically detects and skips mods that are marked **client-only** by the CurseForge API (`gameVersions` includes `"Client"` but not `"Server"`). A hardcoded fallback list covers mods with missing tags (drippyloadingscreen, fancymenu, optifine, replaymod, …).  
MCManager did not do this filtering, causing server crashes on modpacks that include client-only mods (e.g. ATM11).

#### Server state reconciliation on startup
When the backend restarts, it now checks every `starting`/`running` server against Docker. If a container has been removed (daemon restart, manual `docker rm`, crash), the server is immediately set to `error` status instead of staying stuck in a phantom active state.  
MCManager left orphaned servers permanently in a broken state after container loss.

#### Live status propagation for lost containers
If a Docker container disappears while the backend is running, the log stream error is caught, the server status is updated to `error` in the DB, and all connected clients receive a `server:status` event in real time.  
MCManager only logged the error to the console with no DB update.

#### Server icon endpoint no longer requires auth
`GET /api/servers/:id/icon` was protected by the auth middleware, causing a 401 on every server card because browser `<img>` tags cannot send JWT tokens.  
Fixed: the endpoint no longer requires authentication (the icon is not sensitive data).

#### Modrinth support
Modpacks from Modrinth can now be deployed alongside CurseForge modpacks, with the same one-click flow and client-only mod filtering.  
MCManager only supported CurseForge.

#### Setup wizard
A first-run setup page guides the user through creating the admin account and adding API keys.  
MCManager required manual `.env` editing with no UI guidance.

---

### Breaking changes

- Project renamed from **MCManager** to **Craftarr** — the Docker image and compose service names have changed accordingly.
- The database file is now `craftarr.db` (was `mcmanager.db`). No automatic migration is provided; existing MCManager data must be migrated manually.
- Secrets are no longer read from `.env` — they are stored in `data/secrets.json`. Remove `JWT_SECRET`, `ADMIN_PASSWORD`, and `ENCRYPTION_KEY` from your `.env` after migration.

---

### Bug fixes

- Fixed server staying in `starting` status indefinitely when the Minecraft container crashed before logging "Done".
- Fixed 401 errors on server icons in the UI.
- Fixed client-only mods (e.g. drippyloadingscreen, fancymenu) crashing NeoForge/Fabric servers on modpacks that bundle them.
- Fixed log stream attempting to attach to a deleted container on every page load, spamming the console.
