import { describe, expect, it } from 'vitest';
import {
  buildTemplateTabTitle,
  isGoogleSheetsEnabled
} from '../src/services/googleSheetsService.js';

describe('googleSheetsService helpers', () => {
  it('buildTemplateTabTitle strips characters Sheets forbids in tab names and trims long titles', () => {
    const value = buildTemplateTabTitle('A'.repeat(150) + '[weird]/name');
    expect(value).not.toMatch(/[[\]/]/);
    expect(value.length).toBeLessThanOrEqual(100);
  });

  it('buildTemplateTabTitle falls back to Untitled for empty input', () => {
    expect(buildTemplateTabTitle('   ')).toBe('Untitled');
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
