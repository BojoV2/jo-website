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
  return syncMissingJobs();
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
