/**
 * Google service-account helper for the ticketing feature.
 *
 * Intentionally standalone (does not import googleSheetsService.js) so the
 * existing, working PDF->Sheets sync is never disturbed. Reuses the SAME
 * service-account credentials from the environment.
 *
 * Env:
 *   GOOGLE_SERVICE_ACCOUNT_JSON            full JSON (string), OR
 *   GOOGLE_SERVICE_ACCOUNT_JSON_BASE64     base64 of the JSON, OR
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL           + GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY (+ GOOGLE_PROJECT_ID)
 *   GMAIL_SENDER                           Workspace user to send mail as (domain-wide delegation)
 */
import { google } from 'googleapis';

const SHEETS_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive'
];
const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.send'];

function trimmed(value) {
  return String(value || '').trim();
}

function normalizePrivateKey(value) {
  return trimmed(value).replace(/\\n/g, '\n');
}

export function parseServiceAccountCredentials() {
  const rawJson = trimmed(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  if (rawJson) {
    return JSON.parse(rawJson);
  }

  const rawBase64 = trimmed(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64);
  if (rawBase64) {
    return JSON.parse(Buffer.from(rawBase64, 'base64').toString('utf8'));
  }

  const clientEmail = trimmed(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
  const privateKey = normalizePrivateKey(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);
  const projectId = trimmed(process.env.GOOGLE_PROJECT_ID);

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

export function isServiceAccountConfigured() {
  try {
    return Boolean(parseServiceAccountCredentials());
  } catch (_err) {
    return false;
  }
}

let sheetsDrivePromise = null;

export async function getSheetsDrive() {
  if (!sheetsDrivePromise) {
    sheetsDrivePromise = (async () => {
      const credentials = parseServiceAccountCredentials();
      if (!credentials) {
        throw new Error('Google service-account credentials are not configured');
      }
      const auth = new google.auth.GoogleAuth({ credentials, scopes: SHEETS_SCOPES });
      return {
        sheets: google.sheets({ version: 'v4', auth }),
        drive: google.drive({ version: 'v3', auth })
      };
    })().catch((err) => {
      sheetsDrivePromise = null;
      throw err;
    });
  }
  return sheetsDrivePromise;
}

/**
 * Gmail client that impersonates `subject` via domain-wide delegation.
 * Requires the service account to be authorised for gmail.send on the Workspace
 * domain, and `subject` to be a real mailbox in that domain.
 */
export function getGmailClient(subject) {
  const credentials = parseServiceAccountCredentials();
  if (!credentials) {
    throw new Error('Google service-account credentials are not configured');
  }
  if (!subject) {
    throw new Error('GMAIL_SENDER is not configured');
  }
  const jwt = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: GMAIL_SCOPES,
    subject
  });
  return google.gmail({ version: 'v1', auth: jwt });
}

export const gmailSender = () => trimmed(process.env.GMAIL_SENDER);
