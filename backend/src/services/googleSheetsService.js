/**
 * Mirrors generated PDFs to a Google Sheet, one tab per template. Same
 * working pattern as ticketSheetService.js: a bare service account cannot
 * create its own Drive files (no personal storage quota), so this only
 * ever opens and appends to a spreadsheet a human already created and
 * shared with the service account - it never tries to create one itself.
 * That's the fix for the 2026-09 bug where every template creation and
 * every PDF export logged a Google permission error and never actually
 * synced anything (0 of 6 templates ever got linked).
 *
 * Setup (one-time, human): create a Google Sheet, share it (Editor) with
 * the service account's client_email, put its id in
 * GOOGLE_TEMPLATES_SPREADSHEET_ID.
 */
import { query } from '../db.js';
import { getSheetsDrive, isServiceAccountConfigured } from './ticketGoogle.js';

const SETTING_ID = 'templates_spreadsheet_id';
const SETTING_URL = 'templates_spreadsheet_url';

const FIXED_HEADERS = [
  'record_id',
  'created_at',
  'user_id',
  'user_name',
  'user_email',
  'status',
  'status_note',
  'reschedule_date',
  'template_id',
  'template_title',
  'template_version',
  'pdf_file_path'
];

export function isGoogleSheetsEnabled() {
  return isServiceAccountConfigured();
}

function sanitizeWhitespace(value) {
  return String(value || '').trim();
}

function escapeTab(title) {
  return String(title).replace(/'/g, "''");
}

function normalizeCellValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
}

// Sheet tab names cannot contain []*?/\: and are capped at 100 chars.
export function buildTemplateTabTitle(templateTitle) {
  const cleaned = sanitizeWhitespace(templateTitle).replace(/[[\]*?/\\:]/g, ' ').trim();
  const text = cleaned || 'Untitled';
  return text.length <= 100 ? text : text.slice(0, 100).trim();
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

async function ensureSpreadsheet() {
  const configured = sanitizeWhitespace(process.env.GOOGLE_TEMPLATES_SPREADSHEET_ID);
  const existing = configured || await getSetting(SETTING_ID);
  if (!existing) {
    throw new Error(
      'GOOGLE_TEMPLATES_SPREADSHEET_ID is not configured - create a Google ' +
      'Sheet, share it (Editor) with the service account, and set that env var'
    );
  }

  const { sheets } = await getSheetsDrive();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: existing,
    fields: 'spreadsheetId,spreadsheetUrl'
  });
  const spreadsheetUrl = meta.data.spreadsheetUrl ||
    `https://docs.google.com/spreadsheets/d/${existing}/edit`;
  await setSetting(SETTING_ID, existing);
  await setSetting(SETTING_URL, spreadsheetUrl);
  return { spreadsheetId: existing, spreadsheetUrl };
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
  return sheets;
}

async function ensureHeaders(sheets, spreadsheetId, tab, submittedData) {
  const headerRange = `'${escapeTab(tab)}'!1:1`;
  const current = await sheets.spreadsheets.values.get({ spreadsheetId, range: headerRange });
  const existingHeaders = Array.isArray(current.data.values?.[0]) ? current.data.values[0] : [];

  const dynamicHeaders = Object.keys(submittedData || {})
    .filter((key) => !FIXED_HEADERS.includes(key))
    .sort((a, b) => a.localeCompare(b));

  const mergedHeaders = existingHeaders.length > 0 ? [...existingHeaders] : [...FIXED_HEADERS];
  for (const header of existingHeaders.length > 0 ? FIXED_HEADERS.concat(dynamicHeaders) : dynamicHeaders) {
    if (!mergedHeaders.includes(header)) mergedHeaders.push(header);
  }

  const shouldWriteHeaders =
    existingHeaders.length === 0 ||
    mergedHeaders.length !== existingHeaders.length ||
    mergedHeaders.some((value, index) => value !== existingHeaders[index]);

  if (shouldWriteHeaders) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: headerRange,
      valueInputOption: 'RAW',
      requestBody: { values: [mergedHeaders] }
    });
  }

  return mergedHeaders;
}

export async function syncGeneratedPdfToGoogleSheets({ template, generatedPdf, submittedData, user }) {
  if (!isGoogleSheetsEnabled()) return null;

  const { spreadsheetId, spreadsheetUrl } = await ensureSpreadsheet();
  const tab = buildTemplateTabTitle(template.title);
  const sheets = await ensureTab(spreadsheetId, tab);
  const headers = await ensureHeaders(sheets, spreadsheetId, tab, submittedData);

  const rowMap = {
    record_id: generatedPdf.id,
    created_at: generatedPdf.created_at,
    user_id: user?.id || '',
    user_name: user?.name || '',
    user_email: user?.email || '',
    status: generatedPdf.status || 'pending',
    status_note: generatedPdf.status_note || '',
    reschedule_date: generatedPdf.reschedule_date || '',
    template_id: template.id,
    template_title: template.title,
    template_version: generatedPdf.template_version || template.version || 1,
    pdf_file_path: generatedPdf.file_path,
    ...(submittedData || {})
  };

  const values = headers.map((header) => normalizeCellValue(rowMap[header]));
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${escapeTab(tab)}'!A:A`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] }
  });

  return { spreadsheetId, spreadsheetUrl, tab };
}
