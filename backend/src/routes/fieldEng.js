import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query, pool } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import {
  MANILA_DATE, MANILA_TODAY, CLOSED_STATUSES, SUCCESS_STATUSES, CORE_STATUSES, AUTO_AREAS,
  audit, refreshJobFromVisits, syncMissingJobsThrottled
} from '../services/feJobs.js';

const router = express.Router();
router.use(requireAuth);

// Everyone signed in can see and edit FE work (user decision 2026-09-25);
// every change is written to fe_audit instead of being permission-gated.

export const TARGETS = { installPerDay: 5, repairPerDay: 10, pulloutPerWeek: 70, hitRatio: 0.8 };
export const SLA_HOURS = { Easy: 1, Medium: 2, Hard: 3 };

const TYPES = ['INSTALL', 'REPAIR', 'PULLOUT', 'RELOC'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

const clean = (value, max = 255) => {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
};
const num = (value, { int = false } = {}) => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 100000) return undefined;
  return int ? Math.round(n) : Math.round(n * 100) / 100;
};
const effectiveType = (jobType, relocKind) => (jobType === 'RELOC' ? (relocKind === 'install' ? 'INSTALL' : 'REPAIR') : jobType);

// Per-visit SLA, same rule as the FEOMS sheet: only install-type visits that
// ended Installed are judged; missing times or difficulty is PENDING TIME.
export const SLA_SQL = `CASE
  WHEN (CASE WHEN j.job_type = 'RELOC' THEN (CASE WHEN j.reloc_kind = 'install' THEN 'INSTALL' ELSE 'REPAIR' END) ELSE j.job_type END) <> 'INSTALL' THEN NULL
  WHEN v.status <> 'Installed' THEN 'EXEMPTED'
  WHEN v.start_time IS NULL OR v.end_time IS NULL OR v.difficulty IS NULL THEN 'PENDING TIME'
  WHEN MOD(EXTRACT(EPOCH FROM (v.end_time - v.start_time))::numeric + 86400, 86400) / 3600
       <= (CASE v.difficulty WHEN 'Easy' THEN 1 WHEN 'Medium' THEN 2 WHEN 'Hard' THEN 3 ELSE 999 END) THEN 'PASS'
  ELSE 'DELAY' END`;

async function loadMeta() {
  const [teams, members, options] = await Promise.all([
    query('SELECT id, name, active, legacy FROM fe_teams ORDER BY legacy, active DESC, lower(name)'),
    query('SELECT id, team_id, name FROM fe_team_members WHERE active ORDER BY created_at, id'),
    query('SELECT kind, value FROM fe_options WHERE active ORDER BY kind, sort, value')
  ]);
  const lists = {};
  for (const row of options.rows) (lists[row.kind] ||= []).push(row.value);
  return {
    teams: teams.rows.map((t) => ({ ...t, members: members.rows.filter((m) => m.team_id === t.id) })),
    lists,
    targets: TARGETS,
    slaHours: SLA_HOURS
  };
}

router.get('/meta', async (_req, res) => {
  try {
    return res.json(await loadMeta());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------- jobs

const JOB_COLUMNS = `j.id, j.generated_pdf_id, j.job_type, j.reloc_kind, j.history_only, j.template_title, j.order_number,
  j.customer_name, j.customer_address, j.customer_contact, j.account_number, j.plan, j.jo_reason,
  to_char(j.jo_date, 'YYYY-MM-DD') AS jo_date, j.team_id, t.name AS team_name, j.area, j.status, j.reason,
  (${MANILA_TODAY} - j.jo_date) AS age_days,
  (SELECT to_char(MAX(v.visit_date), 'YYYY-MM-DD') FROM fe_visits v WHERE v.job_id = j.id) AS last_visit_date,
  (SELECT COUNT(*)::int FROM fe_visits v WHERE v.job_id = j.id) AS visit_count`;

router.get('/jobs', async (req, res) => {
  try {
    await syncMissingJobsThrottled().catch((err) => console.error(`FE sync failed: ${err.message}`));
    const view = String(req.query.view || 'today');
    const where = ['NOT j.history_only'];
    const params = [];
    const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };

    params.push(CLOSED_STATUSES);
    if (view === 'today') where.push(`$1::text[] IS NOT NULL AND j.jo_date = ${MANILA_TODAY}`);
    else if (view === 'open') where.push(`NOT (j.status = ANY($1::text[]))`);
    else if (view === 'closed_today') where.push(`j.status = ANY($1::text[]) AND ${MANILA_DATE('j.closed_at')} = ${MANILA_TODAY}`);
    else if (view === 'closed') where.push(`j.status = ANY($1::text[])`);
    else where.push('$1::text[] IS NOT NULL');

    if (TYPES.includes(req.query.type)) add('j.job_type = ?', req.query.type);
    if (req.query.area) add('j.area = ?', String(req.query.area));
    if (req.query.team === 'none') where.push('j.team_id IS NULL');
    else if (/^\d+$/.test(String(req.query.team || ''))) add('j.team_id = ?', Number(req.query.team));
    if (req.query.minAge && /^\d+$/.test(String(req.query.minAge))) add(`(${MANILA_TODAY} - j.jo_date) >= ?`, Number(req.query.minAge));
    const q = String(req.query.q || '').trim();
    if (q.length >= 2) {
      const pattern = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
      add(`(j.customer_name ILIKE ? OR j.order_number ILIKE $${params.length + 1} OR j.account_number ILIKE $${params.length + 1} OR j.customer_address ILIKE $${params.length + 1})`, pattern);
    }
    const limit = Math.min(Number(req.query.limit) || 300, 1000);

    const [rows, counts] = await Promise.all([
      query(
        `SELECT ${JOB_COLUMNS} FROM fe_jobs j LEFT JOIN fe_teams t ON t.id = j.team_id
          WHERE ${where.join(' AND ')}
          ORDER BY j.jo_date ASC NULLS LAST, j.created_at ASC
          LIMIT ${limit}`,
        params
      ),
      query(
        `SELECT COUNT(*) FILTER (WHERE NOT (status = ANY($1::text[])))::int AS open,
                COUNT(*) FILTER (WHERE NOT (status = ANY($1::text[])) AND team_id IS NULL)::int AS unassigned,
                COUNT(*) FILTER (WHERE NOT (status = ANY($1::text[])) AND (${MANILA_TODAY} - jo_date) >= 3)::int AS overdue,
                COUNT(*) FILTER (WHERE status = ANY($1::text[]) AND ${MANILA_DATE('closed_at')} = ${MANILA_TODAY})::int AS closed_today,
                COUNT(*) FILTER (WHERE jo_date = ${MANILA_TODAY})::int AS generated_today
           FROM fe_jobs WHERE NOT history_only`,
        [CLOSED_STATUSES]
      )
    ]);
    return res.json({ jobs: rows.rows, counts: counts.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

async function jobDetail(id) {
  const job = await query(`SELECT ${JOB_COLUMNS} FROM fe_jobs j LEFT JOIN fe_teams t ON t.id = j.team_id WHERE j.id = $1`, [id]);
  if (!job.rowCount) return null;
  const [visits, log] = await Promise.all([
    query(
      `SELECT v.id, to_char(v.visit_date, 'YYYY-MM-DD') AS visit_date, v.team_id, t.name AS team_name, v.status, v.reason,
              v.problem, v.difficulty, to_char(v.start_time, 'HH24:MI') AS start_time, to_char(v.end_time, 'HH24:MI') AS end_time,
              v.drop_core_m::float AS drop_core_m, v.f_clamp, v.house_clamp, v.sc_connector, v.onu, v.modem_serial, v.remarks,
              v.source, ${SLA_SQL} AS sla
         FROM fe_visits v JOIN fe_jobs j ON j.id = v.job_id LEFT JOIN fe_teams t ON t.id = v.team_id
        WHERE v.job_id = $1
        ORDER BY v.visit_date DESC NULLS LAST, v.created_at DESC`,
      [id]
    ),
    query(
      `SELECT action, detail, user_name, to_char(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD HH24:MI') AS at
         FROM fe_audit WHERE job_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100`,
      [id]
    )
  ]);
  return { job: job.rows[0], visits: visits.rows, log: log.rows };
}

router.get('/jobs/:id', async (req, res) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Invalid job id' });
    const detail = await jobDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: 'Job not found' });
    return res.json(detail);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

async function teamExists(teamId) {
  if (teamId === null) return true;
  const r = await query('SELECT 1 FROM fe_teams WHERE id = $1', [teamId]);
  return r.rowCount > 0;
}

// Assignment edits: team, area, relocation kind.
router.patch('/jobs/:id', async (req, res) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Invalid job id' });
    const current = await query('SELECT * FROM fe_jobs WHERE id = $1', [req.params.id]);
    if (!current.rowCount) return res.status(404).json({ error: 'Job not found' });
    const job = current.rows[0];
    if (job.history_only) return res.status(409).json({ error: 'Imported history cannot be edited from the board' });

    const changes = {};
    if ('team_id' in req.body) {
      const teamId = req.body.team_id === null || req.body.team_id === '' ? null : Number(req.body.team_id);
      if (teamId !== null && !Number.isInteger(teamId)) return res.status(400).json({ error: 'Invalid team' });
      if (!(await teamExists(teamId))) return res.status(400).json({ error: 'That team does not exist' });
      changes.team_id = teamId;
    }
    if ('area' in req.body) changes.area = clean(req.body.area, 60);
    if ('reloc_kind' in req.body) {
      if (job.job_type !== 'RELOC') return res.status(400).json({ error: 'Only relocation jobs have a kind' });
      if (!['install', 'repair'].includes(req.body.reloc_kind)) return res.status(400).json({ error: 'Kind must be install or repair' });
      changes.reloc_kind = req.body.reloc_kind;
    }
    const keys = Object.keys(changes);
    if (!keys.length) return res.status(400).json({ error: 'Nothing to change' });

    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    await query(
      `UPDATE fe_jobs SET ${sets.join(', ')}, updated_at = NOW(), updated_by = $${keys.length + 2} WHERE id = $1`,
      [job.id, ...keys.map((k) => changes[k]), req.user.id]
    );
    const before = Object.fromEntries(keys.map((k) => [k, job[k]]));
    await audit({ entity: 'job', entityId: job.id, jobId: job.id, action: 'job_updated', detail: { before, after: changes }, user: req.user });
    return res.json(await jobDetail(job.id));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------- visits

async function validateVisit(body, job) {
  const type = effectiveType(job.job_type, body.reloc_kind || job.reloc_kind);
  const meta = await loadMeta();
  const statusList = meta.lists[type === 'INSTALL' ? 'install_status' : type === 'PULLOUT' ? 'pullout_status' : 'repair_status'] || [];
  const status = clean(body.status, 40);
  if (!status || !statusList.includes(status)) return { error: 'Pick a status from the list' };
  const visitDate = body.visit_date ? String(body.visit_date) : null;
  if (visitDate && !DATE_RE.test(visitDate)) return { error: 'Visit date must be YYYY-MM-DD' };
  for (const key of ['start_time', 'end_time']) {
    if (body[key] && !TIME_RE.test(String(body[key]))) return { error: 'Times must be HH:MM' };
  }
  const difficulty = body.difficulty ? String(body.difficulty) : null;
  if (difficulty && !SLA_HOURS[difficulty]) return { error: 'Difficulty must be Easy, Medium or Hard' };
  const teamId = body.team_id === undefined || body.team_id === null || body.team_id === '' ? null : Number(body.team_id);
  if (teamId !== null && (!Number.isInteger(teamId) || !(await teamExists(teamId)))) return { error: 'That team does not exist' };
  const materials = {
    drop_core_m: num(body.drop_core_m),
    f_clamp: num(body.f_clamp, { int: true }),
    house_clamp: num(body.house_clamp, { int: true }),
    sc_connector: num(body.sc_connector, { int: true }),
    onu: num(body.onu, { int: true })
  };
  if (Object.values(materials).some((v) => v === undefined)) return { error: 'Materials must be numbers between 0 and 100000' };
  return {
    value: {
      visit_date: visitDate,
      team_id: teamId,
      status,
      reason: clean(body.reason, 120),
      problem: type === 'REPAIR' ? clean(body.problem, 120) : null,
      difficulty: type === 'INSTALL' ? difficulty : null,
      start_time: type === 'PULLOUT' ? null : (body.start_time || null),
      end_time: type === 'PULLOUT' ? null : (body.end_time || null),
      ...(type === 'PULLOUT' ? { drop_core_m: null, f_clamp: null, house_clamp: null, sc_connector: null, onu: null } : materials),
      modem_serial: type === 'PULLOUT' ? clean(body.modem_serial, 80) : null,
      remarks: clean(body.remarks, 2000)
    }
  };
}

const VISIT_FIELDS = ['visit_date', 'team_id', 'status', 'reason', 'problem', 'difficulty', 'start_time', 'end_time',
  'drop_core_m', 'f_clamp', 'house_clamp', 'sc_connector', 'onu', 'modem_serial', 'remarks'];

router.post('/jobs/:id/visits', async (req, res) => {
  const client = await pool.connect();
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Invalid job id' });
    const found = await client.query('SELECT * FROM fe_jobs WHERE id = $1', [req.params.id]);
    if (!found.rowCount) return res.status(404).json({ error: 'Job not found' });
    const job = found.rows[0];
    if (job.history_only) return res.status(409).json({ error: 'Imported history cannot be edited from the board' });
    if (job.job_type === 'RELOC' && !['install', 'repair'].includes(req.body.reloc_kind || job.reloc_kind)) {
      return res.status(400).json({ error: 'Choose whether this relocation is install-type or repair-type' });
    }
    const checked = await validateVisit(req.body, job);
    if (checked.error) return res.status(400).json({ error: checked.error });
    const v = checked.value;
    const id = uuidv4();

    await client.query('BEGIN');
    if (job.job_type === 'RELOC' && req.body.reloc_kind && req.body.reloc_kind !== job.reloc_kind) {
      await client.query('UPDATE fe_jobs SET reloc_kind = $2 WHERE id = $1', [job.id, req.body.reloc_kind]);
    }
    if ('area' in req.body) {
      await client.query('UPDATE fe_jobs SET area = $2 WHERE id = $1', [job.id, clean(req.body.area, 60)]);
    }
    await client.query(
      `INSERT INTO fe_visits (id, job_id, ${VISIT_FIELDS.join(', ')}, source, created_by, updated_by)
       VALUES ($1, $2, COALESCE($3::date, ${MANILA_TODAY}), ${VISIT_FIELDS.slice(1).map((_, i) => `$${i + 4}`).join(', ')}, 'app', $18, $18)`,
      [id, job.id, ...VISIT_FIELDS.map((f) => v[f]), req.user.id]
    );
    await client.query('COMMIT');
    await refreshJobFromVisits(job.id, req.user.id);
    await audit({ entity: 'visit', entityId: id, jobId: job.id, action: 'visit_added', detail: v, user: req.user });
    return res.status(201).json(await jobDetail(job.id));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.patch('/visits/:id', async (req, res) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Invalid visit id' });
    const found = await query(
      `SELECT v.*, j.job_type, j.reloc_kind, j.history_only FROM fe_visits v JOIN fe_jobs j ON j.id = v.job_id WHERE v.id = $1`,
      [req.params.id]
    );
    if (!found.rowCount) return res.status(404).json({ error: 'Visit not found' });
    const visit = found.rows[0];
    if (visit.history_only) return res.status(409).json({ error: 'Imported history cannot be edited from the board' });
    const merged = { ...visit, ...req.body };
    for (const key of ['start_time', 'end_time']) {
      if (merged[key] && String(merged[key]).length > 5) merged[key] = String(merged[key]).slice(0, 5);
    }
    if (merged.visit_date instanceof Date) merged.visit_date = merged.visit_date.toISOString().slice(0, 10);
    const checked = await validateVisit(merged, { job_type: visit.job_type, reloc_kind: visit.reloc_kind });
    if (checked.error) return res.status(400).json({ error: checked.error });
    const v = checked.value;
    await query(
      `UPDATE fe_visits SET ${VISIT_FIELDS.map((f, i) => `${f} = ${f === 'visit_date' ? `COALESCE($${i + 2}::date, visit_date)` : `$${i + 2}`}`).join(', ')},
              updated_by = $${VISIT_FIELDS.length + 2}, updated_at = NOW()
        WHERE id = $1`,
      [visit.id, ...VISIT_FIELDS.map((f) => v[f]), req.user.id]
    );
    const before = Object.fromEntries(VISIT_FIELDS.map((f) => [f, visit[f]]));
    await refreshJobFromVisits(visit.job_id, req.user.id);
    await audit({ entity: 'visit', entityId: visit.id, jobId: visit.job_id, action: 'visit_edited', detail: { before, after: v }, user: req.user });
    return res.json(await jobDetail(visit.job_id));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------- teams

router.post('/teams', async (req, res) => {
  try {
    const name = clean(req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'Team name is required' });
    const exists = await query('SELECT 1 FROM fe_teams WHERE lower(name) = lower($1)', [name]);
    if (exists.rowCount) return res.status(409).json({ error: `A team called ${name} already exists` });
    const created = await query('INSERT INTO fe_teams (name) VALUES ($1) RETURNING id', [name]);
    await audit({ entity: 'team', entityId: created.rows[0].id, action: 'team_added', detail: { name }, user: req.user });
    return res.status(201).json(await loadMeta());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.patch('/teams/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid team id' });
    const found = await query('SELECT * FROM fe_teams WHERE id = $1', [id]);
    if (!found.rowCount) return res.status(404).json({ error: 'Team not found' });
    const team = found.rows[0];
    if ('name' in req.body) {
      const name = clean(req.body.name, 120);
      if (!name) return res.status(400).json({ error: 'Team name is required' });
      const clash = await query('SELECT 1 FROM fe_teams WHERE lower(name) = lower($1) AND id <> $2', [name, id]);
      if (clash.rowCount) return res.status(409).json({ error: `A team called ${name} already exists` });
      await query('UPDATE fe_teams SET name = $2, updated_at = NOW() WHERE id = $1', [id, name]);
      await audit({ entity: 'team', entityId: id, action: 'team_renamed', detail: { from: team.name, to: name }, user: req.user });
    }
    if ('active' in req.body) {
      const active = Boolean(req.body.active);
      await query('UPDATE fe_teams SET active = $2, updated_at = NOW() WHERE id = $1', [id, active]);
      await audit({ entity: 'team', entityId: id, action: active ? 'team_reactivated' : 'team_retired', detail: { name: team.name }, user: req.user });
    }
    return res.json(await loadMeta());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/teams/:id/members', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const name = clean(req.body.name, 120);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid team id' });
    if (!name) return res.status(400).json({ error: 'Member name is required' });
    const team = await query('SELECT name FROM fe_teams WHERE id = $1', [id]);
    if (!team.rowCount) return res.status(404).json({ error: 'Team not found' });
    const dup = await query('SELECT 1 FROM fe_team_members WHERE team_id = $1 AND active AND lower(name) = lower($2)', [id, name]);
    if (dup.rowCount) return res.status(409).json({ error: `${name} is already in ${team.rows[0].name}` });
    const created = await query('INSERT INTO fe_team_members (team_id, name) VALUES ($1, $2) RETURNING id', [id, name]);
    await audit({ entity: 'team', entityId: id, action: 'member_added', detail: { member: name, memberId: created.rows[0].id }, user: req.user });
    return res.status(201).json(await loadMeta());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Removing a member only hides them; the row stays for the audit trail.
router.delete('/teams/:id/members/:memberId', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const memberId = Number(req.params.memberId);
    if (!Number.isInteger(id) || !Number.isInteger(memberId)) return res.status(400).json({ error: 'Invalid id' });
    const found = await query('UPDATE fe_team_members SET active = FALSE WHERE id = $1 AND team_id = $2 AND active RETURNING name', [memberId, id]);
    if (!found.rowCount) return res.status(404).json({ error: 'Member not found' });
    await audit({ entity: 'team', entityId: id, action: 'member_removed', detail: { member: found.rows[0].name, memberId }, user: req.user });
    return res.json(await loadMeta());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------- dropdown lists

export const OPTION_KINDS = [
  'area', 'install_status', 'repair_status', 'pullout_status',
  'install_reason', 'repair_reason', 'pullout_reason', 'problem'
];

// Where each kind's value is stored, for the "used N times" count.
const OPTION_USE_COLUMN = (kind) => (kind === 'area' ? ['fe_jobs', 'area']
  : kind.endsWith('_status') ? ['fe_visits', 'status']
    : kind.endsWith('_reason') ? ['fe_visits', 'reason'] : ['fe_visits', 'problem']);

export const optionLocked = (kind, value) => (kind === 'area' ? AUTO_AREAS.includes(value)
  : kind.endsWith('_status') ? CORE_STATUSES.includes(value) : false);

async function loadOptions() {
  const rows = (await query('SELECT id, kind, value, sort, active FROM fe_options ORDER BY kind, sort, value')).rows;
  const uses = {};
  for (const [table, column] of [['fe_jobs', 'area'], ['fe_visits', 'status'], ['fe_visits', 'reason'], ['fe_visits', 'problem']]) {
    const r = await query(`SELECT ${column} AS value, COUNT(*)::int AS n FROM ${table} WHERE ${column} IS NOT NULL GROUP BY 1`);
    uses[`${table}.${column}`] = Object.fromEntries(r.rows.map((x) => [x.value, x.n]));
  }
  return {
    kinds: OPTION_KINDS,
    options: rows.map((o) => ({
      ...o,
      locked: optionLocked(o.kind, o.value),
      uses: uses[OPTION_USE_COLUMN(o.kind).join('.')]?.[o.value] || 0
    }))
  };
}

const optionsPayload = async () => ({ ...(await loadOptions()), meta: await loadMeta() });

router.get('/options', async (_req, res) => {
  try {
    return res.json(await loadOptions());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Adding a value that exists but was retired brings the old one back.
router.post('/options', async (req, res) => {
  try {
    const kind = String(req.body.kind || '');
    const value = clean(req.body.value, 120);
    if (!OPTION_KINDS.includes(kind)) return res.status(400).json({ error: 'Unknown list' });
    if (!value) return res.status(400).json({ error: 'A value is required' });
    const found = await query('SELECT id, value, active FROM fe_options WHERE kind = $1 AND lower(value) = lower($2)', [kind, value]);
    if (found.rowCount && found.rows[0].active) return res.status(409).json({ error: `${found.rows[0].value} is already on this list` });
    if (found.rowCount) {
      const old = found.rows[0];
      await query('UPDATE fe_options SET active = TRUE WHERE id = $1', [old.id]);
      await audit({ entity: 'option', entityId: old.id, action: 'option_restored', detail: { kind, value: old.value }, user: req.user });
      return res.json(await optionsPayload());
    }
    const created = await query(
      `INSERT INTO fe_options (kind, value, sort)
       VALUES ($1::varchar, $2, (SELECT COALESCE(MAX(sort), 0) + 1 FROM fe_options WHERE kind = $1::varchar)) RETURNING id`,
      [kind, value]
    );
    await audit({ entity: 'option', entityId: created.rows[0].id, action: 'option_added', detail: { kind, value }, user: req.user });
    return res.status(201).json(await optionsPayload());
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Renaming changes the list only; past visits keep the text they were saved
// with. Areas are the exception: area is a property of the job, so jobs move
// with the rename (same as teams).
router.patch('/options/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const found = await client.query('SELECT * FROM fe_options WHERE id = $1', [id]);
    if (!found.rowCount) return res.status(404).json({ error: 'Value not found' });
    const opt = found.rows[0];
    const locked = optionLocked(opt.kind, opt.value);
    const value = 'value' in req.body ? clean(req.body.value, 120) : null;
    const renaming = 'value' in req.body && value !== opt.value;
    const retiring = 'active' in req.body && !req.body.active && opt.active;
    if ('value' in req.body && !value) return res.status(400).json({ error: 'A value is required' });
    if (locked && (renaming || retiring)) {
      return res.status(400).json({ error: `${opt.value} is used by the board's own rules, so it can be moved but not renamed or retired` });
    }
    if (renaming) {
      const clash = await client.query('SELECT 1 FROM fe_options WHERE kind = $1 AND lower(value) = lower($2) AND id <> $3', [opt.kind, value, id]);
      if (clash.rowCount) return res.status(409).json({ error: `${value} is already on this list` });
      if (optionLocked(opt.kind, value)) return res.status(400).json({ error: `${value} is a reserved name on this list` });
    }
    await client.query('BEGIN');
    if (renaming) {
      await client.query('UPDATE fe_options SET value = $2 WHERE id = $1', [id, value]);
      let moved = 0;
      if (opt.kind === 'area') moved = (await client.query('UPDATE fe_jobs SET area = $2, updated_at = NOW() WHERE area = $1', [opt.value, value])).rowCount;
      await client.query(
        `INSERT INTO fe_audit (entity, entity_id, action, detail, user_id, user_name) VALUES ('option', $1, 'option_renamed', $2, $3, $4)`,
        [String(id), JSON.stringify({ kind: opt.kind, from: opt.value, to: value, jobsMoved: moved }), req.user?.id || null, req.user?.name || null]
      );
    }
    if ('active' in req.body && Boolean(req.body.active) !== opt.active) {
      const active = Boolean(req.body.active);
      await client.query('UPDATE fe_options SET active = $2 WHERE id = $1', [id, active]);
      await client.query(
        `INSERT INTO fe_audit (entity, entity_id, action, detail, user_id, user_name) VALUES ('option', $1, $2, $3, $4, $5)`,
        [String(id), active ? 'option_restored' : 'option_retired', JSON.stringify({ kind: opt.kind, value: value || opt.value }), req.user?.id || null, req.user?.name || null]
      );
    }
    await client.query('COMMIT');
    return res.json(await optionsPayload());
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Body: { kind, ids } with every id of that list in the new order.
router.post('/options/reorder', async (req, res) => {
  const client = await pool.connect();
  try {
    const kind = String(req.body.kind || '');
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : [];
    if (!OPTION_KINDS.includes(kind)) return res.status(400).json({ error: 'Unknown list' });
    const current = (await client.query('SELECT id FROM fe_options WHERE kind = $1', [kind])).rows.map((r) => r.id);
    if (ids.length !== current.length || new Set(ids).size !== ids.length || !ids.every((i) => current.includes(i))) {
      return res.status(400).json({ error: 'The list changed while you were editing it. Reload and try again.' });
    }
    await client.query('BEGIN');
    for (const [i, id] of ids.entries()) await client.query('UPDATE fe_options SET sort = $2 WHERE id = $1', [id, i + 1]);
    await client.query(
      `INSERT INTO fe_audit (entity, entity_id, action, detail, user_id, user_name) VALUES ('option', $1, 'option_reordered', $2, $3, $4)`,
      [kind, JSON.stringify({ kind, ids }), req.user?.id || null, req.user?.name || null]
    );
    await client.query('COMMIT');
    return res.json(await optionsPayload());
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------- today + reports

const VISIT_BASE = `FROM fe_visits v JOIN fe_jobs j ON j.id = v.job_id LEFT JOIN fe_teams t ON t.id = v.team_id`;
const EFFECTIVE_TYPE = `(CASE WHEN j.job_type = 'RELOC' THEN (CASE WHEN j.reloc_kind = 'install' THEN 'INSTALL' ELSE 'REPAIR' END) ELSE j.job_type END)`;

router.get('/today', async (_req, res) => {
  try {
    const [teams, materials, sla, pullout, counts] = await Promise.all([
      query(
        `WITH open_jobs AS (
            SELECT team_id, COUNT(*)::int AS open FROM fe_jobs
             WHERE NOT history_only AND team_id IS NOT NULL AND NOT (status = ANY($1::text[])) GROUP BY team_id),
          today AS (
            SELECT v.team_id, COUNT(*)::int AS visits,
                   COUNT(*) FILTER (WHERE v.status = ANY($2::text[]))::int AS done,
                   COUNT(*) FILTER (WHERE ${SLA_SQL} = 'PASS')::int AS pass,
                   COUNT(*) FILTER (WHERE ${SLA_SQL} = 'DELAY')::int AS delay
              ${VISIT_BASE} WHERE v.visit_date = ${MANILA_TODAY} AND v.team_id IS NOT NULL GROUP BY v.team_id)
         SELECT t.id, t.name, COALESCE(o.open, 0) AS open, COALESCE(d.visits, 0) AS visits, COALESCE(d.done, 0) AS done,
                COALESCE(d.pass, 0) AS pass, COALESCE(d.delay, 0) AS delay
           FROM fe_teams t LEFT JOIN open_jobs o ON o.team_id = t.id LEFT JOIN today d ON d.team_id = t.id
          WHERE COALESCE(o.open, 0) + COALESCE(d.visits, 0) > 0
          ORDER BY lower(t.name)`,
        [CLOSED_STATUSES, SUCCESS_STATUSES]
      ),
      query(
        `SELECT COALESCE(SUM(drop_core_m), 0)::float AS drop_core_m, COALESCE(SUM(f_clamp), 0)::int AS f_clamp,
                COALESCE(SUM(house_clamp), 0)::int AS house_clamp, COALESCE(SUM(sc_connector), 0)::int AS sc_connector,
                COALESCE(SUM(onu), 0)::int AS onu
           FROM fe_visits WHERE visit_date = ${MANILA_TODAY}`
      ),
      query(
        `SELECT COUNT(*) FILTER (WHERE ${SLA_SQL} = 'PASS')::int AS pass, COUNT(*) FILTER (WHERE ${SLA_SQL} = 'DELAY')::int AS delay
           ${VISIT_BASE} WHERE v.visit_date = ${MANILA_TODAY}`
      ),
      query(
        `SELECT COUNT(*) FILTER (WHERE v.status = 'Nakuha ang Modem')::int AS retrieved, COUNT(*)::int AS visited
           ${VISIT_BASE}
          WHERE j.job_type = 'PULLOUT' AND v.visit_date >= date_trunc('week', ${MANILA_TODAY})::date AND v.visit_date <= ${MANILA_TODAY}`
      ),
      query(
        `SELECT COUNT(*)::int AS visits, COUNT(*) FILTER (WHERE status = ANY($1::text[]))::int AS done
           FROM fe_visits WHERE visit_date = ${MANILA_TODAY}`,
        [SUCCESS_STATUSES]
      )
    ]);
    return res.json({
      teams: teams.rows, materials: materials.rows[0], sla: sla.rows[0], pullout: pullout.rows[0],
      counts: counts.rows[0], targets: TARGETS
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

function periodRange(req) {
  const period = String(req.query.period || 'week');
  if (period === 'range' && DATE_RE.test(String(req.query.from)) && DATE_RE.test(String(req.query.to))) {
    return { from: String(req.query.from), to: String(req.query.to), sqlFrom: '$1::date', sqlTo: '$2::date', params: [req.query.from, req.query.to] };
  }
  if (period === 'month') {
    return { sqlFrom: `date_trunc('month', ${MANILA_TODAY})::date`, sqlTo: MANILA_TODAY, params: [] };
  }
  return { sqlFrom: `date_trunc('week', ${MANILA_TODAY})::date`, sqlTo: MANILA_TODAY, params: [] };
}

router.get('/reports', async (req, res) => {
  try {
    const r = periodRange(req);
    const inRange = `v.visit_date BETWEEN ${r.sqlFrom} AND ${r.sqlTo}`;
    const [range, teams, areas, materials] = await Promise.all([
      query(`SELECT to_char(${r.sqlFrom}, 'YYYY-MM-DD') AS "from", to_char(${r.sqlTo}, 'YYYY-MM-DD') AS "to"`, r.params),
      query(
        `SELECT COALESCE(t.name, 'No team') AS team, BOOL_OR(COALESCE(t.legacy, FALSE)) AS legacy,
                COUNT(*) FILTER (WHERE ${EFFECTIVE_TYPE} = 'INSTALL' AND v.status = 'Installed')::int AS installed,
                COUNT(*) FILTER (WHERE ${EFFECTIVE_TYPE} = 'INSTALL' AND v.status IN ('Installed', 'Not Installed', 'Cancelled', 'Reschedule'))::int AS install_closed,
                COUNT(*) FILTER (WHERE ${EFFECTIVE_TYPE} = 'REPAIR' AND v.status = 'Repaired')::int AS repaired,
                COUNT(*) FILTER (WHERE ${EFFECTIVE_TYPE} = 'REPAIR' AND v.status IN ('Repaired', 'Unresolved', 'Reschedule', 'Escalated'))::int AS repair_closed,
                COUNT(*) FILTER (WHERE j.job_type = 'PULLOUT' AND v.status = 'Nakuha ang Modem')::int AS retrieved,
                COUNT(*) FILTER (WHERE j.job_type = 'PULLOUT')::int AS pullout_visits,
                COUNT(*) FILTER (WHERE ${SLA_SQL} = 'PASS')::int AS sla_pass,
                COUNT(*) FILTER (WHERE ${SLA_SQL} = 'DELAY')::int AS sla_delay
           ${VISIT_BASE} WHERE ${inRange}
          GROUP BY COALESCE(t.name, 'No team')
          ORDER BY (COUNT(*)) DESC`,
        r.params
      ),
      query(
        `SELECT COALESCE(j.area, 'No area') AS area,
                COUNT(*) FILTER (WHERE v.status = 'Installed')::int AS installed,
                COUNT(*) FILTER (WHERE v.status = 'Repaired')::int AS repaired,
                COUNT(*) FILTER (WHERE v.status = 'Nakuha ang Modem')::int AS retrieved,
                COALESCE(SUM(v.drop_core_m), 0)::float AS drop_core_m
           ${VISIT_BASE} WHERE ${inRange}
          GROUP BY COALESCE(j.area, 'No area') ORDER BY 2 DESC`,
        r.params
      ),
      query(
        `SELECT COALESCE(t.name, 'No team') AS team,
                COALESCE(SUM(v.drop_core_m), 0)::float AS drop_core_m, COALESCE(SUM(v.f_clamp), 0)::int AS f_clamp,
                COALESCE(SUM(v.house_clamp), 0)::int AS house_clamp, COALESCE(SUM(v.sc_connector), 0)::int AS sc_connector,
                COALESCE(SUM(v.onu), 0)::int AS onu
           ${VISIT_BASE} WHERE ${inRange}
          GROUP BY COALESCE(t.name, 'No team')
         HAVING COALESCE(SUM(v.drop_core_m), 0) + COALESCE(SUM(v.f_clamp), 0) + COALESCE(SUM(v.sc_connector), 0) + COALESCE(SUM(v.onu), 0) > 0
          ORDER BY 2 DESC`,
        r.params
      )
    ]);
    return res.json({ range: range.rows[0], teams: teams.rows, areas: areas.rows, materials: materials.rows, targets: TARGETS });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

const csvCell = (value) => {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

router.get('/export', async (req, res) => {
  try {
    const r = periodRange(req);
    const rows = await query(
      `SELECT to_char(v.visit_date, 'YYYY-MM-DD') AS "Date", ${EFFECTIVE_TYPE} AS "Type",
              CASE WHEN j.job_type = 'RELOC' THEN 'Relocation' ELSE '' END AS "Relocation",
              t.name AS "Installer / Team", j.account_number AS "Account Number", j.order_number AS "JO Number",
              j.customer_name AS "Subscriber Name", j.customer_address AS "Address", j.area AS "AREA",
              v.problem AS "Problem Reported", v.status AS "Final Status", v.reason AS "Reason",
              v.drop_core_m AS "Drop Core (m)", v.f_clamp AS "F-Clamp", v.house_clamp AS "House Clamp",
              v.sc_connector AS "SC Connector", v.onu AS "ONU", ${SLA_SQL} AS "SLA Status", v.difficulty AS "Difficulty",
              to_char(v.start_time, 'HH24:MI') AS "Start Time", to_char(v.end_time, 'HH24:MI') AS "End Time",
              v.modem_serial AS "Modem Serial No.", v.remarks AS "Remarks", j.template_title AS "JO Template"
         ${VISIT_BASE}
        WHERE v.visit_date BETWEEN ${r.sqlFrom} AND ${r.sqlTo}
        ORDER BY v.visit_date, "Type", t.name`,
      r.params
    );
    const header = rows.fields.map((f) => f.name);
    const lines = [header.map(csvCell).join(','), ...rows.rows.map((row) => header.map((h) => csvCell(row[h])).join(','))];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="field-eng-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send(`﻿${lines.join('\r\n')}`);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
