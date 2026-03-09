import dotenv from 'dotenv';
import app from './app.js';
import { ensureDbReady } from './bootstrap.js';

dotenv.config();

const port = process.env.PORT || 8080;

async function start() {
  try {
    await ensureDbReady();
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
