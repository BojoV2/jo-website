import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { query } from '../db.js';
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
    const users = await query('SELECT id, name, email, role, created_at FROM users ORDER BY created_at DESC');
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

export default router;
