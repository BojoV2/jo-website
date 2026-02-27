import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';
import app from '../src/app.js';

describe('API smoke', () => {
  beforeAll(() => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  });

  it('GET /health returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('GET /api/generated-pdfs/export validates template_id before DB query', async () => {
    const token = jwt.sign({ id: 'u1', role: 'admin', email: 'a@a.com', name: 'A' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const res = await request(app)
      .get('/api/generated-pdfs/export')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('template_id');
  });
});