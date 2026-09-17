import dotenv from 'dotenv';
import app from './app.js';
import { ensureDbReady } from './bootstrap.js';

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
    // Exit non-zero so the container restart policy (or nodemon --exitcrash in dev)
    // recycles the process instead of leaving a dead backend behind a live port.
    process.exitCode = 1;
    process.exit(1);
  }
}

start();
