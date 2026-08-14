import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { recordTicketCreated, updateTicketRow, isTicketSheetsEnabled } from '../services/ticketSheetService.js';
import { emailNocNewTicket, isTicketMailEnabled } from '../services/ticketMailService.js';

const router = express.Router();

// Chat messages older than this are treated as expired (hidden from the thread).
const MESSAGE_TTL = "1 day";

// ── Chat image uploads ────────────────────────────────────────────
const storageRoot = process.env.STORAGE_ROOT || path.resolve(process.cwd(), '../storage');
const chatImageDir = path.join(storageRoot, 'ticket-chat-images');
fs.mkdirSync(chatImageDir, { recursive: true });

const chatImageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, chatImageDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    }
  }),
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files are allowed'));
    return cb(null, true);
  },
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Never expose the on-disk path to clients.
function mapMessage(row) {
  return {
    id: row.id,
    ticket_id: row.ticket_id,
    author_id: row.author_id,
    author_name: row.author_name,
    body: row.body,
    has_image: Boolean(row.image_path),
    image_name: row.image_name || null,
    created_at: row.created_at
  };
}

const MESSAGE_SELECT = `SELECT id, ticket_id, author_id, author_name, body, image_path, image_name, mime_type, created_at
  FROM ticket_messages
  WHERE ticket_id = $1 AND created_at >= NOW() - INTERVAL '${MESSAGE_TTL}'
  ORDER BY created_at ASC`;

function monthKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}`;
}

// Monthly-resetting ticket number: TKT-YYYYMM-#### (atomic, collision-safe).
async function allocateTicketNumber(date = new Date()) {
  const key = monthKey(date);
  const r = await query(
    `INSERT INTO ticket_counters (month_key, current_value)
     VALUES ($1, 1)
     ON CONFLICT (month_key)
     DO UPDATE SET current_value = ticket_counters.current_value + 1, updated_at = NOW()
     RETURNING current_value`,
    [key]
  );
  const seq = String(r.rows[0].current_value).padStart(4, '0');
  return `TKT-${key}-${seq}`;
}

function mapTicket(row) {
  return {
    id: row.id,
    ticket_number: row.ticket_number,
    customer_name: row.customer_name,
    customer_address: row.customer_address,
    customer_contact: row.customer_contact,
    concern: row.concern,
    status: row.status,
    created_by: row.created_by,
    created_by_name: row.created_by_name || null,
    closed_by: row.closed_by,
    closed_by_name: row.closed_by_name || null,
    closed_at: row.closed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    tsr_checklist: Array.isArray(row.tsr_checklist) ? row.tsr_checklist : [],
    message_count: row.message_count !== undefined ? Number(row.message_count) : undefined
  };
}

// Accept only a clean array of {category, group, item} strings.
function sanitizeChecklist(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const category = String(entry.category || '').slice(0, 200);
    const group = String(entry.group || '').slice(0, 200);
    const item = String(entry.item || '').slice(0, 300);
    if (item) out.push({ category, group, item });
  }
  return out.slice(0, 200);
}

const SELECT_TICKET = `
  SELECT t.*, cu.name AS created_by_name, clu.name AS closed_by_name,
         (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id) AS message_count
  FROM tickets t
  LEFT JOIN users cu ON cu.id = t.created_by
  LEFT JOIN users clu ON clu.id = t.closed_by`;

// ── Integration status (so the UI can show whether Sheets/email are live) ──
router.get('/integrations', requireAuth, async (_req, res) => {
  let spreadsheet_url = null;
  try {
    const r = await query("SELECT value FROM app_settings WHERE key = 'tickets_spreadsheet_url'");
    if (r.rowCount > 0) spreadsheet_url = r.rows[0].value;
  } catch (_e) { /* app_settings may not exist yet */ }
  res.json({ sheets: isTicketSheetsEnabled(), email: isTicketMailEnabled(), spreadsheet_url });
});

// ── Create ticket ─────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    const { customer_name, customer_address, customer_contact, concern } = req.body;
    if (!customer_name || !String(customer_name).trim()) {
      return res.status(400).json({ error: 'customer_name is required' });
    }
    if (!concern || !String(concern).trim()) {
      return res.status(400).json({ error: 'concern is required' });
    }

    const id = uuidv4();
    const ticketNumber = await allocateTicketNumber();
    const checklist = sanitizeChecklist(req.body.tsr_checklist);

    const inserted = await query(
      `INSERT INTO tickets (id, ticket_number, customer_name, customer_address, customer_contact, concern, status, created_by, tsr_checklist)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8::jsonb)
       RETURNING id`,
      [id, ticketNumber, String(customer_name).trim(), customer_address?.trim() || null,
       customer_contact?.trim() || null, String(concern).trim(), req.user.id, JSON.stringify(checklist)]
    );
    if (inserted.rowCount === 0) {
      return res.status(500).json({ error: 'Failed to create ticket' });
    }

    const loaded = await query(`${SELECT_TICKET} WHERE t.id = $1`, [id]);
    const ticket = mapTicket(loaded.rows[0]);

    // Best-effort: record to Google Sheet, remember the row for later close.
    try {
      const placed = await recordTicketCreated(ticket);
      if (placed?.tab && placed?.row) {
        await query('UPDATE tickets SET sheet_tab = $1, sheet_row = $2 WHERE id = $3',
          [placed.tab, placed.row, id]);
      }
    } catch (err) {
      console.error(`Ticket ${ticketNumber} sheet record failed: ${err.message}`);
    }

    // Best-effort: email the NOC that a ticket was submitted.
    try {
      await emailNocNewTicket(ticket);
    } catch (err) {
      console.error(`Ticket ${ticketNumber} NOC email failed: ${err.message}`);
    }

    return res.status(201).json(ticket);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── List tickets (default: open queue, shared across all CSRs) ────
router.get('/', requireAuth, async (req, res) => {
  try {
    const status = req.query.status || 'open';
    const params = [];
    let where = '';
    if (status !== 'all') {
      if (!['open', 'closed'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      params.push(status);
      where = `WHERE t.status = $1`;
    }
    const result = await query(
      `${SELECT_TICKET} ${where} ORDER BY t.created_at DESC`,
      params
    );
    return res.json(result.rows.map(mapTicket));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Single ticket + its messages ──────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const loaded = await query(`${SELECT_TICKET} WHERE t.id = $1`, [req.params.id]);
    if (loaded.rowCount === 0) return res.status(404).json({ error: 'Ticket not found' });

    const messages = await query(MESSAGE_SELECT, [req.params.id]);
    return res.json({ ticket: mapTicket(loaded.rows[0]), messages: messages.rows.map(mapMessage) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Messages (poll) ───────────────────────────────────────────────
router.get('/:id/messages', requireAuth, async (req, res) => {
  try {
    const exists = await query('SELECT id FROM tickets WHERE id = $1', [req.params.id]);
    if (exists.rowCount === 0) return res.status(404).json({ error: 'Ticket not found' });
    const messages = await query(MESSAGE_SELECT, [req.params.id]);
    return res.json(messages.rows.map(mapMessage));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Post a message (the live chat) — optional image attachment ────
router.post('/:id/messages', requireAuth, chatImageUpload.single('image'), async (req, res) => {
  try {
    const body = String(req.body.body || '').trim();
    const hasImage = Boolean(req.file);
    if (!body && !hasImage) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'A message or an image is required' });
    }
    const ticket = await query('SELECT id FROM tickets WHERE id = $1', [req.params.id]);
    if (ticket.rowCount === 0) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const id = uuidv4();
    const imagePath = hasImage ? path.join('ticket-chat-images', req.file.filename) : null;
    await query(
      `INSERT INTO ticket_messages (id, ticket_id, author_id, author_name, body, image_path, image_name, mime_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, req.params.id, req.user.id, req.user.name || null, body || '',
       imagePath, hasImage ? req.file.originalname : null, hasImage ? req.file.mimetype : null]
    );
    await query('UPDATE tickets SET updated_at = NOW() WHERE id = $1', [req.params.id]);

    const row = await query(
      `SELECT id, ticket_id, author_id, author_name, body, image_path, image_name, mime_type, created_at
       FROM ticket_messages WHERE id = $1`, [id]);
    return res.status(201).json(mapMessage(row.rows[0]));
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(500).json({ error: err.message });
  }
});

// ── Serve a chat image (public by obscurity — message UUID is unguessable) ──
router.get('/messages/:messageId/image', async (req, res) => {
  try {
    const row = await query(
      'SELECT image_path, image_name, mime_type FROM ticket_messages WHERE id = $1',
      [req.params.messageId]
    );
    if (row.rowCount === 0 || !row.rows[0].image_path) {
      return res.status(404).json({ error: 'Image not found' });
    }
    const abs = path.join(storageRoot, row.rows[0].image_path);
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'Image file missing' });
    if (row.rows[0].mime_type) res.setHeader('Content-Type', row.rows[0].mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(row.rows[0].image_name || 'image')}"`);
    return res.sendFile(abs);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Close ticket (drops from open queue, saved to sheet) ──────────
router.patch('/:id/close', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `UPDATE tickets
       SET status = 'closed', closed_by = $1, closed_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND status = 'open'
       RETURNING id`,
      [req.user.id, req.params.id]
    );
    if (result.rowCount === 0) {
      const exists = await query('SELECT status FROM tickets WHERE id = $1', [req.params.id]);
      if (exists.rowCount === 0) return res.status(404).json({ error: 'Ticket not found' });
      return res.status(409).json({ error: 'Ticket is already closed' });
    }

    const loaded = await query(`${SELECT_TICKET} WHERE t.id = $1`, [req.params.id]);
    const ticket = mapTicket(loaded.rows[0]);
    // ticket row carries sheet_tab/sheet_row from t.* in SELECT_TICKET
    ticket.sheet_tab = loaded.rows[0].sheet_tab;
    ticket.sheet_row = loaded.rows[0].sheet_row;

    try {
      await updateTicketRow(ticket);
    } catch (err) {
      console.error(`Ticket ${ticket.ticket_number} sheet close-update failed: ${err.message}`);
    }

    return res.json(ticket);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Update TSR checklist (troubleshooting performed) ──────────────
router.patch('/:id/checklist', requireAuth, async (req, res) => {
  try {
    const checklist = sanitizeChecklist(req.body.tsr_checklist);
    const upd = await query(
      `UPDATE tickets SET tsr_checklist = $1::jsonb, updated_at = NOW()
       WHERE id = $2 RETURNING id`,
      [JSON.stringify(checklist), req.params.id]
    );
    if (upd.rowCount === 0) return res.status(404).json({ error: 'Ticket not found' });

    const loaded = await query(`${SELECT_TICKET} WHERE t.id = $1`, [req.params.id]);
    const ticket = mapTicket(loaded.rows[0]);
    ticket.sheet_tab = loaded.rows[0].sheet_tab;
    ticket.sheet_row = loaded.rows[0].sheet_row;
    try { await updateTicketRow(ticket); } catch (err) {
      console.error(`Ticket ${ticket.ticket_number} sheet checklist-update failed: ${err.message}`);
    }
    return res.json(ticket);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Reopen ticket ─────────────────────────────────────────────────
router.patch('/:id/reopen', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `UPDATE tickets
       SET status = 'open', closed_by = NULL, closed_at = NULL, updated_at = NOW()
       WHERE id = $1 AND status = 'closed'
       RETURNING id`,
      [req.params.id]
    );
    if (result.rowCount === 0) {
      const exists = await query('SELECT status FROM tickets WHERE id = $1', [req.params.id]);
      if (exists.rowCount === 0) return res.status(404).json({ error: 'Ticket not found' });
      return res.status(409).json({ error: 'Ticket is already open' });
    }
    const loaded = await query(`${SELECT_TICKET} WHERE t.id = $1`, [req.params.id]);
    const ticket = mapTicket(loaded.rows[0]);
    ticket.sheet_tab = loaded.rows[0].sheet_tab;
    ticket.sheet_row = loaded.rows[0].sheet_row;
    try { await updateTicketRow(ticket); } catch (err) {
      console.error(`Ticket ${ticket.ticket_number} sheet reopen-update failed: ${err.message}`);
    }
    return res.json(ticket);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
