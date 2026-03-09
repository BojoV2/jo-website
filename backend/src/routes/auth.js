import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();
const allowedRoles = ['super_admin', 'admin', 'user'];

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    avatar_url: row.avatar_url || null,
    favorite_template_id: row.favorite_template_id || null,
    last_active_at: row.last_active_at || null
  };
}

router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, and password are required' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const requestedRole = role || 'user';

    if (!allowedRoles.includes(requestedRole)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    if (requestedRole !== 'user') {
      return res.status(403).json({ error: 'Only user registration is public' });
    }

    const existing = await query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.rowCount > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const id = uuidv4();

    await query(
      'INSERT INTO users (id, name, email, password_hash, role, last_active_at) VALUES ($1, $2, $3, $4, $5, NOW())',
      [id, name, normalizedEmail, passwordHash, 'user']
    );

    return res.status(201).json({
      id,
      name,
      email: normalizedEmail,
      role: 'user',
      avatar_url: null,
      favorite_template_id: null,
      last_active_at: null
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, identifier, password, remember_me = false } = req.body;
    const loginValue = String(identifier || email || '').trim();

    if (!loginValue || !password) {
      return res.status(400).json({ error: 'identifier(email or name) and password are required' });
    }

    const normalizedLogin = loginValue.toLowerCase();
    let result = await query(
      'SELECT id, name, email, password_hash, role, avatar_url, favorite_template_id, last_active_at FROM users WHERE LOWER(email) = $1',
      [normalizedLogin]
    );

    if (result.rowCount === 0) {
      result = await query(
        'SELECT id, name, email, password_hash, role, avatar_url, favorite_template_id, last_active_at FROM users WHERE LOWER(name) = $1',
        [normalizedLogin]
      );
    }

    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (result.rowCount > 1) {
      return res.status(409).json({ error: 'Multiple users share this name. Please login using email.' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await query('UPDATE users SET last_active_at = NOW() WHERE id = $1', [user.id]);

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        name: user.name
      },
      process.env.JWT_SECRET,
      { expiresIn: remember_me ? '30d' : '12h' }
    );

    return res.json({
      token,
      user: mapUser(user)
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await query(
      'SELECT id, name, email, role, avatar_url, favorite_template_id, last_active_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.json({ user: mapUser(result.rows[0]) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.patch('/me', requireAuth, async (req, res) => {
  try {
    const updates = [];
    const params = [];

    if (req.body.name !== undefined) {
      const nextName = String(req.body.name || '').trim();
      if (!nextName) {
        return res.status(400).json({ error: 'name cannot be empty' });
      }
      params.push(nextName);
      updates.push(`name = $${params.length}`);
    }

    if (req.body.email !== undefined) {
      const nextEmail = String(req.body.email || '').toLowerCase().trim();
      if (!nextEmail) {
        return res.status(400).json({ error: 'email cannot be empty' });
      }

      const existing = await query('SELECT id FROM users WHERE email = $1 AND id <> $2', [nextEmail, req.user.id]);
      if (existing.rowCount > 0) {
        return res.status(409).json({ error: 'Email already registered' });
      }

      params.push(nextEmail);
      updates.push(`email = $${params.length}`);
    }

    if (req.body.avatar_url !== undefined) {
      const nextAvatar = String(req.body.avatar_url || '').trim();
      params.push(nextAvatar || null);
      updates.push(`avatar_url = $${params.length}`);
    }

    if (req.body.favorite_template_id !== undefined) {
      const nextFavorite = String(req.body.favorite_template_id || '').trim();
      if (nextFavorite) {
        const template = await query('SELECT id FROM pdf_templates WHERE id = $1', [nextFavorite]);
        if (template.rowCount === 0) {
          return res.status(404).json({ error: 'Favorite template not found' });
        }
        params.push(nextFavorite);
      } else {
        params.push(null);
      }
      updates.push(`favorite_template_id = $${params.length}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No profile fields to update' });
    }

    params.push(req.user.id);
    const result = await query(
      `UPDATE users
       SET ${updates.join(', ')}
       WHERE id = $${params.length}
       RETURNING id, name, email, role, avatar_url, favorite_template_id, last_active_at`,
      params
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({ user: mapUser(result.rows[0]) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.patch('/me/password', requireAuth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'current_password and new_password are required' });
    }
    if (String(new_password).length < 6) {
      return res.status(400).json({ error: 'new_password must be at least 6 characters' });
    }

    const current = await query('SELECT id, password_hash FROM users WHERE id = $1', [req.user.id]);
    if (current.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const valid = await bcrypt.compare(String(current_password), current.rows[0].password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(String(new_password), 10);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/active-users', requireAuth, async (_req, res) => {
  try {
    const result = await query(
      `SELECT id, name, email, role, avatar_url, last_active_at
       FROM users
       WHERE last_active_at IS NOT NULL
         AND last_active_at >= NOW() - INTERVAL '15 minutes'
       ORDER BY last_active_at DESC, name ASC`
    );
    return res.json(result.rows.map(mapUser));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
