import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { pool, query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = express.Router();

router.use(requireAuth, requireRole('super_admin', 'admin'));

router.post('/', async (req, res) => {
  try {
    const { name, email, password, role = 'user' } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, and password are required' });
    }

    if (!['super_admin', 'admin', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    if (role === 'super_admin' && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only super_admin can create super_admin users' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const existing = await query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.rowCount > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const id = uuidv4();
    const passwordHash = await bcrypt.hash(password, 10);

    await query(
      'INSERT INTO users (id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5)',
      [id, name, normalizedEmail, passwordHash, role]
    );

    return res.status(201).json({ id, name, email: normalizedEmail, role });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/', async (_req, res) => {
  try {
    const users = await query(
      `SELECT id, name, email, role, avatar_url, last_active_at, created_at
       FROM users
       ORDER BY created_at DESC`
    );
    return res.json(users.rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.patch('/:userId/password', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: 'password is required and must be at least 6 chars' });
    }

    const target = await query('SELECT id, role FROM users WHERE id = $1', [req.params.userId]);
    if (target.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (target.rows[0].role === 'super_admin' && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only super_admin can modify super_admin password' });
    }

    const hash = await bcrypt.hash(password, 10);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.params.userId]);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/:userId/password/reset', async (req, res) => {
  try {
    const target = await query('SELECT id, role FROM users WHERE id = $1', [req.params.userId]);
    if (target.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (target.rows[0].role === 'super_admin' && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only super_admin can reset super_admin password' });
    }

    const tempPassword = crypto.randomBytes(6).toString('base64url');
    const hash = await bcrypt.hash(tempPassword, 10);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.params.userId]);
    return res.json({ temp_password: tempPassword });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
// ── delete a user account ──────────────────────────────────────────
// Policy: the account row goes, the work stays. Every FK to users(id) is
// ON DELETE SET NULL except status_history.changed_by, which has no action
// and would block the delete, so it is nulled explicitly first.
async function loadDeletionTarget(userId) {
  const target = await query('SELECT id, name, email, role FROM users WHERE id = $1', [userId]);
  return target.rowCount === 0 ? null : target.rows[0];
}

async function countUserRecords(userId) {
  const counts = await query(
    `SELECT
       (SELECT COUNT(*) FROM generated_pdfs WHERE user_id = $1)            AS generated_pdfs,
       (SELECT COUNT(*) FROM tickets WHERE created_by = $1)                AS tickets,
       (SELECT COUNT(*) FROM ticket_messages WHERE author_id = $1)         AS ticket_messages,
       (SELECT COUNT(*) FROM generated_pdf_attachments WHERE uploaded_by = $1) AS attachments,
       (SELECT COUNT(*) FROM pdf_templates WHERE created_by = $1)          AS templates,
       (SELECT COUNT(*) FROM status_history WHERE changed_by = $1)         AS status_changes`,
    [userId]
  );
  const row = counts.rows[0];
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
}

function denyDeletion(req, target) {
  if (target.id === req.user.id) {
    return 'You cannot delete your own account';
  }
  if (['super_admin', 'admin'].includes(target.role) && req.user.role !== 'super_admin') {
    return 'Only super_admin can delete admin accounts';
  }
  return null;
}

router.get('/:userId/deletion-preview', async (req, res) => {
  try {
    const target = await loadDeletionTarget(req.params.userId);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }
    const blocked = denyDeletion(req, target);
    return res.json({
      user: target,
      records: await countUserRecords(target.id),
      can_delete: !blocked,
      blocked_reason: blocked || null
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete('/:userId', async (req, res) => {
  const client = await pool.connect();
  try {
    const target = await loadDeletionTarget(req.params.userId);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    const blocked = denyDeletion(req, target);
    if (blocked) {
      return res.status(403).json({ error: blocked });
    }

    if (target.role === 'super_admin') {
      const remaining = await query(
        "SELECT COUNT(*)::int AS count FROM users WHERE role = 'super_admin' AND id <> $1",
        [target.id]
      );
      if (remaining.rows[0].count === 0) {
        return res.status(409).json({ error: 'Cannot delete the last super_admin account' });
      }
    }

    const records = await countUserRecords(target.id);

    await client.query('BEGIN');
    // status_history.changed_by has no ON DELETE action - null it so the audit
    // rows survive the delete instead of blocking it.
    await client.query('UPDATE status_history SET changed_by = NULL WHERE changed_by = $1', [target.id]);
    await client.query('DELETE FROM users WHERE id = $1', [target.id]);
    await client.query('COMMIT');

    return res.json({
      success: true,
      deleted: { id: target.id, name: target.name, email: target.email, role: target.role },
      unassigned_records: records
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_rollbackErr) {
      // connection already gone - nothing to roll back
    }
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

export default router;
