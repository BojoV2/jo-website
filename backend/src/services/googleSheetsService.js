import { google } from 'googleapis';
import { query } from '../db.js';

const SPREADSHEET_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive'
];

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

let googleClientsPromise = null;

function sanitizeWhitespace(value) {
  return String(value || '').trim();
}

function normalizePrivateKey(value) {
  return sanitizeWhitespace(value).replace(/\\n/g, '\n');
}

function parseServiceAccountCredentials() {
  const rawJson = sanitizeWhitespace(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  if (rawJson) {
    return JSON.parse(rawJson);
  }

  const rawBase64 = sanitizeWhitespace(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64);
  if (rawBase64) {
    return JSON.parse(Buffer.from(rawBase64, 'base64').toString('utf8'));
  }

  const clientEmail = sanitizeWhitespace(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
  const privateKey = normalizePrivateKey(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);
  const projectId = sanitizeWhitespace(process.env.GOOGLE_PROJECT_ID);

  if (clientEmail && privateKey) {
    return {
      type: 'service_account',
      project_id: projectId || undefined,
      private_key: privateKey,
      client_email: clientEmail
    };
  }

  return null;
}

export function isGoogleSheetsEnabled() {
  try {
    return Boolean(parseServiceAccountCredentials());
  } catch (_err) {
    return false;
  }
}

async function getGoogleClients() {
  if (!googleClientsPromise) {
    googleClientsPromise = (async () => {
      const credentials = parseServiceAccountCredentials();
      if (!credentials) {
        throw new Error('Google Sheets credentials are not configured');
      }

      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: SPREADSHEET_SCOPES
      });

      return {
        sheets: google.sheets({ version: 'v4', auth }),
        drive: google.drive({ version: 'v3', auth })
      };
    })().catch((err) => {
      googleClientsPromise = null;
      throw err;
    });
  }

  return googleClientsPromise;
}

function truncateTitle(value, limit = 100) {
  const text = sanitizeWhitespace(value) || 'Untitled';
  return text.length <= limit ? text : text.slice(0, limit).trim();
}

export function buildMonthSheetTitle(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export function buildSpreadsheetTitle(templateTitle) {
  return truncateTitle(`JOBorder - ${sanitizeWhitespace(templateTitle) || 'Template'}`);
}

function escapeSheetTitle(sheetTitle) {
  return String(sheetTitle).replace(/'/g, "''");
}

function normalizeCellValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
}

async function shareSpreadsheetIfConfigured(drive, spreadsheetId) {
  const shareEmail = sanitizeWhitespace(process.env.GOOGLE_SHEETS_SHARE_EMAIL);
  if (!shareEmail) return;

  try {
    await drive.permissions.create({
      fileId: spreadsheetId,
      sendNotificationEmail: false,
      requestBody: {
        type: 'user',
        role: 'writer',
        emailAddress: shareEmail
      }
    });
  } catch (err) {
    const message = String(err?.message || '');
    if (!message.includes('already') && !message.includes('duplicate')) {
      throw err;
    }
  }
}

async function createSpreadsheetForTemplate({ title, description }) {
  const { sheets, drive } = await getGoogleClients();
  const monthSheetTitle = buildMonthSheetTitle();
  const response = await sheets.spreadsheets.create({
    requestBody: {
      properties: {
        title: buildSpreadsheetTitle(title)
      },
      sheets: [
        {
          properties: {
            title: monthSheetTitle,
            gridProperties: {
              frozenRowCount: 1
            }
          }
        }
      ]
    },
    fields: 'spreadsheetId,spreadsheetUrl'
  });

  const spreadsheetId = response.data.spreadsheetId;
  if (!spreadsheetId) {
    throw new Error('Google Sheets did not return a spreadsheetId');
  }

  await shareSpreadsheetIfConfigured(drive, spreadsheetId);

  return {
    spreadsheetId,
    spreadsheetUrl: response.data.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    monthSheetTitle,
    description
  };
}

async function getSpreadsheetMetadata(spreadsheetId) {
  const { sheets } = await getGoogleClients();
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'spreadsheetId,spreadsheetUrl,sheets.properties'
  });
  return response.data;
}

async function ensureMonthlyWorksheet(spreadsheetId, monthSheetTitle) {
  const { sheets } = await getGoogleClients();
  const metadata = await getSpreadsheetMetadata(spreadsheetId);
  const exists = (metadata.sheets || []).some((sheet) => sheet.properties?.title === monthSheetTitle);

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: monthSheetTitle,
                gridProperties: {
                  frozenRowCount: 1
                }
              }
            }
          }
        ]
      }
    });
  }

  return metadata.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

async function getExistingHeaders(spreadsheetId, monthSheetTitle) {
  const { sheets } = await getGoogleClients();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${escapeSheetTitle(monthSheetTitle)}'!1:1`
  });

  return Array.isArray(response.data.values?.[0]) ? response.data.values[0] : [];
}

async function ensureHeaders(spreadsheetId, monthSheetTitle, submittedData) {
  const { sheets } = await getGoogleClients();
  const existingHeaders = await getExistingHeaders(spreadsheetId, monthSheetTitle);
  const dynamicHeaders = Object.keys(submittedData || {})
    .filter((key) => !FIXED_HEADERS.includes(key))
    .sort((a, b) => a.localeCompare(b));

  const mergedHeaders = existingHeaders.length > 0 ? [...existingHeaders] : [...FIXED_HEADERS];

  if (existingHeaders.length === 0) {
    for (const header of dynamicHeaders) {
      if (!mergedHeaders.includes(header)) {
        mergedHeaders.push(header);
      }
    }
  } else {
    for (const header of FIXED_HEADERS) {
      if (!mergedHeaders.includes(header)) {
        mergedHeaders.push(header);
      }
    }
    for (const header of dynamicHeaders) {
      if (!mergedHeaders.includes(header)) {
        mergedHeaders.push(header);
      }
    }
  }

  const shouldWriteHeaders =
    existingHeaders.length === 0 ||
    mergedHeaders.length !== existingHeaders.length ||
    mergedHeaders.some((value, index) => value !== existingHeaders[index]);

  if (shouldWriteHeaders) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${escapeSheetTitle(monthSheetTitle)}'!1:1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [mergedHeaders]
      }
    });
  }

  return mergedHeaders;
}

export async function ensureTemplateSpreadsheet(template) {
  if (!isGoogleSheetsEnabled()) {
    return null;
  }

  if (template.google_spreadsheet_id) {
    try {
      const spreadsheetUrl = await ensureMonthlyWorksheet(template.google_spreadsheet_id, buildMonthSheetTitle());
      return {
        spreadsheetId: template.google_spreadsheet_id,
        spreadsheetUrl
      };
    } catch (err) {
      const message = String(err?.message || '');
      if (!message.includes('Requested entity was not found') && !message.includes('not found')) {
        throw err;
      }
    }
  }

  return createSpreadsheetForTemplate({
    title: template.title,
    description: template.description
  });
}

export async function syncGeneratedPdfToGoogleSheets({
  template,
  generatedPdf,
  submittedData,
  user
}) {
  if (!isGoogleSheetsEnabled()) {
    return null;
  }

  const syncTarget = await ensureTemplateSpreadsheet(template);
  const spreadsheetId = syncTarget?.spreadsheetId;
  if (!spreadsheetId) {
    throw new Error('Google Spreadsheet is not available for template sync');
  }

  const monthSheetTitle = buildMonthSheetTitle(generatedPdf.created_at ? new Date(generatedPdf.created_at) : new Date());
  await ensureMonthlyWorksheet(spreadsheetId, monthSheetTitle);
  const headers = await ensureHeaders(spreadsheetId, monthSheetTitle, submittedData);

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
  const { sheets } = await getGoogleClients();
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${escapeSheetTitle(monthSheetTitle)}'!A:A`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [values]
    }
  });

  return {
    spreadsheetId,
    spreadsheetUrl: syncTarget.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    monthSheetTitle
  };
}

export async function syncAllTemplateSpreadsheets() {
  if (!isGoogleSheetsEnabled()) {
    return { synced: 0, skipped: true };
  }

  const templates = await query(
    `SELECT id, title, description, version, google_spreadsheet_id, google_spreadsheet_url
     FROM pdf_templates
     ORDER BY created_at ASC`
  );

  let synced = 0;
  for (const template of templates.rows) {
    const result = await ensureTemplateSpreadsheet(template);
    if (
      result?.spreadsheetId &&
      (
        result.spreadsheetId !== template.google_spreadsheet_id ||
        (result.spreadsheetUrl || null) !== (template.google_spreadsheet_url || null)
      )
    ) {
      await query(
        `UPDATE pdf_templates
         SET google_spreadsheet_id = $1,
             google_spreadsheet_url = $2
         WHERE id = $3`,
        [result.spreadsheetId, result.spreadsheetUrl || null, template.id]
      );
    }
    synced += 1;
  }

  return { synced, skipped: false };
}
