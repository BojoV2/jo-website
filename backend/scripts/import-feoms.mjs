// One-off import of the FEOMS Excel history into Field Eng.
//
//   node scripts/import-feoms.mjs /tmp/feoms.json            (dry run, writes nothing)
//   APPLY=1 node scripts/import-feoms.mjs /tmp/feoms.json    (writes, in one transaction)
//
// The JSON comes from the Excel export (one object per Excel row). Safe to run
// again: every visit carries source_ref "<SHEET>!<row>", so rows already
// imported are skipped. It only inserts FE rows and fills empty FE fields;
// nothing outside the fe_* tables is modified except filling
// generated_pdfs.order_number where it is empty and the Excel JO number
// agrees with the JO record's date.
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../src/db.js';
import { syncMissingJobs, createJobForGenerated, jobTypeFor, snapshotFromForm, CLOSED_STATUSES, VISIT_CLOSED_AT } from '../src/services/feJobs.js';

const file = process.argv[2];
const APPLY = process.env.APPLY === '1';
const JOBS_SINCE = process.env.JOBS_SINCE || '2026-08-01';
const LOOKBACK_SINCE = process.env.LOOKBACK_SINCE || '2026-07-01';
const UNVERIFIED_AFTER_DAYS = Number(process.env.UNVERIFIED_AFTER_DAYS || 14);
if (!file) {
  console.error('usage: node scripts/import-feoms.mjs <feoms.json>');
  process.exit(1);
}
const rows = JSON.parse(fs.readFileSync(file, 'utf8'));

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
const digits = (s) => {
  const d = String(s || '').split('.')[0].replace(/\D/g, '');
  return d.length >= 6 ? d : '';
};
const nameMatch = (a, b) => {
  const A = new Set(a);
  const common = b.filter((w) => A.has(w)).length;
  return common >= 2 || (common === 1 && Math.min(a.length, b.length) === 1);
};
const dayNum = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86400000);
const COMPAT = { INSTALL: ['INSTALL', 'RELOC'], REPAIR: ['REPAIR', 'RELOC'], PULLOUT: ['PULLOUT', 'REPAIR'] };

function joNumber(raw, joDate) {
  const m = String(raw || '').match(/^(\d{8})\s*-\s*(\d{1,5})$/);
  if (!m || !joDate) return null;
  const jd = joDate.replace(/-/g, '');
  const d = Number(m[1].slice(0, 4)) * 10000;
  const near = [jd, String(Number(jd) - 1)];
  return near.includes(m[1]) && d ? `${m[1]}-${m[2]}` : null;
}

async function main() {
  // Every Application Form / JO from JOBS_SINCE gets a job (they belong on the
  // board or in its history). Older records, back to LOOKBACK_SINCE, only get a
  // job when an Excel visit actually matches them.
  if (APPLY) {
    const created = await syncMissingJobs({ since: JOBS_SINCE });
    console.log(`jobs created for JO records since ${JOBS_SINCE}: ${created}`);
  }

  const g = await pool.query(
    `SELECT g.id AS generated_pdf_id, t.title, g.submitted_data, g.order_number AS pdf_order_number, g.created_at,
            to_char((g.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Manila')::date, 'YYYY-MM-DD') AS jo_date,
            j.id AS job_id, j.job_type
       FROM generated_pdfs g
       JOIN pdf_templates t ON t.id = g.template_id
       LEFT JOIN fe_jobs j ON j.generated_pdf_id = g.id
      WHERE ((g.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Manila')::date) >= $1::date`,
    [LOOKBACK_SINCE]
  );
  const jobs = g.rows.map((r) => {
    const type = r.job_type || jobTypeFor(r.title, r.submitted_data);
    if (!type) return null;
    const s = snapshotFromForm(r.title, r.submitted_data, r.pdf_order_number);
    return { ...r, id: r.job_id, job_type: type, tokens: norm(s.customer_name), acct: digits(s.account_number), day: dayNum(r.jo_date) };
  }).filter(Boolean);

  const done = new Set((await pool.query(`SELECT source_ref FROM fe_visits WHERE source_ref IS NOT NULL`)).rows.map((r) => r.source_ref));

  const stats = { rows: rows.length, skipped_already_imported: 0, linked_by_account: 0, linked_by_name: 0, history_only: 0 };
  const perSheet = {};
  const plan = [];
  for (const row of rows) {
    const ref = `${row.sheet}!${row.row}`;
    if (done.has(ref)) { stats.skipped_already_imported += 1; continue; }
    let match = null;
    let how = null;
    if (row.date) {
      const vd = dayNum(row.date);
      const cands = jobs.filter((j) => COMPAT[row.sheet].includes(j.job_type) && j.day !== null && vd - j.day >= 0 && vd - j.day <= 30);
      const acct = digits(row.account);
      const byLag = (a, b) => (vd - a.day) - (vd - b.day);
      if (acct) {
        match = cands.filter((j) => j.acct === acct).sort(byLag)[0] || null;
        if (match) how = 'account';
      }
      if (!match) {
        const t = norm(row.name);
        match = cands.filter((j) => nameMatch(t, j.tokens)).sort(byLag)[0] || null;
        if (match) how = 'name';
      }
    }
    const k = perSheet[row.sheet] ||= { rows: 0, linked: 0 };
    k.rows += 1;
    if (match) { k.linked += 1; stats[`linked_by_${how}`] += 1; } else stats.history_only += 1;
    plan.push({ row, ref, match });
  }
  console.log(APPLY ? 'applying:' : '[dry run] would import:', stats);
  for (const [s, k] of Object.entries(perSheet)) console.log(`  ${s}: ${k.linked}/${k.rows} linked to a JO (${Math.round((k.linked * 100) / Math.max(k.rows, 1))}%)`);
  if (!APPLY) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Old Excel team names become retired "legacy" teams so past reports stay exact.
    const teamId = new Map((await client.query('SELECT id, name FROM fe_teams')).rows.map((t) => [t.name.toLowerCase(), t.id]));
    for (const name of new Set(plan.map((p) => p.row.team).filter(Boolean))) {
      if (!teamId.has(name.toLowerCase())) {
        const r = await client.query('INSERT INTO fe_teams (name, active, legacy) VALUES ($1, FALSE, TRUE) RETURNING id', [name]);
        teamId.set(name.toLowerCase(), r.rows[0].id);
      }
    }
    const options = (await client.query('SELECT kind, value FROM fe_options')).rows;
    const canon = (kind, value) => {
      if (!value) return null;
      const hit = options.find((o) => o.kind === kind && o.value.toLowerCase() === value.toLowerCase());
      return hit ? hit.value : value;
    };

    const touched = new Set();
    let orderFilled = 0;
    for (const { row, ref, match } of plan) {
      const sheetType = row.sheet;
      if (match && !match.id) {
        match.id = await createJobForGenerated({
          generatedPdfId: match.generated_pdf_id,
          templateTitle: match.title,
          submittedData: match.submitted_data,
          orderNumber: match.pdf_order_number,
          createdAt: match.created_at,
          db: client
        });
      }
      let jobId = match?.id;
      if (!jobId) {
        jobId = uuidv4();
        await client.query(
          `INSERT INTO fe_jobs (id, job_type, history_only, template_title, order_number, customer_name, customer_address,
             account_number, jo_date, team_id, area, status, source)
           VALUES ($1, $2, TRUE, 'FEOMS Excel', $3, $4, $5, $6, $7::date, $8, $9, 'Pending', 'excel')`,
          [jobId, sheetType, row.jo_number, row.name, row.address, row.account, row.date,
            row.team ? teamId.get(row.team.toLowerCase()) : null, row.area]
        );
      } else {
        if (match.job_type === 'RELOC') {
          await client.query(`UPDATE fe_jobs SET reloc_kind = COALESCE(reloc_kind, $2) WHERE id = $1`, [jobId, sheetType === 'INSTALL' ? 'install' : 'repair']);
        }
        await client.query(`UPDATE fe_jobs SET area = COALESCE(area, $2) WHERE id = $1`, [jobId, row.area]);
        const num = joNumber(row.jo_number, match.jo_date);
        if (num && !match.pdf_order_number && match.generated_pdf_id) {
          const r = await client.query(`UPDATE generated_pdfs SET order_number = $2 WHERE id = $1 AND order_number IS NULL`, [match.generated_pdf_id, num]);
          await client.query(`UPDATE fe_jobs SET order_number = COALESCE(order_number, $2) WHERE id = $1`, [jobId, num]);
          orderFilled += r.rowCount;
          match.pdf_order_number = num;
        }
      }
      const statusKind = sheetType === 'INSTALL' ? 'install_status' : sheetType === 'PULLOUT' ? 'pullout_status' : 'repair_status';
      const reasonKind = sheetType === 'INSTALL' ? 'install_reason' : sheetType === 'PULLOUT' ? 'pullout_reason' : 'repair_reason';
      await client.query(
        `INSERT INTO fe_visits (id, job_id, visit_date, team_id, status, reason, problem, difficulty, start_time, end_time,
           drop_core_m, f_clamp, house_clamp, sc_connector, onu, modem_serial, remarks, source, source_ref)
         VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9::time,$10::time,$11,$12,$13,$14,$15,$16,$17,'excel',$18)
         ON CONFLICT (source_ref) WHERE source_ref IS NOT NULL DO NOTHING`,
        [uuidv4(), jobId, row.date, row.team ? teamId.get(row.team.toLowerCase()) : null,
          canon(statusKind, row.status) || 'Pending', canon(reasonKind, row.reason), canon('problem', row.problem),
          ['Easy', 'Medium', 'Hard'].includes(row.difficulty) ? row.difficulty : null, row.start, row.end,
          row.drop_core_m, row.f_clamp, row.house_clamp, row.sc_connector, row.onu, row.modem_serial,
          [row.remarks, row.date ? null : (row.raw_date ? `Excel date: ${row.raw_date}` : 'No date in Excel')].filter(Boolean).join(' · ') || null,
          ref]
      );
      touched.add(jobId);
    }

    // A Job Order classed as repair whose only visits are pull-out rows is a pull-out job.
    await client.query(
      `UPDATE fe_jobs j SET job_type = 'PULLOUT'
        WHERE j.id = ANY($1::uuid[]) AND j.job_type = 'REPAIR'
          AND EXISTS (SELECT 1 FROM fe_visits v WHERE v.job_id = j.id)
          AND NOT EXISTS (SELECT 1 FROM fe_visits v WHERE v.job_id = j.id AND (v.source_ref IS NULL OR v.source_ref NOT LIKE 'PULLOUT!%'))`,
      [[...touched]]
    );

    // A job's status and team follow its newest visit.
    await client.query(
      `UPDATE fe_jobs j
          SET status = v.status, reason = v.reason, team_id = COALESCE(v.team_id, j.team_id),
              closed_at = CASE WHEN v.status = ANY($2::text[]) THEN ${VISIT_CLOSED_AT('v')} ELSE NULL END,
              updated_at = NOW()
         FROM (SELECT DISTINCT ON (job_id) job_id, status, reason, team_id, visit_date FROM fe_visits
                WHERE job_id = ANY($1::uuid[]) ORDER BY job_id, visit_date DESC NULLS LAST, created_at DESC) v
        WHERE j.id = v.job_id`,
      [[...touched], CLOSED_STATUSES]
    );

    // JO records that never reached the Excel and are old enough to be doubtful
    // leave the open board as "Unverified"; FE can reopen any by saving a visit.
    const unv = await client.query(
      `UPDATE fe_jobs j SET status = 'Unverified', closed_at = ((j.jo_date::timestamp + INTERVAL '12 hours') AT TIME ZONE 'Asia/Manila') AT TIME ZONE 'UTC', updated_at = NOW()
        WHERE NOT j.history_only AND j.status = 'Pending'
          AND j.jo_date < ((NOW() AT TIME ZONE 'Asia/Manila')::date - $1::int)
          AND NOT EXISTS (SELECT 1 FROM fe_visits v WHERE v.job_id = j.id)`,
      [UNVERIFIED_AFTER_DAYS]
    );
    await client.query(
      `INSERT INTO fe_audit (entity, entity_id, action, detail) VALUES ('import', 'feoms', 'excel_import', $1)`,
      [JSON.stringify({ ...stats, order_numbers_filled: orderFilled, unverified: unv.rowCount, file })]
    );
    await client.query('COMMIT');
    console.log(`done. order numbers filled from Excel: ${orderFilled}; old JO records marked Unverified: ${unv.rowCount}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => { console.error(`IMPORT FAILED, nothing written: ${err.message}`); process.exitCode = 1; })
  .finally(() => pool.end());
