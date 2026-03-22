import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = express.Router();

// ── GET /api/qr-link — all published QR links (auth required) ─────
router.get('/', requireAuth, async (_req, res) => {
  try {
    const result = await query(
      `SELECT id, url, label, created_at
       FROM qr_links
       WHERE is_published = TRUE
       ORDER BY created_at ASC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/qr-link/all — admin: all QR links ────────────────────
router.get('/all', requireAuth, requireRole('admin', 'super_admin'), async (_req, res) => {
  try {
    const result = await query(
      `SELECT id, url, label, is_published, created_at, updated_at
       FROM qr_links
       ORDER BY created_at ASC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/qr-link — admin: add & publish a new QR link ────────
router.post('/', requireAuth, requireRole('admin', 'super_admin'), async (req, res) => {
  const { url, label } = req.body;
  if (!url || !url.trim()) return res.status(400).json({ error: 'URL is required' });

  try {
    const id = uuidv4();
    await query(
      `INSERT INTO qr_links (id, url, label, is_published, created_by)
       VALUES ($1, $2, $3, TRUE, $4)`,
      [id, url.trim(), label?.trim() || null, req.user.id]
    );
    const result = await query(`SELECT * FROM qr_links WHERE id = $1`, [id]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/qr-link/:id — admin: delete a QR link ────────────
router.delete('/:id', requireAuth, requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const result = await query(
      `DELETE FROM qr_links WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'QR link not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
