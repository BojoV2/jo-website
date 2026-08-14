/**
 * Records tickets to a Google Sheet ("JO Tickets"), auto-created via Drive on
 * first use. One worksheet tab per month (YYYY-MM). The spreadsheet id is
 * remembered in app_settings so it is created only once.
 *
 * All functions are best-effort and no-op when the service account is not
 * configured, so ticket creation never fails because of Sheets.
 */
import { query } from '../db.js';
import { getSheetsDrive, isServiceAccountConfigured } from './ticketGoogle.js';

const SETTING_ID = 'tickets_spreadsheet_id';
const SETTING_URL = 'tickets_spreadsheet_url';

// Column order for the tickets sheet. This IS the sheet format.
export const TICKET_HEADERS = [
  'ticket_number',
  'status',
  'created_at',
  'closed_at',
  'customer_name',
  'customer_address',
  'customer_contact',
  'concern',
  'tsr_troubleshooting',
  'created_by',
  'closed_by'
];

// Flatten the TSR checklist array into a readable multi-line cell.
function flattenChecklist(list) {
  if (!Array.isArray(list) || list.length === 0) return '';
  const byCat = new Map();
  for (const e of list) {
    const cat = e.category || 'Other';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(e.item);
  }
  return Array.from(byCat.entries())
    .map(([cat, items]) => `${cat}: ${items.join('; ')}`)
    .join('\n');
}

export function isTicketSheetsEnabled() {
  return isServiceAccountConfigured();
}

function monthTab(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function escapeTab(title) {
  return String(title).replace(/'/g, "''");
}

function cell(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

async function getSetting(key) {
  const r = await query('SELECT value FROM app_settings WHERE key = $1', [key]);
  return r.rowCount > 0 ? r.rows[0].value : null;
}

async function setSetting(key, value) {
  await query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, value]
  );
}

async function createSpreadsheet(firstTab) {
  const { sheets, drive } = await getSheetsDrive();
  const response = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: 'JO Tickets' },
      sheets: [{ properties: { title: firstTab, gridProperties: { frozenRowCount: 1 } } }]
    },
    fields: 'spreadsheetId,spreadsheetUrl'
  });
  const spreadsheetId = response.data.spreadsheetId;
  if (!spreadsheetId) throw new Error('Google Sheets did not return a spreadsheetId');

  const shareEmail = String(process.env.GOOGLE_SHEETS_SHARE_EMAIL || '').trim();
  if (shareEmail) {
    try {
      await drive.permissions.create({
        fileId: spreadsheetId,
        sendNotificationEmail: false,
        requestBody: { type: 'user', role: 'writer', emailAddress: shareEmail }
      });
    } catch (err) {
      const m = String(err?.message || '');
      if (!m.includes('already') && !m.includes('duplicate')) throw err;
    }
  }

  const spreadsheetUrl = response.data.spreadsheetUrl ||
    `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  await setSetting(SETTING_ID, spreadsheetId);
  await setSetting(SETTING_URL, spreadsheetUrl);
  return { spreadsheetId, spreadsheetUrl };
}

async function ensureSpreadsheet(firstTab) {
  // Prefer an admin-configured spreadsheet (created by a human, shared with the
  // service account). A plain service account cannot create/own Drive files, so
  // this is the supported path; auto-create is only a fallback.
  const configured = (process.env.GOOGLE_TICKETS_SPREADSHEET_ID || '').trim();
  const existing = configured || await getSetting(SETTING_ID);
  if (existing) {
    try {
      const { sheets } = await getSheetsDrive();
      const meta = await sheets.spreadsheets.get({ spreadsheetId: existing, fields: 'spreadsheetId,spreadsheetUrl' });
      const spreadsheetUrl = meta.data.spreadsheetUrl ||
        `https://docs.google.com/spreadsheets/d/${existing}/edit`;
      await setSetting(SETTING_ID, existing);
      await setSetting(SETTING_URL, spreadsheetUrl);
      return { spreadsheetId: existing, spreadsheetUrl };
    } catch (err) {
      const m = String(err?.message || '');
      // A configured id we cannot open should surface, not silently recreate.
      if (configured) throw err;
      if (!m.includes('not found') && !m.includes('Requested entity was not found')) throw err;
    }
  }
  return createSpreadsheet(firstTab);
}

async function ensureTab(spreadsheetId, tab) {
  const { sheets } = await getSheetsDrive();
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const exists = (meta.data.sheets || []).some((s) => s.properties?.title === tab);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          addSheet: { properties: { title: tab, gridProperties: { frozenRowCount: 1 } } }
        }]
      }
    });
  }
  // Ensure the header row is present.
  const headerRange = `'${escapeTab(tab)}'!1:1`;
  const current = await sheets.spreadsheets.values.get({ spreadsheetId, range: headerRange });
  const hasHeaders = Array.isArray(current.data.values?.[0]) && current.data.values[0].length > 0;
  if (!hasHeaders) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: headerRange,
      valueInputOption: 'RAW',
      requestBody: { values: [TICKET_HEADERS] }
    });
  }
}

function rowFor(ticket) {
  const map = {
    ticket_number: ticket.ticket_number,
    status: ticket.status,
    created_at: ticket.created_at,
    closed_at: ticket.closed_at || '',
    customer_name: ticket.customer_name,
    customer_address: ticket.customer_address || '',
    customer_contact: ticket.customer_contact || '',
    concern: ticket.concern,
    tsr_troubleshooting: flattenChecklist(ticket.tsr_checklist),
    created_by: ticket.created_by_name || '',
    closed_by: ticket.closed_by_name || ''
  };
  return TICKET_HEADERS.map((h) => cell(map[h]));
}

/**
 * Append a newly created ticket. Returns { tab, row } for the caller to persist
 * so a later close can update the exact row. Returns null when disabled/failed.
 */
export async function recordTicketCreated(ticket) {
  if (!isTicketSheetsEnabled()) return null;
  const tab = monthTab(ticket.created_at ? new Date(ticket.created_at) : new Date());
  const { spreadsheetId } = await ensureSpreadsheet(tab);
  await ensureTab(spreadsheetId, tab);

  const { sheets } = await getSheetsDrive();
  const appendRes = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${escapeTab(tab)}'!A:A`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [rowFor(ticket)] }
  });

  // updatedRange looks like: 'YYYY-MM'!A5:J5  -> capture the starting row number.
  const updatedRange = appendRes.data.updates?.updatedRange || '';
  const m = updatedRange.match(/![A-Z]+(\d+):/);
  const row = m ? Number(m[1]) : null;
  return { tab, row };
}

/**
 * Rewrite a ticket's row in place on close (or any status change). No-op when
 * disabled or when we never recorded a row for this ticket.
 */
export async function updateTicketRow(ticket) {
  if (!isTicketSheetsEnabled()) return;
  if (!ticket.sheet_tab || !ticket.sheet_row) return;
  const { spreadsheetId } = await ensureSpreadsheet(ticket.sheet_tab);
  const { sheets } = await getSheetsDrive();
  const endCol = String.fromCharCode(64 + TICKET_HEADERS.length); // A..J for 10 cols
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${escapeTab(ticket.sheet_tab)}'!A${ticket.sheet_row}:${endCol}${ticket.sheet_row}`,
    valueInputOption: 'RAW',
    requestBody: { values: [rowFor(ticket)] }
  });
}
