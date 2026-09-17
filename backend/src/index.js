import dotenv from 'dotenv';
import app from './app.js';
import { ensureDbReady } from './bootstrap.js';
import { isGoogleSheetsEnabled, syncAllTemplateSpreadsheets } from './services/googleSheetsService.js';

dotenv.config();

if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set.');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL environment variable is not set.');
  process.exit(1);
}

const port = process.env.PORT || 8080;

// This integration has never actually succeeded in production (checked
// 2026-09-17: 0 of 6 templates have a linked spreadsheet). The failure is
// on Google's side, not this code - a service account has no Drive
// storage of its own, so spreadsheets.create needs either a Shared Drive
// or domain-wide delegation granted in Google Cloud Console, which is
// outside what this app can fix. Log the real cause once per distinct
// error instead of repeating the same line every sync interval forever,
// so a genuinely new problem doesn't get lost in old noise.
let lastGoogleSheetsSyncError = null;

async function syncGoogleSheetsTemplateState() {
  if (!isGoogleSheetsEnabled()) {
    return;
  }

  try {
    const result = await syncAllTemplateSpreadsheets();
    // eslint-disable-next-line no-console
    console.log(`Google Sheets sync complete for ${result.synced} template(s).`);
    lastGoogleSheetsSyncError = null;
  } catch (err) {
    if (err.message !== lastGoogleSheetsSyncError) {
      lastGoogleSheetsSyncError = err.message;
      // eslint-disable-next-line no-console
      console.error(
        `Google Sheets sync failed: ${err.message} ` +
        '(service account likely lacks Drive storage/permission - needs a ' +
        'fix in Google Cloud Console, not this app; will keep retrying ' +
        'quietly and only log again if the error changes)'
      );
    }
  }
}

async function start() {
  try {
    await ensureDbReady();
    await syncGoogleSheetsTemplateState();

    const syncIntervalMinutes = Math.max(1, Number(process.env.GOOGLE_SHEETS_SYNC_INTERVAL_MINUTES || 60));
    const interval = setInterval(syncGoogleSheetsTemplateState, syncIntervalMinutes * 60 * 1000);
    interval.unref?.();

    app.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`Server running on port ${port}`);
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Failed to start server: ${err.message}`);
    // Exit non-zero so the container restart policy (or nodemon --exitcrash in dev)
    // recycles the process instead of leaving a dead backend behind a live port.
    process.exitCode = 1;
    process.exit(1);
  }
}

start();
