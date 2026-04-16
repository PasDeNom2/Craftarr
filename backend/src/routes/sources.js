const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../config/database');
const { encrypt, decrypt } = require('../config/encryption');
const { testConnection: cfTest } = require('../services/curseforge');
const { testConnection: mrTest } = require('../services/modrinth');
const { testCustomSource } = require('../services/sourceMapper');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

function formatSource(row) {
  return {
    id: row.id,
    name: row.name,
    base_url: row.base_url,
    format: row.format,
    field_mapping_json: row.field_mapping_json ? JSON.parse(row.field_mapping_json) : null,
    enabled: !!row.enabled,
    is_builtin: !!row.is_builtin,
    has_api_key: !!row.api_key_encrypted,
    created_at: row.created_at,
  };
}

// GET /api/sources
router.get('/', authMiddleware, (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM api_sources ORDER BY is_builtin DESC, created_at ASC').all();
  res.json(rows.map(formatSource));
});

// POST /api/sources
router.post('/', authMiddleware, (req, res, next) => {
  try {
    const { name, base_url, api_key, format, field_mapping_json } = req.body;
    if (!name || !base_url || !format) {
      return res.status(400).json({ error: 'name, base_url et format sont requis' });
    }
    const db = getDb();
    const id = uuidv4();
    db.prepare(`
      INSERT INTO api_sources (id, name, base_url, api_key_encrypted, format, field_mapping_json, enabled, is_builtin)
      VALUES (?, ?, ?, ?, ?, ?, 1, 0)
    `).run(id, name, base_url, api_key ? encrypt(api_key) : null, format, field_mapping_json ? JSON.stringify(field_mapping_json) : null);

    const row = db.prepare('SELECT * FROM api_sources WHERE id = ?').get(id);
    res.status(201).json(formatSource(row));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/sources/:id
router.patch('/:id', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const source = db.prepare('SELECT * FROM api_sources WHERE id = ?').get(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source introuvable' });

    const { name, base_url, api_key, format, field_mapping_json, enabled } = req.body;

    const updates = [];
    const values = [];
    if (name !== undefined) { updates.push('name = ?'); values.push(name); }
    if (base_url !== undefined) { updates.push('base_url = ?'); values.push(base_url); }
    if (api_key !== undefined) { updates.push('api_key_encrypted = ?'); values.push(api_key ? encrypt(api_key) : null); }
    if (format !== undefined && !source.is_builtin) { updates.push('format = ?'); values.push(format); }
    if (field_mapping_json !== undefined) { updates.push('field_mapping_json = ?'); values.push(field_mapping_json ? JSON.stringify(field_mapping_json) : null); }
    if (enabled !== undefined) { updates.push('enabled = ?'); values.push(enabled ? 1 : 0); }

    if (updates.length === 0) return res.json(formatSource(source));

    values.push(req.params.id);
    db.prepare(`UPDATE api_sources SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.prepare('SELECT * FROM api_sources WHERE id = ?').get(req.params.id);
    res.json(formatSource(updated));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/sources/:id
router.delete('/:id', authMiddleware, (req, res, next) => {
  try {
    const db = getDb();
    const source = db.prepare('SELECT * FROM api_sources WHERE id = ?').get(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source introuvable' });
    if (source.is_builtin) return res.status(403).json({ error: 'Les sources natives ne peuvent pas être supprimées' });
    db.prepare('DELETE FROM api_sources WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/sources/:id/test
router.post('/:id/test', authMiddleware, async (req, res, next) => {
  try {
    const db = getDb();
    const source = db.prepare('SELECT * FROM api_sources WHERE id = ?').get(req.params.id);
    if (!source) return res.status(404).json({ error: 'Source introuvable' });

    const apiKey = source.api_key_encrypted ? decrypt(source.api_key_encrypted) : (
      source.id === 'curseforge' ? process.env.CURSEFORGE_API_KEY :
      source.id === 'modrinth' ? process.env.MODRINTH_API_KEY : ''
    );

    let result;
    if (source.id === 'curseforge' || source.format === 'curseforge') {
      result = await cfTest(apiKey);
    } else if (source.id === 'modrinth' || source.format === 'modrinth') {
      result = await mrTest(apiKey);
    } else {
      result = await testCustomSource(source);
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/sources/export
router.get('/export', authMiddleware, (req, res) => {
  const db = getDb();
  const sources = db.prepare('SELECT * FROM api_sources WHERE is_builtin = 0').all().map(formatSource);
  res.setHeader('Content-Disposition', 'attachment; filename="mcmanager-sources.json"');
  res.json(sources);
});

// POST /api/sources/import
router.post('/import', authMiddleware, (req, res, next) => {
  try {
    const sources = req.body;
    if (!Array.isArray(sources)) return res.status(400).json({ error: 'Format invalide' });
    const db = getDb();
    let imported = 0;
    for (const s of sources) {
      if (!s.name || !s.base_url || !s.format) continue;
      const id = uuidv4();
      db.prepare(`
        INSERT OR IGNORE INTO api_sources (id, name, base_url, format, field_mapping_json, enabled, is_builtin)
        VALUES (?, ?, ?, ?, ?, 1, 0)
      `).run(id, s.name, s.base_url, s.format, s.field_mapping_json ? JSON.stringify(s.field_mapping_json) : null);
      imported++;
    }
    res.json({ imported });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
