import jwt from 'jsonwebtoken';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import app from '../src/app.js';
import { query, pool } from '../src/db.js';

describe('API smoke', () => {
  const testUserId = randomUUID();

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    // requireAuth checks token_version against a real row (session
    // revocation support added in the 2026-08-16 hardening pass) - a
    // signed token for a user id that doesn't exist now correctly 401s
    // instead of reaching route validation, so this needs a real
    // throwaway row rather than a bare JWT claims object.
    await query(
      `INSERT INTO users (id, name, email, password_hash, role, token_version)
       VALUES ($1, 'API Smoke Test', $2, 'x', 'admin', 0)`,
      [testUserId, `api-smoke-${testUserId}@example.invalid`]
    );
  });

  afterAll(async () => {
    await query('DELETE FROM users WHERE id = $1', [testUserId]);
    await pool.end();
  });

  it('GET /health returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('GET /api/generated-pdfs/export validates template_id before DB query', async () => {
    const token = jwt.sign({ id: testUserId, tv: 0, role: 'admin', email: 'a@a.com', name: 'A' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const res = await request(app)
      .get('/api/generated-pdfs/export')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('template_id');
  });
});