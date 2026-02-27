import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import { query, pool } from '../db.js';

dotenv.config();

async function run() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const schemaPath = path.resolve(__dirname, '../../sql/schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  await query(schemaSql);

  const email = process.env.SEED_SUPER_ADMIN_EMAIL;
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD;
  const name = process.env.SEED_SUPER_ADMIN_NAME || 'Super Admin';

  if (email && password) {
    const normalizedEmail = email.toLowerCase().trim();
    const existing = await query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);

    if (existing.rowCount === 0) {
      const id = uuidv4();
      const hash = await bcrypt.hash(password, 10);
      await query(
        'INSERT INTO users (id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5)',
        [id, name, normalizedEmail, hash, 'super_admin']
      );
      // eslint-disable-next-line no-console
      console.log(`Seeded super admin: ${normalizedEmail}`);
    }
  }
}

run()
  .then(async () => {
    await pool.end();
  })
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    await pool.end();
    process.exit(1);
  });