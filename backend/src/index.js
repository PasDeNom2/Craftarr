require('dotenv').config();

// Génération/chargement des secrets persistants AVANT tout le reste
const { loadOrCreateSecrets, getJwtSecret } = require('./config/secrets');
loadOrCreateSecrets();
getJwtSecret(); // échoue immédiatement (et lisiblement) si le secret est invalide

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');

const { initDb } = require('./config/database');
const { initSetupToken } = require('./routes/auth');
const errorHandler = require('./middleware/errorHandler');

const authRoutes = require('./routes/auth').router;
const serverRoutes = require('./routes/servers');
const catalogRoutes = require('./routes/catalog');
const sourcesRoutes = require('./routes/sources');
const backupsRoutes = require('./routes/backups');
const vanillaRoutes = require('./routes/vanilla');

const { setupLogsSocket, startLogStream, setIo: setLogsIo } = require('./websocket/logs');
const metrics = require('./services/metrics');
const installer = require('./services/installer');
const updater = require('./services/updater');

const PORT = process.env.PORT || 3000;

// ─── Init DB ────────────────────────────────────────────────
initDb();
require('./services/backup').migrateBackupLocation();

// Reset stuck installs/updates from a previous process crash
{
  const { getDb } = require('./config/database');
  const db = getDb();
  const stuck = db.prepare("UPDATE servers SET status = 'error' WHERE status IN ('installing', 'updating')").run();
  if (stuck.changes > 0) console.log(`[Startup] ${stuck.changes} serveur(s) bloqué(s) en installing/updating → réinitialisés à 'error'`);
}

// ─── Express ────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

app.use(helmet({ contentSecurityPolicy: false }));
// Pas de CORS : l'UI est servie sur la même origine (nginx en prod, proxy Vite en dev).
// L'ancien cors({ origin: '*' }) permettait à n'importe quel site d'appeler l'API.
app.use(express.json({ limit: '10mb' }));
app.use(morgan('tiny'));

// Le backend n'est joignable que via nginx (1 proxy) : req.ip = vraie IP du client (X-Forwarded-For)
app.set('trust proxy', 1);

const limiter = rateLimit({ windowMs: 60 * 1000, max: 200, standardHeaders: true });
app.use('/api/', limiter);

// Anti brute-force : 10 échecs / 15 min par IP sur la connexion et la création du compte admin.
// Les connexions réussies ne sont pas comptées (l'admin ne se bloque pas lui-même).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  skipSuccessfulRequests: true,
  message: { error: 'Trop de tentatives — réessayez dans 15 minutes' },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/setup', authLimiter);

// ─── Routes ─────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/servers', serverRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/api/sources', sourcesRoutes);
app.use('/api/servers', backupsRoutes);
app.use('/api/vanilla', vanillaRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true, version: '1.0.0' }));

app.use(errorHandler);

// ─── Socket.io ──────────────────────────────────────────────
const io = new Server(server, {
  transports: ['websocket', 'polling'],
});

// Authentification socket via JWT
const jwt = require('jsonwebtoken');
io.use((socket, next) => {
  // Token uniquement via auth (pas en query string : il finirait dans les logs d'accès)
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Token manquant'));
  try {
    socket.user = jwt.verify(token, getJwtSecret());
    next();
  } catch {
    next(new Error('Token invalide'));
  }
});

// Injection io dans les services
metrics.setIo(io);
installer.setIo(io);
updater.setIo(io);

// Setup handlers WebSocket
setupLogsSocket(io);
setLogsIo(io);

app.set('io', io);

// ─── Démarrage ──────────────────────────────────────────────
const { getDb } = require('./config/database');
const dockerService = require('./services/docker');
const rcon = require('./services/rcon');

async function reconcileServerStates() {
  const db = getDb();
  const activeServers = db.prepare("SELECT * FROM servers WHERE status IN ('starting', 'running') AND container_id IS NOT NULL").all();

  // Remettre tous les joueurs offline par défaut — la synchro RCON ci-dessous corrigera ensuite
  db.prepare('UPDATE players SET is_online = 0').run();

  for (const server of activeServers) {
    const state = await dockerService.getContainerStatus(server.container_id);
    if (state === 'removed') {
      db.prepare("UPDATE servers SET status = 'error' WHERE id = ?").run(server.id);
      console.log(`[Craftarr] Serveur ${server.id.slice(0, 8)} — container disparu, statut mis en erreur`);
    } else if (state === 'running') {
      // Relance le stream de logs pour capturer les événements joueurs dès le démarrage
      startLogStream(io, server.id);
      // Synchro des joueurs en ligne via RCON
      rcon.getPlayerList(server).then(({ names }) => {
        for (const username of names) {
          db.prepare('UPDATE players SET is_online = 1 WHERE server_id = ? AND username = ?').run(server.id, username);
        }
      }).catch(() => {});
    }
  }
}

server.listen(PORT, async () => {
  console.log(`[Craftarr] Backend démarré sur le port ${PORT}`);
  initSetupToken();
  await reconcileServerStates();
  metrics.startPolling();
  updater.scheduleUpdater();
  require('./services/backup').scheduleBackups();
});

// ─── Arrêt propre ───────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('[Craftarr] SIGTERM reçu, arrêt propre...');
  metrics.stopPolling();
  server.close(() => {
    console.log('[Craftarr] Serveur arrêté.');
    process.exit(0);
  });
});
