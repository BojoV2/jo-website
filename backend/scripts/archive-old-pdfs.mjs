// Monthly archival: gzip+encrypt generated PDFs whose month has fully
// ended, verify the round-trip byte-for-byte BEFORE deleting the plaintext,
// then flip archived=true. Never touches the current month's files.
//
// Run via cron on the host: docker exec pdf_workflow_backend node scripts/archive-old-pdfs.mjs

import fs from 'fs';
import path from 'path';
import { query, pool } from '../src/db.js';
import { archiveFile, restoreFileToBuffer } from '../src/services/archiveCrypto.js';

const storageRoot = process.env.STORAGE_ROOT || path.resolve(process.cwd(), '../storage');

async function main() {
  // Optional cap for a controlled first run / spot-check batch - unset
  // (the normal cron invocation) processes everything eligible.
  const limit = process.env.BATCH_LIMIT ? Number(process.env.BATCH_LIMIT) : null;
  const { rows } = await query(
    `SELECT id, file_path FROM generated_pdfs
      WHERE archived = false AND created_at < date_trunc('month', now())
      ORDER BY created_at ASC
      ${limit ? 'LIMIT $1' : ''}`,
    limit ? [limit] : []
  );

  console.log(`archive-old-pdfs: ${rows.length} candidate(s)`);
  let archived = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const plainPath = path.join(storageRoot, row.file_path);
    const encPath = plainPath + '.gz.enc';

    if (!fs.existsSync(plainPath)) {
      console.warn(`  ${row.id}: plaintext missing at ${plainPath}, skipping`);
      skipped += 1;
      continue;
    }

    try {
      const original = fs.readFileSync(plainPath);
      archiveFile(plainPath, encPath);

      const restored = restoreFileToBuffer(encPath);
      if (!restored.equals(original)) {
        throw new Error('round-trip verification mismatch');
      }

      fs.unlinkSync(plainPath);
      await query('UPDATE generated_pdfs SET archived = true WHERE id = $1', [row.id]);
      archived += 1;
    } catch (err) {
      console.error(`  ${row.id}: FAILED (${err.message}) - plaintext left in place, not marked archived`);
      // Clean up a bad .enc so the next run tries fresh, never leaves a
      // half-written archive that a later manual recovery might trust.
      fs.unlink(encPath, () => {});
      failed += 1;
    }
  }

  console.log(`archive-old-pdfs: done - archived=${archived} skipped=${skipped} failed=${failed}`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('archive-old-pdfs: FATAL', err);
  process.exit(1);
});
