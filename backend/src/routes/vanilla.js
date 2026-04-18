const express = require('express');
const https = require('https');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

const MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';
let manifestCache = null;
let manifestCachedAt = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function fetchManifest() {
  return new Promise((resolve, reject) => {
    https.get(MANIFEST_URL, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// GET /api/vanilla/versions?type=release|snapshot|all
router.get('/versions', authMiddleware, async (req, res, next) => {
  try {
    const now = Date.now();
    if (!manifestCache || now - manifestCachedAt > CACHE_TTL) {
      manifestCache = await fetchManifest();
      manifestCachedAt = now;
    }

    const type = req.query.type || 'release';
    const versions = type === 'all'
      ? manifestCache.versions
      : manifestCache.versions.filter(v => v.type === type);

    res.json({
      latest: manifestCache.latest,
      versions: versions.map(v => ({
        id: v.id,
        type: v.type,
        releaseTime: v.releaseTime,
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
