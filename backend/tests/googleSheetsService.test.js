import { describe, expect, it } from 'vitest';
import {
  buildMonthSheetTitle,
  buildSpreadsheetTitle,
  isGoogleSheetsEnabled
} from '../src/services/googleSheetsService.js';

describe('googleSheetsService helpers', () => {
  it('buildMonthSheetTitle returns YYYY-MM using UTC month', () => {
    const value = buildMonthSheetTitle(new Date('2026-03-16T10:30:00.000Z'));
    expect(value).toBe('2026-03');
  });

  it('buildSpreadsheetTitle prefixes and trims long template names', () => {
    const value = buildSpreadsheetTitle('A'.repeat(150));
    expect(value.startsWith('JOBorder - ')).toBe(true);
    expect(value.length).toBeLessThanOrEqual(100);
  });

  it('isGoogleSheetsEnabled returns false when credentials are absent', () => {
    const previousJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    const previousBase64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
    const previousEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const previousKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;

    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
    delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    delete process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;

    expect(isGoogleSheetsEnabled()).toBe(false);

    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = previousJson;
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 = previousBase64;
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = previousEmail;
    process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = previousKey;
  });
});
