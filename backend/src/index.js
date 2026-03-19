import dotenv from 'dotenv';
import app from './app.js';
import { ensureDbReady } from './bootstrap.js';
import { isGoogleSheetsEnabled, syncAllTemplateSpreadsheets } from './services/googleSheetsService.js';

dotenv.config();

const port = process.env.PORT || 8080;

async function syncGoogleSheetsTemplateState() {
  if (!isGoogleSheetsEnabled()) {
    return;
  }

  try {
    const result = await syncAllTemplateSpreadsheets();
    // eslint-disable-next-line no-console
    console.log(`Google Sheets sync complete for ${result.synced} template(s).`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Google Sheets sync failed: ${err.message}`);
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
    process.exit(1);
  }
}

start();
