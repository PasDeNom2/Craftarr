// Route d'historique des métriques serveur : GET /api/servers/:id/metrics/history?range=1h|6h|24h|7d|30d
const express = require('express');
const { getDb } = require('../../config/database');
const authMiddleware = require('../../middleware/auth');
const validate = require('../../services/validate');

const router = express.Router();

const RANGES = {
  '1h':  { seconds: 3600,       table: 'metrics_samples' },
  '6h':  { seconds: 6 * 3600,   table: 'metrics_samples' },
  '24h': { seconds: 24 * 3600,  table: 'metrics_samples' },
  '7d':  { seconds: 7 * 86400,  table: 'metrics_hourly' },
  '30d': { seconds: 30 * 86400, table: 'metrics_hourly' },
};
const VALID_RANGES = Object.keys(RANGES);
const MAX_POINTS = 800;

/**
 * Réduit une série triée à au plus `maxPoints` points tout en conservant le premier et le dernier.
 */
function downsample(rows, maxPoints = MAX_POINTS) {
  if (rows.length <= maxPoints) return rows;
  const out = [];
  const step = (rows.length - 1) / (maxPoints - 1);
  let lastIdx = -1;
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.round(i * step);
    if (idx !== lastIdx) {
      out.push(rows[idx]);
      lastIdx = idx;
    }
  }
  return out;
}

// GET /api/servers/:id/metrics/history?range=1h|6h|24h|7d|30d
router.get('/:id/metrics/history', authMiddleware, (req, res, next) => {
  try {
    const range = req.query.range === undefined
      ? '1h'
      : validate.oneOf(String(req.query.range), VALID_RANGES, 'range');

    const db = getDb();
    const server = db.prepare('SELECT id FROM servers WHERE id = ?').get(req.params.id);
    if (!server) return res.status(404).json({ error: 'Serveur introuvable' });

    const { seconds, table } = RANGES[range];
    const sinceTs = Math.floor(Date.now() / 1000) - seconds;

    const rows = db.prepare(
      `SELECT ts, cpu, mem_mb, players, tps FROM ${table} WHERE server_id = ? AND ts >= ? ORDER BY ts ASC`
    ).all(server.id, sinceTs);

    const points = downsample(rows).map(r => ({
      t: r.ts * 1000,
      cpu: r.cpu,
      mem: r.mem_mb,
      players: r.players,
      tps: r.tps,
    }));

    res.json({ range, points });
  } catch (err) {
    next(err);
  }
});

module.exports = { mount: '/api/servers', router };
