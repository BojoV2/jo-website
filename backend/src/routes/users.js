import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { pool, query } from '../db.js';
import { requireAuth, requireRole, forgetTokenVersion } from '../middleware/auth.js';
import { logAccount, PERMISSION_KEYS } from '../services/accountAudit.js';
import { checkPasswordStrength } from './auth.js';

const router = express.Router();

// null = everything allowed; otherwise an object of known keys -> boolean
function parsePermissions(raw) {
  if (raw === null || raw === undefined) return { perms: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'section_permissions must be an object or null' };
  const invalid = Object.keys(raw).filter((k) => !PERMISSION_KEYS.includes(k));
  if (invalid.length > 0) return { error: `Unknown permission keys: ${invalid.join(', ')}` };
  const nonBool = Object.keys(raw).filter((k) => typeof raw[k] !== 'boolean');
  if (nonBool.length > 0) return { error: `Permission values must be true or false: ${nonBool.join(', ')}` };
  const off = Object.keys(raw).filter((k) => raw[k] === false);
  return { perms: off.length ? Object.fromEntries(off.map((k) => [k, false])) : null };
}

function describePermissions(perms) {
  if (!perms) return 'access=everything';
  return `blocked=${Object.keys(perms).join(',')}`;
}

// Admin accounts (and superadmins) can only be changed by a superadmin.
function guardTarget(req, target) {
  if (['super_admin', 'admin'].includes(target.role) && req.user.role !== 'super_admin') {
    return 'Only a superadmin can change an admin account';
  }
  return null;
}

async function otherActiveSuperadmins(userId) {
  const r = await query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'super_admin' AND id <> $1 AND disabled_at IS NULL", [userId]);
  return r.rows[0].count;
}

router.use(requireAuth, requireRole('super_admin', 'admin'));

router.post('/', async (req, res) => {
  try {
    const { name, email, password, role = 'user', section_permissions } = req.body;
    const parsed = parsePermissions(section_permissions);
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, and password are required' });
    }

    if (!['super_admin', 'admin', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const weakPassword = checkPasswordStrength(password);
    if (weakPassword) {
      return res.status(400).json({ error: weakPassword });
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

    const perms = role === 'user' ? parsed.perms : null;
    await query(
      'INSERT INTO users (id, name, email, password_hash, role, section_permissions) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, name, normalizedEmail, passwordHash, role, perms ? JSON.stringify(perms) : null]
    );
    await logAccount(req, { action: 'admin.user.create', targetName: name, detail: `role=${role} ${describePermissions(perms)}` });

    return res.status(201).json({ id, name, email: normalizedEmail, role, section_permissions: perms });
  } catch (err) {
    console.error(err); return res.status(500).json({ error: 'Something went wrong' });
  }
});

router.get('/', async (_req, res) => {
  try {
    const users = await query(
      `SELECT id, name, email, role, avatar_url, last_active_at, created_at, section_permissions, disabled_at
       FROM users
       ORDER BY created_at DESC`
    );
    return res.json(users.rows);
  } catch (err) {
    console.error(err); return res.status(500).json({ error: 'Something went wrong' });
  }
});

router.get('/audit', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 40, 1), 200);
    const rows = await query(
      `SELECT id, at, action, actor_name, target_name, detail, ip
       FROM account_audit ORDER BY at DESC, id DESC LIMIT $1`,
      [limit]
    );
    return res.json(rows.rows);
  } catch (err) {
    console.error(err); return res.status(500).json({ error: 'Something went wrong' });
  }
});

router.patch('/:userId/permissions', async (req, res) => {
  try {
    const target = await query('SELECT id, name, role FROM users WHERE id = $1', [req.params.userId]);
    if (target.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (target.rows[0].role !== 'user') {
      return res.status(400).json({ error: 'Section permissions only apply to user-role accounts' });
    }
    const parsed = parsePermissions(req.body.section_permissions);
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }
    const perms = parsed.perms;
    await query('UPDATE users SET section_permissions = $1 WHERE id = $2', [perms ? JSON.stringify(perms) : null, req.params.userId]);
    await logAccount(req, { action: 'admin.user.access', targetName: target.rows[0].name, detail: describePermissions(perms) });
    return res.json({ success: true, section_permissions: perms });
  } catch (err) {
    console.error(err); return res.status(500).json({ error: 'Something went wrong' });
  }
});

router.patch('/:userId/role', async (req, res) => {
  try {
    const { role } = req.body;
    if (!['super_admin', 'admin', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    if (req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only a superadmin can change roles' });
    }
    if (req.params.userId === req.user.id) {
      return res.status(400).json({ error: 'You cannot change your own role' });
    }
    const target = await query('SELECT id, name, role FROM users WHERE id = $1', [req.params.userId]);
    if (target.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const current = target.rows[0];
    if (current.role === role) {
      return res.json({ success: true, role });
    }
    if (current.role === 'super_admin' && (await otherActiveSuperadmins(current.id)) === 0) {
      return res.status(409).json({ error: 'Cannot demote the last active superadmin' });
    }
    // the role is inside every token, so the account signs in again to pick up the new one
    await query('UPDATE users SET role = $1, token_version = COALESCE(token_version, 0) + 1 WHERE id = $2', [role, current.id]);
    forgetTokenVersion(current.id);
    await logAccount(req, { action: 'admin.user.role', targetName: current.name, detail: `${current.role} -> ${role}` });
    return res.json({ success: true, role, sessions_ended: true });
  } catch (err) {
    console.error(err); return res.status(500).json({ error: 'Something went wrong' });
  }
});

router.patch('/:userId/status', async (req, res) => {
  try {
    const disable = Boolean(req.body.disabled);
    if (req.params.userId === req.user.id) {
      return res.status(400).json({ error: 'You cannot disable your own account' });
    }
    const target = await query('SELECT id, name, role FROM users WHERE id = $1', [req.params.userId]);
    if (target.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const current = target.rows[0];
    const blocked = guardTarget(req, current);
    if (blocked) {
      return res.status(403).json({ error: blocked });
    }
    if (disable && current.role === 'super_admin' && (await otherActiveSuperadmins(current.id)) === 0) {
      return res.status(409).json({ error: 'Cannot disable the last active superadmin' });
    }
    if (disable) {
      await query('UPDATE users SET disabled_at = NOW(), token_version = COALESCE(token_version, 0) + 1 WHERE id = $1', [current.id]);
    } else {
      await query('UPDATE users SET disabled_at = NULL WHERE id = $1', [current.id]);
    }
    forgetTokenVersion(current.id);
    await logAccount(req, { action: disable ? 'admin.user.disable' : 'admin.user.enable', targetName: current.name });
    return res.json({ success: true, disabled: disable });
  } catch (err) {
    console.error(err); return res.status(500).json({ error: 'Something went wrong' });
  }
});

router.patch('/:userId/password', async (req, res) => {
  try {
    const { password } = req.body;
    const weakPassword = checkPasswordStrength(password);
    if (weakPassword) {
      return res.status(400).json({ error: weakPassword });
    }

    const target = await query('SELECT id, name, role FROM users WHERE id = $1', [req.params.userId]);
    if (target.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (target.rows[0].role === 'super_admin' && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only super_admin can modify super_admin password' });
    }

    const hash = await bcrypt.hash(password, 10);
    await query(
      'UPDATE users SET password_hash = $1, token_version = COALESCE(token_version, 0) + 1 WHERE id = $2',
      [hash, req.params.userId]
    );
    forgetTokenVersion(req.params.userId);
    await logAccount(req, { action: 'admin.user.password', targetName: target.rows[0].name, detail: 'password set, sessions ended' });
    return res.json({ success: true, sessions_ended: true });
  } catch (err) {
    console.error(err); return res.status(500).json({ error: 'Something went wrong' });
  }
});

router.post('/:userId/password/reset', async (req, res) => {
  try {
    const target = await query('SELECT id, name, role FROM users WHERE id = $1', [req.params.userId]);
    if (target.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (target.rows[0].role === 'super_admin' && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only super_admin can reset super_admin password' });
    }

    // long enough to satisfy the password rules the user will be held to
    const tempPassword = `${crypto.randomBytes(6).toString('base64url')}${crypto.randomInt(10, 99)}`;
    const hash = await bcrypt.hash(tempPassword, 10);
    await query(
      'UPDATE users SET password_hash = $1, token_version = COALESCE(token_version, 0) + 1 WHERE id = $2',
      [hash, req.params.userId]
    );
    forgetTokenVersion(req.params.userId);
    await logAccount(req, { action: 'admin.user.password_reset', targetName: target.rows[0].name, detail: 'temporary password issued, sessions ended' });
    return res.json({ temp_password: tempPassword, sessions_ended: true });
  } catch (err) {
    console.error(err); return res.status(500).json({ error: 'Something went wrong' });
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
    console.error(err); return res.status(500).json({ error: 'Something went wrong' });
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
    forgetTokenVersion(target.id);
    await logAccount(req, { action: 'admin.user.delete', targetName: target.name, detail: `role=${target.role}` });

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
    console.error(err); return res.status(500).json({ error: 'Something went wrong' });
  } finally {
    client.release();
  }
});

// POST /api/users/:userId/sign-out-everywhere - kill every token an account holds
router.post('/:userId/sign-out-everywhere', async (req, res) => {
  try {
    const target = await query('SELECT id, name, role FROM users WHERE id = $1', [req.params.userId]);
    if (target.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (target.rows[0].role === 'super_admin' && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only super_admin can end super_admin sessions' });
    }
    await query('UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = $1', [req.params.userId]);
    forgetTokenVersion(req.params.userId);
    await logAccount(req, { action: 'admin.user.signout', targetName: target.rows[0].name });
    return res.json({ success: true, user: target.rows[0].name });
  } catch (err) {
    console.error(err); return res.status(500).json({ error: 'Something went wrong' });
  }
});

export default router;
