import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

pool.on('error', (err) => {
  // Idle clients can be dropped when Postgres restarts; keep the API process alive.
  console.error(`Unexpected idle database client error: ${err.message}`);
});

export async function query(text, params = []) {
  const result = await pool.query(text, params);
  return result;
}
