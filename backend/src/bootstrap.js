import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { query } from './db.js';

let readyPromise = null;

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function applySchemaAndSeed() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const schemaPath = path.resolve(__dirname, '../sql/schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  await query(schemaSql);

  const email = String(process.env.SEED_SUPER_ADMIN_EMAIL || '').toLowerCase().trim();
  const password = String(process.env.SEED_SUPER_ADMIN_PASSWORD || '');
  const name = String(process.env.SEED_SUPER_ADMIN_NAME || 'Super Admin').trim() || 'Super Admin';

  if (!email || !password) {
    return;
  }

  const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rowCount > 0) {
    return;
  }

  const id = uuidv4();
  const hash = await bcrypt.hash(password, 10);
  await query(
    'INSERT INTO users (id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5)',
    [id, name, email, hash, 'super_admin']
  );
}

export async function ensureDbReady(options = {}) {
  const retries = Number(options.retries ?? process.env.DB_BOOT_RETRIES ?? 15);
  const delayMs = Number(options.delay_ms ?? process.env.DB_BOOT_DELAY_MS ?? 2000);

  if (!readyPromise) {
    readyPromise = (async () => {
      let lastError = null;

      for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
          await applySchemaAndSeed();
          return;
        } catch (err) {
          lastError = err;
          if (attempt >= retries) {
            break;
          }
          // eslint-disable-next-line no-console
          console.warn(`Database bootstrap attempt ${attempt}/${retries} failed: ${err.message}`);
          await wait(delayMs);
        }
      }

      throw lastError;
    })();
  }

  try {
    await readyPromise;
  } catch (err) {
    readyPromise = null;
    throw err;
  }
}
