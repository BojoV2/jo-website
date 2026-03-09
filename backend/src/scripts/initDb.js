import dotenv from 'dotenv';
import { pool } from '../db.js';
import { ensureDbReady } from '../bootstrap.js';

dotenv.config();

ensureDbReady({ retries: 1 })
  .then(async () => {
    await pool.end();
  })
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    await pool.end();
    process.exit(1);
  });
