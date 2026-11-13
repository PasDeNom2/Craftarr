// @ts-check
/**
 * Versions Minecraft supportées par les types de serveurs dérivés de Vanilla (Paper, Purpur).
 * Route montée sur /api/vanilla via routes/features/server-types.js.
 */
const express = require('express');
const axios = require('axios');
const authMiddleware = require('../../middleware/auth');

const router = express.Router();

const SOURCES = {
  paper: 'https://api.papermc.io/v2/projects/paper',
  purpur: 'https://api.purpurmc.org/v2/purpur',
};

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 h
const TIMEOUT_MS = 15000;            // 15 s
const UA = { 'User-Agent': 'Craftarr (github.com/PasDeNom2/Craftarr)' };

/** @type {Map<string, { expiresAt: number, versions: string[] }>} */
const cache = new Map();

// GET /api/vanilla/server-types/:type/versions
router.get('/server-types/:type/versions', authMiddleware, async (req, res, next) => {
  try {
    const type = String(req.params.type || '').toLowerCase();
    const url = SOURCES[type];
    if (!url) {
      res.status(400).json({ error: `Type de serveur inconnu : ${req.params.type}` });
      return;
    }

    const now = Date.now();
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    const hit = !force ? cache.get(type) : null;
    if (hit && hit.expiresAt > now) {
      res.json({ type, versions: hit.versions, latest: hit.versions[0] || null, cached: true });
      return;
    }

    const { data } = await axios.get(url, { timeout: TIMEOUT_MS, headers: UA });
    const raw = Array.isArray(data?.versions) ? data.versions : [];
    // Paper et Purpur renvoient les versions de la plus ancienne à la plus récente
    const versions = raw.map(v => String(v || '').trim()).filter(Boolean).reverse();

    cache.set(type, { expiresAt: now + CACHE_TTL_MS, versions });
    res.json({ type, versions, latest: versions[0] || null, cached: false });
  } catch (err) {
    next(err);
  }
});

module.exports = {
  mount: '/api/vanilla',
  router,
  _internals: { cache, SOURCES, CACHE_TTL_MS, TIMEOUT_MS },
};
