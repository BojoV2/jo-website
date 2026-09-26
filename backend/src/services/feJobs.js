import { v4 as uuidv4 } from 'uuid';
import { query } from '../db.js';

// created_at columns are written in UTC; FE works in Manila calendar days.
export const MANILA_DATE = (col) => `((${col}) AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Manila')::date`;
export const MANILA_TODAY = `(NOW() AT TIME ZONE 'Asia/Manila')::date`;
// A job counts as closed on the date of the visit that closed it (noon Manila,
// stored in UTC like every other timestamp here), not on the day it was typed in.
export const VISIT_CLOSED_AT = (alias) => `COALESCE(((${alias}.visit_date::timestamp + INTERVAL '12 hours') AT TIME ZONE 'Asia/Manila') AT TIME ZONE 'UTC', NOW() AT TIME ZONE 'UTC')`;

// Jobs from JO records older than this are only created by the one-off import;
// the live hook and the safety-net sync only ever look this far back.
const SYNC_LOOKBACK_DAYS = 7;

export const CLOSED_STATUSES = ['Installed', 'Repaired', 'Nakuha ang Modem', 'Cancelled', 'Not Installed', 'Unresolved', 'Unverified'];
export const SUCCESS_STATUSES = ['Installed', 'Repaired', 'Nakuha ang Modem'];
// Values the code itself relies on (closing, SLA, reports, area auto-detect).
// The list editor lets people reorder these but not rename or retire them.
export const CORE_STATUSES = [
  'Pending', 'Installed', 'Reschedule', 'Not Installed', 'Cancelled', 'Reassigned',
  'Repaired', 'Unresolved', 'Escalated', 'Nakuha ang Modem', 'Hindi Nakuha ang Modem'
];
export const AUTO_AREAS = ['TANZA', 'KAWIT', 'TRECE', 'NAIC'];

const first = (data, keys) => {
  for (const key of keys) {
    const value = data?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).replace(/\s+/g, ' ').trim();
    }
  }
  return null;
};

export function jobTypeFor(templateTitle, submittedData) {
  const title = String(templateTitle || '').trim().toLowerCase();
  if (title.includes('application form')) return 'INSTALL';
  if (title.includes('relocation')) return 'RELOC';
  if (title.includes('job order')) {
    const reason = String(submittedData?.Reason || '').toLowerCase();
    return /pull\s*-?\s*out/.test(reason) ? 'PULLOUT' : 'REPAIR';
  }
  return null;
}

export function guessArea(templateTitle, address) {
  if (String(templateTitle || '').toLowerCase().includes('kawit')) return 'KAWIT';
  const text = String(address || '').toLowerCase();
  if (/\bkawit\b/.test(text)) return 'KAWIT';
  if (/\btrece\b|\btrece martires\b/.test(text)) return 'TRECE';
  if (/\bnaic\b/.test(text)) return 'NAIC';
  if (/\btanza\b/.test(text)) return 'TANZA';
  return null;
}

export function snapshotFromForm(templateTitle, submittedData, orderNumber) {
  const data = submittedData || {};
  const address = first(data, ['Address', 'Relocation Address', 'Old Address']);
  return {
    template_title: String(templateTitle || '').trim(),
    order_number: orderNumber || first(data, ['Order Number', 'Order number', 'Application number']),
    customer_name: first(data, ['Name', 'Relocation name', 'Client Name', 'Customer Name']),
    customer_address: address,
    customer_contact: first(data, ['Contact number', 'Contact Number']),
    account_number: first(data, ['Account ID', 'Account number', 'Account No.']),
    plan: first(data, ['Plan', 'Internet Plan', 'Internet plan']),
    jo_reason: first(data, ['Reason']),
    area: guessArea(templateTitle, address)
  };
}

// Creates the FE job for one generated PDF. Idempotent: a second call for the
// same generated PDF does nothing. Returns the job id, or null when the
// template is not a field-work template.
export async function createJobForGenerated({ generatedPdfId, templateTitle, submittedData, orderNumber, createdAt, db = { query } }) {
  const jobType = jobTypeFor(templateTitle, submittedData);
  if (!jobType) return null;
  const s = snapshotFromForm(templateTitle, submittedData, orderNumber);
  const id = uuidv4();
  const result = await db.query(
    `INSERT INTO fe_jobs (id, generated_pdf_id, job_type, template_title, order_number, customer_name,
       customer_address, customer_contact, account_number, plan, jo_reason, jo_date, area, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, ${MANILA_DATE('$12::timestamp')}, $13, $12::timestamp)
     ON CONFLICT (generated_pdf_id) DO NOTHING
     RETURNING id`,
    [id, generatedPdfId, jobType, s.template_title, s.order_number, s.customer_name, s.customer_address,
      s.customer_contact, s.account_number, s.plan, s.jo_reason, createdAt || new Date(), s.area]
  );
  return result.rows[0]?.id || null;
}

// Backfills jobs for generated PDFs that have none yet. Used by the import
// (with an explicit start date) and as a safety net behind the live hook.
export async function syncMissingJobs({ since } = {}) {
  const params = [];
  let where = `g.created_at > NOW() - INTERVAL '${SYNC_LOOKBACK_DAYS} days'`;
  if (since) {
    params.push(since);
    where = `${MANILA_DATE('g.created_at')} >= $1::date`;
  }
  const missing = await query(
    `SELECT g.id, g.submitted_data, g.order_number, g.created_at, t.title
       FROM generated_pdfs g
       JOIN pdf_templates t ON t.id = g.template_id
       LEFT JOIN fe_jobs j ON j.generated_pdf_id = g.id
      WHERE j.id IS NULL AND ${where}
      ORDER BY g.created_at`,
    params
  );
  let created = 0;
  for (const row of missing.rows) {
    const id = await createJobForGenerated({
      generatedPdfId: row.id,
      templateTitle: row.title,
      submittedData: row.submitted_data,
      orderNumber: row.order_number,
      createdAt: row.created_at
    });
    if (id) created += 1;
  }
  return created;
}

let lastSyncAt = 0;
export async function syncMissingJobsThrottled() {
  if (Date.now() - lastSyncAt < 60 * 1000) return 0;
  lastSyncAt = Date.now();
  const created = await syncMissingJobs();
  await reconcileJoStatuses();
  return created;
}

// ---------------------------------------------------------------- JO <-> Field Eng status sync
//
// Field Eng -> JO: a visit whose result is done / cancelled / rescheduled sets
// the JO workflow status the same way. "Done" also adds a note naming the team
// ("Installed by Team Kawit"); with no team the JO is just marked done. The
// JO's previous state is kept on the visit (fe_visits.jo_prev) so removing
// that visit (Undo) puts the JO back.
//
// JO -> Field Eng: a JO marked done / rescheduled / back to pending in the JO
// workflow records a matching visit (source 'jo') on its field job; a done JO
// also gets the team note. Cancelled keeps its own rule (jo_cancelled). JOs
// closed by the 30-day sweeper are not field work and are never synced.

export const JO_STATUS_FOR = { Installed: 'done', Repaired: 'done', 'Nakuha ang Modem': 'done', Cancelled: 'cancelled', Reschedule: 'rescheduled' };
const DONE_FOR_TYPE = { INSTALL: 'Installed', REPAIR: 'Repaired', PULLOUT: 'Nakuha ang Modem' };
const DONE_VERB = { Installed: 'Installed', Repaired: 'Repaired', 'Nakuha ang Modem': 'Modem retrieved' };
const typeOf = (job) => (job.job_type === 'RELOC' ? (job.reloc_kind === 'install' ? 'INSTALL' : job.reloc_kind === 'repair' ? 'REPAIR' : null) : job.job_type);

// "Installed by Team Kawit" added to the JO note (kept once, never duplicated).
function teamNote(existing, status, teamName) {
  if (!teamName || !DONE_VERB[status]) return existing || null;
  const line = `${DONE_VERB[status]} by ${teamName}`;
  if ((existing || '').includes(line)) return existing;
  return existing ? `${existing} · ${line}` : line;
}

async function teamNameOf(teamId) {
  if (!teamId) return null;
  const r = await query('SELECT name FROM fe_teams WHERE id = $1', [teamId]);
  return r.rows[0]?.name || null;
}

async function writeJo(generatedPdfId, { status, note, rescheduleDate, autoClosed = false }, oldStatus, user, why) {
  await query(
    `UPDATE generated_pdfs SET status = $2, status_note = $3, reschedule_date = $4, auto_closed = $5, updated_at = NOW() WHERE id = $1`,
    [generatedPdfId, status, note, status === 'rescheduled' ? rescheduleDate : null, autoClosed]
  );
  await query(
    `INSERT INTO status_history (id, generated_pdf_id, old_status, new_status, changed_by, note) VALUES ($1, $2, $3, $4, $5, $6)`,
    [uuidv4(), generatedPdfId, oldStatus, status, user?.id || null, why]
  );
}

// Field Eng -> JO for one visit. Returns the JO's previous state (stored on the
// visit for Undo) or null when the JO was left alone.
export async function pushVisitToJo(visitId, user) {
  const r = await query(
    `SELECT v.id, v.status, v.team_id, to_char(v.reschedule_date, 'YYYY-MM-DD') AS reschedule_date, j.id AS job_id, j.generated_pdf_id,
            g.status AS jo_status, g.status_note, to_char(g.reschedule_date, 'YYYY-MM-DD') AS jo_reschedule_date, g.auto_closed
       FROM fe_visits v JOIN fe_jobs j ON j.id = v.job_id JOIN generated_pdfs g ON g.id = j.generated_pdf_id
      WHERE v.id = $1 AND NOT j.history_only`,
    [visitId]
  );
  const v = r.rows[0];
  const target = v && JO_STATUS_FOR[v.status];
  if (!target) return null;
  const note = target === 'done' ? teamNote(v.status_note, v.status, await teamNameOf(v.team_id)) : v.status_note;
  const same = v.jo_status === target && (note || null) === (v.status_note || null)
    && (target !== 'rescheduled' || v.jo_reschedule_date === v.reschedule_date);
  if (same) return null;
  const prev = { status: v.jo_status, status_note: v.status_note, reschedule_date: v.jo_reschedule_date, auto_closed: v.auto_closed, set: target };
  await writeJo(v.generated_pdf_id, { status: target, note, rescheduleDate: v.reschedule_date }, v.jo_status, user, `From Field Eng: ${v.status}`);
  await query('UPDATE fe_visits SET jo_prev = $2 WHERE id = $1', [visitId, JSON.stringify(prev)]);
  await audit({ entity: 'job', entityId: v.job_id, jobId: v.job_id, action: 'jo_status_set', detail: { from: v.jo_status, to: target, note }, user });
  return prev;
}

// Undo of a Field Eng visit that had changed the JO: put the JO back, but only
// if nobody changed the JO since.
export async function restoreJoForVisit(visit, user) {
  const prev = visit.jo_prev;
  if (!prev) return false;
  const r = await query(
    `SELECT g.id, g.status FROM fe_jobs j JOIN generated_pdfs g ON g.id = j.generated_pdf_id WHERE j.id = $1`,
    [visit.job_id]
  );
  const g = r.rows[0];
  if (!g || g.status !== prev.set) return false;
  await writeJo(g.id, { status: prev.status, note: prev.status_note, rescheduleDate: prev.reschedule_date, autoClosed: prev.auto_closed },
    g.status, user, 'Field Eng visit undone');
  await audit({ entity: 'job', entityId: visit.job_id, jobId: visit.job_id, action: 'jo_status_restored', detail: { to: prev.status }, user });
  return true;
}

async function addJoVisit(job, status, { rescheduleDate = null, remarks, user }) {
  const id = uuidv4();
  await query(
    `INSERT INTO fe_visits (id, job_id, visit_date, team_id, status, reschedule_date, remarks, source, created_by, updated_by)
     VALUES ($1, $2, ${MANILA_TODAY}, $3, $4, $5::date, $6, 'jo', $7, $7)`,
    [id, job.id, job.team_id, status, rescheduleDate, remarks, user?.id || null]
  );
  await refreshJobFromVisits(job.id, user?.id);
  return id;
}

// JO -> Field Eng, after a status change in the JO workflow.
export async function syncJobFromJo(generatedPdfId, user) {
  const r = await query(
    `SELECT j.*, g.status AS jo_status, g.status_note, g.auto_closed, to_char(g.reschedule_date, 'YYYY-MM-DD') AS jo_reschedule_date
       FROM fe_jobs j JOIN generated_pdfs g ON g.id = j.generated_pdf_id
      WHERE j.generated_pdf_id = $1`,
    [generatedPdfId]
  );
  const job = r.rows[0];
  if (!job || job.history_only) return null;
  const open = !CLOSED_STATUSES.includes(job.status);

  if (job.jo_status === 'cancelled') {
    if (job.jo_cancelled || !open) return null;
    await query(
      `UPDATE fe_jobs SET status = 'Cancelled', reason = 'JO cancelled in the workflow', jo_cancelled = TRUE,
              closed_at = NOW(), updated_at = NOW(), updated_by = COALESCE($2, updated_by)
        WHERE id = $1`,
      [job.id, user?.id || null]
    );
    await audit({ entity: 'job', entityId: job.id, jobId: job.id, action: 'jo_cancelled', detail: { from: job.status }, user });
    return 'cancelled';
  }
  if (job.jo_cancelled) {
    await query(
      `UPDATE fe_jobs SET status = 'Pending', reason = NULL, jo_cancelled = FALSE, closed_at = NULL,
              updated_at = NOW(), updated_by = COALESCE($2, updated_by)
        WHERE id = $1`,
      [job.id, user?.id || null]
    );
    await refreshJobFromVisits(job.id, user?.id);
    await audit({ entity: 'job', entityId: job.id, jobId: job.id, action: 'jo_reopened', detail: { jo_status: job.jo_status }, user });
    if (job.jo_status === 'pending') return 'reopened';
    return syncJobFromJo(generatedPdfId, user);
  }

  if (job.jo_status === 'done' && !job.auto_closed) {
    if (!open) return null;
    const type = typeOf(job);
    if (!type) return null; // relocation without install/repair kind: leave it for the FE office
    const status = DONE_FOR_TYPE[type];
    await addJoVisit(job, status, { remarks: 'Marked done in the JO workflow', user });
    const note = teamNote(job.status_note, status, await teamNameOf(job.team_id));
    if ((note || null) !== (job.status_note || null)) {
      await query('UPDATE generated_pdfs SET status_note = $2, updated_at = NOW() WHERE id = $1', [generatedPdfId, note]);
    }
    await audit({ entity: 'job', entityId: job.id, jobId: job.id, action: 'jo_done', detail: { status, note }, user });
    return 'done';
  }

  if (job.jo_status === 'rescheduled') {
    if (!open || !job.jo_reschedule_date) return null;
    const latest = await query(
      `SELECT status, to_char(reschedule_date, 'YYYY-MM-DD') AS d FROM fe_visits WHERE job_id = $1 ORDER BY visit_date DESC NULLS LAST, created_at DESC LIMIT 1`,
      [job.id]
    );
    if (latest.rows[0]?.status === 'Reschedule' && latest.rows[0]?.d === job.jo_reschedule_date) return null;
    await addJoVisit(job, 'Reschedule', { rescheduleDate: job.jo_reschedule_date, remarks: `Rescheduled to ${job.jo_reschedule_date} in the JO workflow`, user });
    await audit({ entity: 'job', entityId: job.id, jobId: job.id, action: 'jo_rescheduled', detail: { to: job.jo_reschedule_date }, user });
    return 'rescheduled';
  }

  if (job.jo_status === 'pending') {
    // Back to pending in the JO workflow: undo a JO-made visit, or reopen a
    // field job that Field Eng had closed / rescheduled.
    const latest = await query(
      `SELECT id, source, status FROM fe_visits WHERE job_id = $1 ORDER BY visit_date DESC NULLS LAST, created_at DESC LIMIT 1`,
      [job.id]
    );
    const last = latest.rows[0];
    if (!last || !JO_STATUS_FOR[last.status]) return null;
    if (last.source === 'jo') {
      await query('DELETE FROM fe_visits WHERE id = $1', [last.id]);
      const left = await query('SELECT 1 FROM fe_visits WHERE job_id = $1 LIMIT 1', [job.id]);
      if (left.rowCount) await refreshJobFromVisits(job.id, user?.id);
      else await query(`UPDATE fe_jobs SET status = 'Pending', reason = NULL, closed_at = NULL, updated_at = NOW() WHERE id = $1`, [job.id]);
    } else {
      await addJoVisit(job, 'Pending', { remarks: 'Reopened in the JO workflow', user });
    }
    await audit({ entity: 'job', entityId: job.id, jobId: job.id, action: 'jo_reopened', detail: { from: last.status }, user });
    return 'reopened';
  }
  return null;
}

// Safety net for status changes that happened without the hook (older code,
// direct DB edits): same rules as syncJobFromJo, for every job at once.
export async function reconcileJoStatuses() {
  const r = await query(
    `SELECT j.generated_pdf_id FROM fe_jobs j JOIN generated_pdfs g ON g.id = j.generated_pdf_id
      WHERE NOT j.history_only
        AND ((g.status = 'cancelled' AND NOT j.jo_cancelled AND NOT (j.status = ANY($1::text[])))
          OR (g.status <> 'cancelled' AND j.jo_cancelled))`,
    [CLOSED_STATUSES]
  );
  for (const row of r.rows) await syncJobFromJo(row.generated_pdf_id, null);
  return r.rowCount;
}

export async function audit({ entity, entityId, jobId, action, detail, user }) {
  await query(
    `INSERT INTO fe_audit (entity, entity_id, job_id, action, detail, user_id, user_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [entity, String(entityId), jobId || null, action, JSON.stringify(detail || {}), user?.id || null, user?.name || null]
  );
}

// The job's current state is the newest visit (by visit date, then entry time).
export async function refreshJobFromVisits(jobId, userId) {
  await query(
    `UPDATE fe_jobs j
        SET status = v.status,
            reason = v.reason,
            team_id = COALESCE(v.team_id, j.team_id),
            closed_at = CASE WHEN v.status = ANY($2::text[]) THEN ${VISIT_CLOSED_AT('v')} ELSE NULL END,
            updated_at = NOW(),
            updated_by = COALESCE($3, j.updated_by)
       FROM (SELECT status, reason, team_id, visit_date FROM fe_visits WHERE job_id = $1
              ORDER BY visit_date DESC NULLS LAST, created_at DESC LIMIT 1) v
      WHERE j.id = $1`,
    [jobId, CLOSED_STATUSES, userId || null]
  );
}
