import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, and password are required' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const requestedRole = role || 'user';

    if (!['super_admin', 'admin', 'user'].includes(requestedRole)) {
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
      'INSERT INTO users (id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5)',
      [id, name, normalizedEmail, passwordHash, 'user']
    );

    return res.status(201).json({ id, name, email: normalizedEmail, role: 'user' });
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
      'SELECT id, name, email, password_hash, role FROM users WHERE LOWER(email) = $1',
      [normalizedLogin]
    );

    if (result.rowCount === 0) {
      result = await query(
        'SELECT id, name, email, password_hash, role FROM users WHERE LOWER(name) = $1',
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
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  return res.json({ user: req.user });
});

export default router;
