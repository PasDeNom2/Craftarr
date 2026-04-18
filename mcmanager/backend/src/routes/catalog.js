const express = require('express');
const { aggregateSearch, getModpackDetail, getModpackVersions } = require('../services/sourceAggregator');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// GET /api/catalog?query=&mcVersion=&limit=&offset=
router.get('/', authMiddleware, async (req, res, next) => {
  try {
    const { query = '', mcVersion, limit = 20, offset = 0 } = req.query;
    const results = await aggregateSearch({
      query,
      mcVersion,
      pageSize: Number(limit),
      index: Number(offset),
      limit: Number(limit),
    });
    res.json({ data: results, total: results.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/catalog/:source/:id
router.get('/:source/:id', authMiddleware, async (req, res, next) => {
  try {
    const { source, id } = req.params;
    const detail = await getModpackDetail(source, id);
    if (!detail) return res.status(404).json({ error: 'Modpack introuvable' });
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

// GET /api/catalog/:source/:id/versions
router.get('/:source/:id/versions', authMiddleware, async (req, res, next) => {
  try {
    const { source, id } = req.params;
    const versions = await getModpackVersions(source, id);
    res.json(versions);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
