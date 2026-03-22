import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = express.Router();

// Columns returned to admin — password is intentionally excluded
const ADMIN_SELECT = `id, name, base_url, username,
  CASE WHEN password IS NOT NULL AND password <> '' THEN true ELSE false END AS has_password,
  enabled, notes, created_by, created_at, updated_at`;

// ── Admin: list all tracker configs ──────────────────────────────
router.get('/admin', requireAuth, requireRole('super_admin', 'admin'), async (_req, res) => {
  try {
    const result = await query(
      `SELECT ${ADMIN_SELECT} FROM tracker_settings ORDER BY created_at ASC`
    );
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Admin: create tracker config ──────────────────────────────────
router.post('/', requireAuth, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { name, base_url, username, password, enabled, notes } = req.body;
    if (!name || !base_url) {
      return res.status(400).json({ error: 'name and base_url are required' });
    }
    const id = uuidv4();
    await query(
      `INSERT INTO tracker_settings (id, name, base_url, username, password, enabled, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, name.trim(), base_url.trim(), username?.trim() || null,
       password || null, enabled !== false, notes?.trim() || null, req.user.id]
    );
    const result = await query(
      `SELECT ${ADMIN_SELECT} FROM tracker_settings WHERE id = $1`, [id]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Admin: update tracker config ──────────────────────────────────
router.put('/:id', requireAuth, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { name, base_url, username, password, enabled, notes } = req.body;
    if (!name || !base_url) {
      return res.status(400).json({ error: 'name and base_url are required' });
    }

    // Build SET clause — only update password if a new one was provided
    const sets = [
      'name = $1', 'base_url = $2', 'username = $3',
      'enabled = $4', 'notes = $5', 'updated_at = NOW()'
    ];
    const params = [name.trim(), base_url.trim(), username?.trim() || null,
                    enabled !== false, notes?.trim() || null];

    if (password) {
      sets.splice(3, 0, 'password = $6');
      params.push(password);
      params.push(req.params.id);
    } else {
      params.push(req.params.id);
    }

    const idParam = `$${params.length}`;
    const result = await query(
      `UPDATE tracker_settings SET ${sets.join(', ')} WHERE id = ${idParam} RETURNING id`,
      params
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Tracker not found' });
    }
    const updated = await query(
      `SELECT ${ADMIN_SELECT} FROM tracker_settings WHERE id = $1`, [req.params.id]
    );
    return res.json(updated.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Admin: delete tracker config ──────────────────────────────────
router.delete('/:id', requireAuth, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM tracker_settings WHERE id = $1 RETURNING id', [req.params.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Tracker not found' });
    }
    return res.status(204).send();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── User: list enabled trackers (name + notes only, no credentials/URL) ──
router.get('/status', requireAuth, async (_req, res) => {
  try {
    const result = await query(
      `SELECT id, name, notes, enabled FROM tracker_settings WHERE enabled = true ORDER BY created_at ASC`
    );
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── User: secure launch — validate tracker is enabled, return URL ──
// The URL itself is not secret; credentials are never returned.
router.post('/:id/launch', requireAuth, async (req, res) => {
  try {
    const result = await query(
      'SELECT base_url, enabled FROM tracker_settings WHERE id = $1',
      [req.params.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Tracker not found' });
    }
    const { base_url, enabled } = result.rows[0];
    if (!enabled) {
      return res.status(403).json({ error: 'Tracker is currently disabled' });
    }
    return res.json({ url: base_url });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
