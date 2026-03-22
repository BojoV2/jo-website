import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = express.Router();

// ── GET /api/qr-link — returns the published QR link (auth required) ──
router.get('/', requireAuth, async (_req, res) => {
  try {
    const result = await query(
      `SELECT id, url, label, is_published, created_at, updated_at
       FROM qr_links
       WHERE is_published = TRUE
       ORDER BY updated_at DESC
       LIMIT 1`
    );
    if (result.rows.length === 0) return res.json(null);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/qr-link/all — admin: see all (published or not) ─────
router.get('/all', requireAuth, requireRole('admin', 'super_admin'), async (_req, res) => {
  try {
    const result = await query(
      `SELECT id, url, label, is_published, created_at, updated_at
       FROM qr_links
       ORDER BY updated_at DESC
       LIMIT 1`
    );
    if (result.rows.length === 0) return res.json(null);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/qr-link — admin: save & publish a QR link ──────────
router.post('/', requireAuth, requireRole('admin', 'super_admin'), async (req, res) => {
  const { url, label } = req.body;
  if (!url || !url.trim()) return res.status(400).json({ error: 'URL is required' });

  try {
    // Unpublish all existing
    await query(`UPDATE qr_links SET is_published = FALSE, updated_at = NOW()`);

    // Check if any row exists to reuse
    const existing = await query(`SELECT id FROM qr_links LIMIT 1`);
    let id;
    if (existing.rows.length > 0) {
      id = existing.rows[0].id;
      await query(
        `UPDATE qr_links
         SET url = $1, label = $2, is_published = TRUE, created_by = $3, updated_at = NOW()
         WHERE id = $4`,
        [url.trim(), label?.trim() || null, req.user.id, id]
      );
    } else {
      id = uuidv4();
      await query(
        `INSERT INTO qr_links (id, url, label, is_published, created_by)
         VALUES ($1, $2, $3, TRUE, $4)`,
        [id, url.trim(), label?.trim() || null, req.user.id]
      );
    }

    const result = await query(`SELECT * FROM qr_links WHERE id = $1`, [id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/qr-link — admin: unpublish/remove the QR link ────
router.delete('/', requireAuth, requireRole('admin', 'super_admin'), async (_req, res) => {
  try {
    await query(`UPDATE qr_links SET is_published = FALSE, updated_at = NOW()`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
