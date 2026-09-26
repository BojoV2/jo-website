import jwt from 'jsonwebtoken';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import app from '../src/app.js';
import { query, pool } from '../src/db.js';
import { jobTypeFor, guessArea, snapshotFromForm, CLOSED_STATUSES as CLOSED_LIKE, reconcileJoStatuses } from '../src/services/feJobs.js';

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
  it('suggests people from the old Excel crews with their areas', async () => {
    const res = await api('get', '/people');
    expect(res.status).toBe(200);
    const names = res.body.people.map((p) => p.name);
    expect(names).toContain('JELO');
    expect(names).toContain('ROLANDO');
    expect(names.some((n) => n.includes(' - '))).toBe(false);
    const jelo = res.body.people.find((p) => p.name === 'JELO');
    expect(jelo.jobs).toBeGreaterThan(0);
    expect(jelo.topArea).toBeTruthy();
    expect(Object.values(jelo.areas).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(jelo.jobs); // visits with no area count only in jobs
  });

  it('seeds team areas and lets anyone set, change and clear them', async () => {
    const seeded = await query(`SELECT lower(name) AS name, area FROM fe_teams WHERE NOT legacy`);
    const byName = Object.fromEntries(seeded.rows.map((r) => [r.name, r.area]));
    expect(byName['team kawit']).toBe('KAWIT');
    expect(byName['team trece']).toBe('TRECE');
    const legacyWithArea = await query(`SELECT COUNT(*)::int AS n FROM fe_teams WHERE legacy AND area IS NOT NULL`);
    expect(legacyWithArea.rows[0].n).toBeGreaterThan(0);

    const name = `${teamName} Area`;
    let res = await api('post', '/teams').send({ name, area: 'kawit' });
    expect(res.status).toBe(201);
    const team = res.body.teams.find((t) => t.name === name);
    expect(team.area).toBe('KAWIT');
    res = await api('patch', `/teams/${team.id}`).send({ area: 'NOWHERE' });
    expect(res.status).toBe(400);
    res = await api('patch', `/teams/${team.id}`).send({ area: 'TRECE' });
    expect(res.body.teams.find((t) => t.id === team.id).area).toBe('TRECE');
    res = await api('patch', `/teams/${team.id}`).send({ area: null });
    expect(res.body.teams.find((t) => t.id === team.id).area).toBeNull();
    const log = await query(`SELECT action FROM fe_audit WHERE user_id = $1 AND entity_id = $2 ORDER BY id`, [userId, String(team.id)]);
    expect(log.rows.map((r) => r.action)).toEqual(['team_added', 'team_area_changed', 'team_area_changed']);

    res = await api('post', `/teams/${team.id}/members`).send({ name: 'ZZTESTPERSON' });
    expect(res.status).toBe(201);
    res = await api('get', '/people');
    expect(res.body.people.find((p) => p.name === 'ZZTESTPERSON')).toMatchObject({ jobs: 0, teams: [name] });
    await query('DELETE FROM fe_team_members WHERE team_id = $1', [team.id]);
    await query('DELETE FROM fe_teams WHERE id = $1', [team.id]);
  });
  it('takes the area from a team name and keeps report cards per day', async () => {
    const name = `${teamName} Kawit Crew`;
    let res = await api('post', '/teams').send({ name });
    expect(res.status).toBe(201);
    const team = res.body.teams.find((t) => t.name === name);
    expect(team.area).toBe('KAWIT');
    try {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
      res = await api('put', `/teams/${team.id}/materials/${today}`).send({ drop_core_m: '120.5', f_clamp: 4, house_clamp: '', sc_connector: 2, onu: 1 });
      expect(res.status).toBe(200);
      expect(res.body.card).toMatchObject({ work_date: today, drop_core_m: 120.5, f_clamp: 4, house_clamp: 0, onu: 1 });
      res = await api('put', `/teams/${team.id}/materials/${today}`).send({ drop_core_m: 100, f_clamp: 4, sc_connector: 2, onu: 1 });
      expect(res.body.card.drop_core_m).toBe(100);
      res = await api('get', `/teams/${team.id}/materials`);
      expect(res.body.cards).toHaveLength(1);
      res = await api('put', `/teams/${team.id}/materials/2999-01-01`).send({ onu: 1 });
      expect(res.status).toBe(400);
      res = await api('put', `/teams/${team.id}/materials/${today}`).send({ onu: -3 });
      expect(res.status).toBe(400);

      res = await api('get', '/reports?period=week');
      const mats = res.body.materials.find((m) => m.team === name);
      expect(mats).toMatchObject({ cards: 1, drop_core_m: 100, f_clamp: 4, onu: 1 });
      const perf = res.body.teams.find((t) => t.team === name);
      expect(perf).toMatchObject({ installed: 0, repaired: 0, area: 'KAWIT' });
      const legacy = await query('SELECT name FROM fe_teams WHERE legacy');
      const legacyNames = new Set(legacy.rows.map((r) => r.name));
      for (const t of res.body.teams) expect(legacyNames.has(t.team)).toBe(false);
      for (const m of res.body.materials) expect(legacyNames.has(m.team)).toBe(false);

      res = await api('get', '/today');
      expect(res.body.teams.find((t) => t.id === team.id)).toMatchObject({ card_in: true, area: 'KAWIT' });
      for (const t of res.body.teams) expect(legacyNames.has(t.name)).toBe(false);
      expect(res.body.materials.cards).toBeGreaterThanOrEqual(1);

      const log = await query(`SELECT action FROM fe_audit WHERE user_id = $1 AND entity_id = $2 ORDER BY id`, [userId, String(team.id)]);
      expect(log.rows.map((r) => r.action)).toEqual(['team_added', 'materials_saved', 'materials_corrected']);
      res = await api('delete', `/teams/${team.id}/materials/${today}`);
      expect(res.status).toBe(200);
    } finally {
      await query('DELETE FROM fe_team_materials WHERE team_id = $1', [team.id]);
      await query('DELETE FROM fe_teams WHERE id = $1', [team.id]);
    }
  });
  it('counts only jobs generated since the board fresh start', async () => {
    const start = (await query(`SELECT value::timestamp AS v FROM fe_settings WHERE key = 'board_start'`)).rows[0].v;
    expect(start).toBeTruthy();
    let res = await api('get', '/jobs?view=open');
    for (const j of res.body.jobs) expect(CLOSED_LIKE.includes(j.status)).toBe(false);
    const fresh = await query(
      `SELECT COUNT(*)::int AS n FROM fe_jobs WHERE NOT history_only AND created_at >= $1 AND NOT (status = ANY($2::text[]))`,
      [start, CLOSED_LIKE]
    );
    expect(res.body.counts.open).toBe(fresh.rows[0].n);
    expect(res.body.jobs.length).toBe(Math.min(fresh.rows[0].n, 300));
    expect(res.body.counts.backlog).toBeGreaterThan(0);
    expect(res.body.counts.board_start).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    res = await api('get', '/jobs?view=backlog&limit=1000');
    expect(res.body.jobs.length).toBe(Math.min(res.body.counts.backlog, 1000));
  });
  it('follows the JO: cancel closes the field job, un-cancel reopens it (single, bulk, safety net)', async () => {
    await query(`UPDATE users SET role = 'admin' WHERE id = $1`, [userId]);
    const admin = jwt.sign({ id: userId, tv: 0, role: 'admin', name: 'FE Test' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const jo = (method, path) => request(app)[method](`/api/generated-pdfs${path}`).set('Authorization', `Bearer ${admin}`);
    const pick = await query(
      `SELECT j.id AS job_id, j.status, j.reason, j.closed_at, g.id AS gid, g.status AS jo_status, g.status_note, g.reschedule_date, g.auto_closed
         FROM fe_jobs j JOIN generated_pdfs g ON g.id = j.generated_pdf_id
        WHERE NOT j.history_only AND g.status = 'pending' AND j.status = 'Pending' AND NOT j.jo_cancelled
        ORDER BY g.created_at DESC LIMIT 2`
    );
    expect(pick.rowCount).toBe(2);
    const [a, b] = pick.rows;
    const fe = async (id) => (await query('SELECT status, jo_cancelled, reason FROM fe_jobs WHERE id = $1', [id])).rows[0];
    try {
      let res = await jo('patch', `/${a.gid}/status`).send({ status: 'cancelled', note: 'test' });
      expect(res.status).toBe(200);
      expect(await fe(a.job_id)).toMatchObject({ status: 'Cancelled', jo_cancelled: true, reason: 'JO cancelled in the workflow' });
      res = await api('get', `/jobs/${a.job_id}`);
      expect(res.body.job).toMatchObject({ jo_status: 'cancelled', jo_cancelled: true });

      res = await jo('patch', `/${a.gid}/status`).send({ status: 'pending' });
      expect(await fe(a.job_id)).toMatchObject({ status: 'Pending', jo_cancelled: false });

      res = await jo('post', '/bulk-status').send({ ids: [a.gid, b.gid], status: 'cancelled' });
      expect(res.status).toBe(200);
      expect((await fe(a.job_id)).status).toBe('Cancelled');
      expect((await fe(b.job_id)).status).toBe('Cancelled');

      // A status change made behind the hook's back is caught by the safety net.
      await query(`UPDATE generated_pdfs SET status = 'pending' WHERE id = $1`, [b.gid]);
      expect(await reconcileJoStatuses()).toBeGreaterThanOrEqual(1);
      expect(await fe(b.job_id)).toMatchObject({ status: 'Pending', jo_cancelled: false });

      // Rescheduling or finishing the JO does not touch the field result.
      await jo('patch', `/${a.gid}/status`).send({ status: 'rescheduled', reschedule_date: '2026-12-01' });
      expect(await fe(a.job_id)).toMatchObject({ status: 'Pending', jo_cancelled: false });
      res = await api('get', `/jobs/${a.job_id}`);
      expect(res.body.job).toMatchObject({ jo_status: 'rescheduled', jo_reschedule_date: '2026-12-01' });
      await jo('patch', `/${a.gid}/status`).send({ status: 'done' });
      expect((await fe(a.job_id)).status).toBe('Pending');

      const log = await query(`SELECT action FROM fe_audit WHERE job_id = $1 AND action LIKE 'jo_%' ORDER BY id`, [a.job_id]);
      expect(log.rows.map((r) => r.action)).toEqual(['jo_cancelled', 'jo_reopened', 'jo_cancelled', 'jo_reopened']);

      // The JO list and Client Lookup carry the field status.
      res = await jo('get', `?keyword=${a.gid}`);
      expect(res.status).toBe(200);
      const row = res.body.find((r) => r.id === a.gid);
      expect(row).toHaveProperty('fe_status', 'Pending');
      expect(row).toHaveProperty('fe_team');
      const nameRow = await query(`SELECT customer_name FROM fe_jobs WHERE id = $1`, [a.job_id]);
      if (nameRow.rows[0].customer_name) {
        res = await request(app).get(`/api/clients/profile?name=${encodeURIComponent(nameRow.rows[0].customer_name)}`).set('Authorization', `Bearer ${admin}`);
        if (res.status === 200) expect(res.body.documents.some((d) => 'fe_status' in d)).toBe(true);
      }
    } finally {
      for (const r of [a, b]) {
        await query(
          `UPDATE generated_pdfs SET status = $2, status_note = $3, reschedule_date = $4, auto_closed = $5 WHERE id = $1`,
          [r.gid, r.jo_status, r.status_note, r.reschedule_date, r.auto_closed]
        );
        await query(`UPDATE fe_jobs SET status = $2, reason = $3, closed_at = $4, jo_cancelled = FALSE WHERE id = $1`, [r.job_id, r.status, r.reason, r.closed_at]);
        await query(`DELETE FROM status_history WHERE generated_pdf_id = $1 AND changed_by = $2`, [r.gid, userId]);
        await query(`DELETE FROM fe_audit WHERE job_id = $1 AND action LIKE 'jo_%'`, [r.job_id]);
      }
      await query(`UPDATE users SET role = 'user' WHERE id = $1`, [userId]);
    }
  });
  it('marks a job done with one click and undoes it', async () => {
    const pick = await query(
      `SELECT j.* FROM fe_jobs j
        WHERE NOT j.history_only AND j.status = 'Pending' AND j.job_type IN ('INSTALL', 'REPAIR') AND NOT j.jo_cancelled
        ORDER BY j.created_at DESC LIMIT 1`
    );
    const job = pick.rows[0];
    const expected = job.job_type === 'INSTALL' ? 'Installed' : 'Repaired';
    let visitId;
    try {
      let res = await api('post', `/jobs/${job.id}/done`).send({});
      expect(res.status).toBe(201);
      expect(res.body.status).toBe(expected);
      expect(res.body.job.status).toBe(expected);
      visitId = res.body.visitId;
      const v = (await query('SELECT * FROM fe_visits WHERE id = $1', [visitId])).rows[0];
      expect(v).toMatchObject({ status: expected, source: 'app', remarks: 'Marked done from the board' });
      const closed = (await query('SELECT closed_at FROM fe_jobs WHERE id = $1', [job.id])).rows[0];
      expect(closed.closed_at).not.toBeNull();

      res = await api('post', `/jobs/${job.id}/done`).send({});
      expect(res.status).toBe(409);

      res = await api('delete', `/visits/${visitId}`);
      expect(res.status).toBe(200);
      visitId = null;
      const back = (await query('SELECT status, closed_at FROM fe_jobs WHERE id = $1', [job.id])).rows[0];
      expect(back.status).toBe(job.status);

      const excel = await query(`SELECT id FROM fe_visits WHERE source = 'excel' LIMIT 1`);
      res = await api('delete', `/visits/${excel.rows[0].id}`);
      expect(res.status).toBe(409);

      const log = await query(`SELECT action FROM fe_audit WHERE job_id = $1 AND user_id = $2 ORDER BY id`, [job.id, userId]);
      expect(log.rows.map((r) => r.action)).toEqual(['marked_done', 'visit_removed']);
    } finally {
      if (visitId) await query('DELETE FROM fe_visits WHERE id = $1', [visitId]);
      await query(`UPDATE fe_jobs SET status = $2, reason = $3, closed_at = $4, team_id = $5 WHERE id = $1`, [job.id, job.status, job.reason, job.closed_at, job.team_id]);
    }
  });
  it('cancels and reschedules from the board, with undo', async () => {
    const opts = await query(`SELECT kind, value FROM fe_options WHERE (kind, value) IN (('repair_status', 'Cancelled'), ('pullout_status', 'Cancelled'), ('pullout_status', 'Reschedule'))`);
    expect(opts.rowCount).toBe(3);
    const pick = await query(
      `SELECT j.* FROM fe_jobs j WHERE NOT j.history_only AND j.status = 'Pending' AND j.job_type = 'REPAIR' AND NOT j.jo_cancelled
        ORDER BY j.created_at DESC LIMIT 1`
    );
    const job = pick.rows[0];
    const created = [];
    try {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
      let res = await api('post', `/jobs/${job.id}/reschedule`).send({});
      expect(res.status).toBe(400);
      res = await api('post', `/jobs/${job.id}/reschedule`).send({ reschedule_date: '2020-01-01' });
      expect(res.status).toBe(400);
      res = await api('post', `/jobs/${job.id}/reschedule`).send({ reschedule_date: '2999-12-31', reason: 'No Access' });
      expect(res.status).toBe(201);
      created.push(res.body.visitId);
      expect(res.body.job).toMatchObject({ status: 'Reschedule', reschedule_to: '2999-12-31', reason: 'No Access' });
      const open = await api('get', '/jobs?view=open&q=' + encodeURIComponent(job.customer_name || ''));
      if (job.customer_name && job.customer_name.length >= 2) expect(open.body.jobs.some((j) => j.id === job.id)).toBe(true);

      res = await api('post', `/jobs/${job.id}/cancel`).send({ reason: 'Customer Not Around' });
      expect(res.status).toBe(201);
      created.push(res.body.visitId);
      expect(res.body.job.status).toBe('Cancelled');
      res = await api('post', `/jobs/${job.id}/cancel`).send({});
      expect(res.status).toBe(409);

      res = await api('delete', `/visits/${created.pop()}`);
      expect(res.body.job.status).toBe('Reschedule');
      res = await api('delete', `/visits/${created.pop()}`);
      expect(res.body.job.status).toBe(job.status);

      const log = await query(`SELECT action FROM fe_audit WHERE job_id = $1 AND user_id = $2 ORDER BY id`, [job.id, userId]);
      expect(log.rows.map((r) => r.action)).toEqual(['marked_rescheduled', 'marked_cancelled', 'visit_removed', 'visit_removed']);
      expect(today).toMatch(/^\d{4}-/);
    } finally {
      for (const id of created) await query('DELETE FROM fe_visits WHERE id = $1', [id]);
      await query(`UPDATE fe_jobs SET status = $2, reason = $3, closed_at = $4, team_id = $5 WHERE id = $1`, [job.id, job.status, job.reason, job.closed_at, job.team_id]);
    }
  });
  it('Today counts only work entered after its fresh start', async () => {
    const start = (await query(`SELECT value FROM fe_settings WHERE key = 'today_start'`)).rows[0];
    expect(start).toBeTruthy();
    const old = await query(`SELECT value FROM fe_settings WHERE key = 'today_start'`);
    try {
      await query(`UPDATE fe_settings SET value = '2999-01-01T00:00:00' WHERE key = 'today_start'`);
      const res = await api('get', '/today');
      expect(res.body.counts).toMatchObject({ visits: 0, done: 0 });
      expect(res.body.pullout).toMatchObject({ retrieved: 0, visited: 0 });
      expect(res.body.materials.cards).toBe(0);
      for (const t of res.body.teams) expect(t).toMatchObject({ visits: 0, done: 0, card_in: false });
    } finally {
      await query(`UPDATE fe_settings SET value = $1 WHERE key = 'today_start'`, [old.rows[0].value]);
    }
  });
});
