import express from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

/* Client lookup - one customer, everything about them.

   There is no customers table: a client only exists as the Name typed into a
   form, so identity here is the trimmed, lower-cased name, with the contact
   number used as a secondary match. Reads are team-wide, like the rest of the
   shared queue. */

const CLIENT_NAME = `COALESCE(
  NULLIF(TRIM(g.submitted_data->>'Name'), ''),
  NULLIF(TRIM(g.submitted_data->>'name'), ''),
  NULLIF(TRIM(g.submitted_data->>'Relocation name'), ''),
  NULLIF(TRIM(g.submitted_data->>'Client Name'), ''),
  NULLIF(TRIM(g.submitted_data->>'Customer Name'), ''),
  NULLIF(TRIM(g.submitted_data->>'Subscriber'), '')
)`;

const CLIENT_CONTACT = `COALESCE(
  NULLIF(TRIM(g.submitted_data->>'Contact number'), ''),
  NULLIF(TRIM(g.submitted_data->>'Contact Number'), ''),
  NULLIF(TRIM(g.submitted_data->>'contact number'), '')
)`;

const CLIENT_ADDRESS = `COALESCE(
  NULLIF(TRIM(g.submitted_data->>'Address'), ''),
  NULLIF(TRIM(g.submitted_data->>'Relocation Address'), ''),
  NULLIF(TRIM(g.submitted_data->>'Old Address'), '')
)`;

const CLIENT_REFERENCE = `COALESCE(
  NULLIF(TRIM(g.submitted_data->>'Order Number'), ''),
  NULLIF(TRIM(g.submitted_data->>'Order number'), ''),
  NULLIF(TRIM(g.submitted_data->>'Application number'), ''),
  NULLIF(TRIM(g.submitted_data->>'Account ID'), ''),
  NULLIF(TRIM(g.submitted_data->>'Account number'), ''),
  NULLIF(TRIM(g.submitted_data->>'Account No.'), '')
)`;

router.use(requireAuth);

// GET /api/clients?q= - who matches, newest activity first
router.get('/', async (req, res) => {
  try {
    const term = String(req.query.q || '').trim();
    if (term.length < 2) {
      return res.json({ term, clients: [] });
    }
    const pattern = `%${term.replace(/[%_]/g, (match) => `\\${match}`)}%`;
    const limit = Math.min(Number(req.query.limit) || 25, 100);

    const result = await query(
      `SELECT MAX(${CLIENT_NAME}) AS name,
              MAX(${CLIENT_CONTACT}) AS contact,
              MAX(${CLIENT_ADDRESS}) AS address,
              COUNT(*)::int AS document_count,
              COUNT(*) FILTER (WHERE g.status = 'pending')::int AS pending_count,
              MIN(g.created_at) AS first_seen,
              MAX(g.created_at) AS last_seen,
              COUNT(DISTINCT g.template_id)::int AS template_count
       FROM generated_pdfs g
       WHERE ${CLIENT_NAME} IS NOT NULL
         AND (${CLIENT_NAME} ILIKE $1 ESCAPE '\\'
              OR ${CLIENT_CONTACT} ILIKE $1 ESCAPE '\\'
              OR ${CLIENT_REFERENCE} ILIKE $1 ESCAPE '\\')
       GROUP BY LOWER(${CLIENT_NAME})
       ORDER BY MAX(g.created_at) DESC
       LIMIT $2`,
      [pattern, limit]
    );

    return res.json({ term, clients: result.rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/clients/profile?name= - the whole history for one client
router.get('/profile', async (req, res) => {
  try {
    const name = String(req.query.name || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const documents = await query(
      `SELECT g.id, g.status, g.auto_closed, g.status_note, g.reschedule_date,
              g.created_at, g.updated_at,
              ${CLIENT_CONTACT} AS contact,
              ${CLIENT_ADDRESS} AS address,
              ${CLIENT_REFERENCE} AS reference,
              t.title AS template_title,
              u.name AS created_by_name,
              (SELECT COUNT(*)::int FROM generated_pdf_attachments a WHERE a.generated_pdf_id = g.id) AS attachment_count
       FROM generated_pdfs g
       LEFT JOIN pdf_templates t ON t.id = g.template_id
       LEFT JOIN users u ON u.id = g.user_id
       WHERE LOWER(${CLIENT_NAME}) = LOWER($1)
       ORDER BY g.created_at DESC`,
      [name]
    );

    const attachments = await query(
      `SELECT a.id, a.original_name, a.mime_type, a.created_at, a.generated_pdf_id,
              u.name AS uploaded_by_name
       FROM generated_pdf_attachments a
       JOIN generated_pdfs g ON g.id = a.generated_pdf_id
       LEFT JOIN users u ON u.id = a.uploaded_by
       WHERE LOWER(${CLIENT_NAME}) = LOWER($1)
       ORDER BY a.created_at DESC`,
      [name]
    );

    const tickets = await query(
      `SELECT id, ticket_number, status, concern, customer_contact, customer_address,
              created_at, closed_at
       FROM tickets
       WHERE LOWER(TRIM(customer_name)) = LOWER($1)
       ORDER BY created_at DESC`,
      [name]
    );

    const rows = documents.rows;
    const summary = {
      name,
      contact: rows.find((row) => row.contact)?.contact || null,
      address: rows.find((row) => row.address)?.address || null,
      document_count: rows.length,
      pending_count: rows.filter((row) => row.status === 'pending').length,
      auto_closed_count: rows.filter((row) => row.auto_closed).length,
      attachment_count: attachments.rowCount,
      ticket_count: tickets.rowCount,
      open_ticket_count: tickets.rows.filter((row) => row.status === 'open').length,
      first_seen: rows.length ? rows[rows.length - 1].created_at : null,
      last_seen: rows.length ? rows[0].created_at : null,
      templates: [...new Set(rows.map((row) => row.template_title).filter(Boolean))]
    };

    return res.json({ summary, documents: rows, attachments: attachments.rows, tickets: tickets.rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
