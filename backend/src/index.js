require('dotenv').config();

// Génération/chargement des secrets persistants AVANT tout le reste
const { loadOrCreateSecrets } = require('./config/secrets');
loadOrCreateSecrets();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');

const { initDb } = require('./config/database');
const { ensureAdminUser } = require('./routes/auth');
const errorHandler = require('./middleware/errorHandler');

const authRoutes = require('./routes/auth').router;
const serverRoutes = require('./routes/servers');
const catalogRoutes = require('./routes/catalog');
const sourcesRoutes = require('./routes/sources');
const backupsRoutes = require('./routes/backups');

const { setupLogsSocket } = require('./websocket/logs');
const metrics = require('./services/metrics');
const installer = require('./services/installer');
const updater = require('./services/updater');

const PORT = process.env.PORT || 3000;

// ─── Init DB ────────────────────────────────────────────────
initDb();

// ─── Express ────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('tiny'));

const limiter = rateLimit({ windowMs: 60 * 1000, max: 200, standardHeaders: true });
app.use('/api/', limiter);

// ─── Routes ─────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/servers', serverRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/api/sources', sourcesRoutes);
app.use('/api/servers', backupsRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true, version: '1.0.0' }));

app.use(errorHandler);

// ─── Socket.io ──────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});

// Authentification socket via JWT
const jwt = require('jsonwebtoken');
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error('Token manquant'));
  try {
    socket.user = jwt.verify(token, process.env.JWT_SECRET || 'change-me');
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

// ─── Démarrage ──────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`[MCManager] Backend démarré sur le port ${PORT}`);
  await ensureAdminUser();
  metrics.startPolling();
  updater.scheduleUpdater();
});

// ─── Arrêt propre ───────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('[MCManager] SIGTERM reçu, arrêt propre...');
  metrics.stopPolling();
  server.close(() => {
    console.log('[MCManager] Serveur arrêté.');
    process.exit(0);
  });
});
