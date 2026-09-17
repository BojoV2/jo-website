import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Bounded explicitly: the pg default of 0 (wait forever) for
  // connectionTimeoutMillis means a request queues silently instead of
  // failing fast if the pool is ever exhausted or Postgres is unreachable.
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
  // Idle clients can be dropped when Postgres restarts; keep the API process alive.
  console.error(`Unexpected idle database client error: ${err.message}`);
});

export async function query(text, params = []) {
  const result = await pool.query(text, params);
  return result;
}
