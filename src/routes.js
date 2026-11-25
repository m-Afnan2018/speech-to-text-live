const express = require('express');
const { pool } = require('./db');

const router = express.Router();

function validate(body, partial = false) {
  const errors = [];
  const out = {};
  if (body.content !== undefined || !partial) {
    if (typeof body.content !== 'string' || !body.content.trim()) errors.push('content is required');
    else if (body.content.length > 100000) errors.push('content too long');
    else out.content = body.content.trim();
  }
  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.length > 200) errors.push('title must be a string up to 200 chars');
    else out.title = body.title.trim() || 'Untitled';
  }
  if (body.language !== undefined) {
    if (typeof body.language !== 'string' || body.language.length > 50) errors.push('invalid language');
    else out.language = body.language;
  }
  if (body.duration_ms !== undefined) {
    const d = Number(body.duration_ms);
    if (!Number.isInteger(d) || d < 0) errors.push('duration_ms must be a non-negative integer');
    else out.duration_ms = d;
  }
  return { errors, data: out };
}

const parseId = (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'invalid id' });
    return null;
  }
  return id;
};

// List (with optional search + pagination)
router.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q || '').toString().trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const params = [];
    let where = '';
    if (q) {
      params.push(`%${q}%`);
      where = `WHERE title ILIKE $1 OR content ILIKE $1`;
    }
    const total = await pool.query(`SELECT COUNT(*)::int AS n FROM transcriptions ${where}`, params);
    params.push(limit, offset);
    const rows = await pool.query(
      `SELECT * FROM transcriptions ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ total: total.rows[0].n, items: rows.rows });
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req, res); if (!id) return;
    const r = await pool.query('SELECT * FROM transcriptions WHERE id = $1', [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { errors, data } = validate(req.body || {});
    if (errors.length) return res.status(400).json({ error: errors.join(', ') });
    const r = await pool.query(
      `INSERT INTO transcriptions (title, content, language, duration_ms)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [data.title || 'Untitled', data.content, data.language || 'auto', data.duration_ms || 0]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const id = parseId(req, res); if (!id) return;
    const { errors, data } = validate(req.body || {}, true);
    if (errors.length) return res.status(400).json({ error: errors.join(', ') });
    const keys = Object.keys(data);
    if (!keys.length) return res.status(400).json({ error: 'nothing to update' });
    const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const r = await pool.query(
      `UPDATE transcriptions SET ${sets}, updated_at = NOW() WHERE id = $${keys.length + 1} RETURNING *`,
      [...keys.map((k) => data[k]), id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseId(req, res); if (!id) return;
    const r = await pool.query('DELETE FROM transcriptions WHERE id = $1', [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  } catch (e) { next(e); }
});

module.exports = router;
