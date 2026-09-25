import jwt from 'jsonwebtoken';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import app from '../src/app.js';
import { query, pool } from '../src/db.js';
import { jobTypeFor, guessArea, snapshotFromForm } from '../src/services/feJobs.js';

describe('feJobs mapping', () => {
  it('maps templates to job types', () => {
    expect(jobTypeFor('Agent Application Form', {})).toBe('INSTALL');
    expect(jobTypeFor('Application Form MAIN', {})).toBe('INSTALL');
    expect(jobTypeFor('Job order ', { Reason: 'LOS' })).toBe('REPAIR');
    expect(jobTypeFor('Job order', { Reason: 'Pull out modem' })).toBe('PULLOUT');
    expect(jobTypeFor('Job order for Kawit', { Reason: 'pull-out' })).toBe('PULLOUT');
    expect(jobTypeFor('Relocation ', {})).toBe('RELOC');
    expect(jobTypeFor('Activation Receipt', {})).toBeNull();
  });

  it('guesses the area from template and address', () => {
    expect(guessArea('Job order for Kawit', 'anywhere')).toBe('KAWIT');
    expect(guessArea('Job order', '188 Julugan 3 Tanza')).toBe('TANZA');
    expect(guessArea('Job order', 'Brgy. Lumbreras, Naic')).toBe('NAIC');
    expect(guessArea('Job order', 'Somewhere')).toBeNull();
  });

  it('snapshots the customer from the form', () => {
    const s = snapshotFromForm('Relocation', { Name: '  Ana  Cruz ', 'Relocation Address': 'Bunga, Tanza', 'Account number': '16552234' }, null);
    expect(s.customer_name).toBe('Ana Cruz');
    expect(s.customer_address).toBe('Bunga, Tanza');
    expect(s.account_number).toBe('16552234');
    expect(s.area).toBe('TANZA');
  });
});

describe('Field Eng API', { timeout: 30000 }, () => {
  const userId = randomUUID();
  const teamName = `ZZ Test Team ${userId.slice(0, 8)}`;
  let token;
  let job;
  let jobBefore;
  let teamId;
  let sortBefore = [];

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    await query(
      `INSERT INTO users (id, name, email, password_hash, role, token_version) VALUES ($1, 'FE Test', $2, 'x', 'user', 0)`,
      [userId, `fe-test-${userId}@example.invalid`]
    );
    token = jwt.sign({ id: userId, tv: 0, role: 'user', name: 'FE Test' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const r = await query(`SELECT * FROM fe_jobs WHERE NOT history_only AND job_type = 'REPAIR' ORDER BY created_at DESC LIMIT 1`);
    jobBefore = r.rows[0];
  });

  afterAll(async () => {
    if (jobBefore) {
      await query('DELETE FROM fe_visits WHERE job_id = $1 AND created_by = $2', [jobBefore.id, userId]);
      await query(
        `UPDATE fe_jobs SET status = $2, reason = $3, team_id = $4, area = $5, closed_at = $6 WHERE id = $1`,
        [jobBefore.id, jobBefore.status, jobBefore.reason, jobBefore.team_id, jobBefore.area, jobBefore.closed_at]
      );
    }
    await query(`DELETE FROM fe_options WHERE value LIKE 'ZZ Test %'`);
    for (const [id, sort] of sortBefore) await query('UPDATE fe_options SET sort = $2 WHERE id = $1', [id, sort]);
    await query('DELETE FROM fe_audit WHERE user_id = $1', [userId]);
    if (teamId) {
      await query('DELETE FROM fe_team_members WHERE team_id = $1', [teamId]);
      await query('DELETE FROM fe_teams WHERE id = $1', [teamId]);
    }
    await query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.end();
  });

  const api = (method, path) => request(app)[method](`/api/field-eng${path}`).set('Authorization', `Bearer ${token}`);

  it('rejects anonymous requests', async () => {
    const res = await request(app).get('/api/field-eng/meta');
    expect(res.status).toBe(401);
  });

  it('returns lists and teams', async () => {
    const res = await api('get', '/meta');
    expect(res.status).toBe(200);
    expect(res.body.lists.install_status).toContain('Installed');
    expect(res.body.lists.area).toContain('TANZA');
  });

  it('adds a team, blocks duplicates, renames, manages members, retires', async () => {
    let res = await api('post', '/teams').send({ name: teamName });
    expect(res.status).toBe(201);
    teamId = res.body.teams.find((t) => t.name === teamName).id;
    res = await api('post', '/teams').send({ name: teamName.toUpperCase() });
    expect(res.status).toBe(409);
    res = await api('patch', `/teams/${teamId}`).send({ name: `${teamName} B` });
    expect(res.status).toBe(200);
    res = await api('post', `/teams/${teamId}/members`).send({ name: 'Jelo' });
    expect(res.status).toBe(201);
    const member = res.body.teams.find((t) => t.id === teamId).members[0];
    res = await api('post', `/teams/${teamId}/members`).send({ name: 'jelo' });
    expect(res.status).toBe(409);
    res = await api('delete', `/teams/${teamId}/members/${member.id}`);
    expect(res.status).toBe(200);
    expect(res.body.teams.find((t) => t.id === teamId).members).toHaveLength(0);
    const kept = await query('SELECT active FROM fe_team_members WHERE id = $1', [member.id]);
    expect(kept.rows[0].active).toBe(false);
    res = await api('patch', `/teams/${teamId}`).send({ active: false });
    expect(res.body.teams.find((t) => t.id === teamId).active).toBe(false);
    await api('patch', `/teams/${teamId}`).send({ active: true });
  });

  it('lists open jobs with counts', async () => {
    const res = await api('get', '/jobs?view=open');
    expect(res.status).toBe(200);
    expect(res.body.counts).toHaveProperty('open');
    for (const j of res.body.jobs) expect(j.history_only).toBe(false);
  });

  it('assigns a team and records a visit that updates the job', async () => {
    expect(jobBefore).toBeTruthy();
    let res = await api('patch', `/jobs/${jobBefore.id}`).send({ team_id: teamId });
    expect(res.status).toBe(200);
    expect(res.body.job.team_id).toBe(teamId);

    res = await api('post', `/jobs/${jobBefore.id}/visits`).send({ status: 'Not a status' });
    expect(res.status).toBe(400);

    res = await api('post', `/jobs/${jobBefore.id}/visits`).send({
      visit_date: '2099-01-01', team_id: teamId, status: 'Repaired', problem: 'LOS Red',
      start_time: '09:00', end_time: '09:40', sc_connector: 2
    });
    expect(res.status).toBe(201);
    expect(res.body.job.status).toBe('Repaired');
    const visit = res.body.visits.find((v) => v.visit_date === '2099-01-01');
    expect(visit.sc_connector).toBe(2);
    expect(visit.sla).toBeNull();

    res = await api('patch', `/visits/${visit.id}`).send({ status: 'Reschedule', reason: 'Customer Not Around' });
    expect(res.status).toBe(200);
    expect(res.body.job.status).toBe('Reschedule');
    expect(res.body.log.length).toBeGreaterThanOrEqual(3);
  });

  it('refuses to edit imported history jobs', async () => {
    const h = await query('SELECT id FROM fe_jobs WHERE history_only LIMIT 1');
    if (!h.rowCount) return;
    const res = await api('post', `/jobs/${h.rows[0].id}/visits`).send({ status: 'Installed' });
    expect(res.status).toBe(409);
  });

  it('serves reports and a CSV export', async () => {
    let res = await api('get', '/reports?period=month');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.teams)).toBe(true);
    res = await api('get', '/export?period=range&from=2026-08-01&to=2026-08-31');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text.split('\r\n')[0]).toContain('Subscriber Name');
  });
  it('shows only jobs generated today by default', async () => {
    const res = await api('get', '/jobs');
    expect(res.status).toBe(200);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
    for (const j of res.body.jobs) expect(j.jo_date).toBe(today);
    expect(res.body.counts.generated_today).toBe(res.body.jobs.length);
  });

  it('adds, renames, retires, restores and reorders list values', async () => {
    const before = await query(`SELECT id, sort FROM fe_options WHERE kind = 'problem'`);
    sortBefore = before.rows.map((r) => [r.id, r.sort]);
    const value = `ZZ Test ${userId.slice(0, 8)}`;
    let res = await api('post', '/options').send({ kind: 'problem', value });
    expect(res.status).toBe(201);
    expect(res.body.meta.lists.problem.at(-1)).toBe(value);
    const opt = res.body.options.find((o) => o.value === value);
    expect(opt).toMatchObject({ kind: 'problem', active: true, locked: false, uses: 0 });

    res = await api('post', '/options').send({ kind: 'problem', value: value.toLowerCase() });
    expect(res.status).toBe(409);
    res = await api('post', '/options').send({ kind: 'nope', value: 'x' });
    expect(res.status).toBe(400);

    res = await api('patch', `/options/${opt.id}`).send({ value: `${value} B` });
    expect(res.status).toBe(200);
    expect(res.body.meta.lists.problem).toContain(`${value} B`);

    res = await api('patch', `/options/${opt.id}`).send({ active: false });
    expect(res.body.meta.lists.problem).not.toContain(`${value} B`);
    res = await api('post', '/options').send({ kind: 'problem', value: `${value} b` });
    expect(res.status).toBe(200);
    expect(res.body.meta.lists.problem).toContain(`${value} B`);

    const ids = res.body.options.filter((o) => o.kind === 'problem').map((o) => o.id);
    const reversed = [...ids].reverse();
    res = await api('post', '/options/reorder').send({ kind: 'problem', ids: reversed });
    expect(res.status).toBe(200);
    expect(res.body.meta.lists.problem[0]).toBe(`${value} B`);
    res = await api('post', '/options/reorder').send({ kind: 'problem', ids: ids.slice(1) });
    expect(res.status).toBe(400);

    const log = await query(`SELECT action FROM fe_audit WHERE user_id = $1 AND entity = 'option' ORDER BY id`, [userId]);
    expect(log.rows.map((r) => r.action)).toEqual(['option_added', 'option_renamed', 'option_retired', 'option_restored', 'option_reordered']);
  });

  it('keeps built-in statuses and auto-detected areas from being renamed or retired', async () => {
    const { rows } = await query(`SELECT id, kind, value FROM fe_options WHERE (kind = 'install_status' AND value = 'Installed') OR (kind = 'area' AND value = 'TANZA')`);
    for (const o of rows) {
      let res = await api('patch', `/options/${o.id}`).send({ value: `${o.value}X` });
      expect(res.status).toBe(400);
      res = await api('patch', `/options/${o.id}`).send({ active: false });
      expect(res.status).toBe(400);
    }
    const res = await api('get', '/options');
    expect(res.body.options.find((o) => o.kind === 'install_status' && o.value === 'Installed')).toMatchObject({ locked: true, active: true });
  });

  it('moves jobs with a renamed area', async () => {
    const value = `ZZ Test Area ${userId.slice(0, 8)}`;
    let res = await api('post', '/options').send({ kind: 'area', value });
    const opt = res.body.options.find((o) => o.value === value);
    const job = (await query(`SELECT id, area FROM fe_jobs WHERE NOT history_only LIMIT 1`)).rows[0];
    await query('UPDATE fe_jobs SET area = $2 WHERE id = $1', [job.id, value]);
    res = await api('patch', `/options/${opt.id}`).send({ value: `${value} 2` });
    expect(res.status).toBe(200);
    const after = await query('SELECT area FROM fe_jobs WHERE id = $1', [job.id]);
    expect(after.rows[0].area).toBe(`${value} 2`);
    await query('UPDATE fe_jobs SET area = $2 WHERE id = $1', [job.id, job.area]);
  });
});
