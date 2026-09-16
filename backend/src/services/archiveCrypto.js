// Compress + encrypt at-rest storage for old generated PDFs.
//
// Reuses the SAME passphrase jo-backup.sh already uses for nightly off-box
// backups of this exact data (/home/jo-ssh/.jo-backup-pass on the host,
// bind-mounted read-only into this container) - no new secret to manage.
// Implemented with Node's own crypto/zlib rather than shelling out to
// openssl/gzip: this file format is only ever read by this same code, so
// there's no need to match the bash script's own on-disk format, and
// staying in-process avoids adding any CLI tool to the container image.
//
// File format for a <name>.gz.enc: salt(16) | iv(16) | authTag(16) | ciphertext
// AES-256-GCM: authenticated, so a corrupted/tampered archive fails to
// decrypt loudly instead of silently returning garbage.

import fs from 'fs';
import zlib from 'zlib';
import crypto from 'crypto';
import os from 'os';
import path from 'path';

const PASS_FILE = process.env.JO_BACKUP_PASS_FILE || '/run/secrets/jo-backup-pass';
const KDF_ITER = 200000;
const KEY_LEN = 32; // AES-256

let cachedPassphrase = null;
function getPassphrase() {
  if (cachedPassphrase) return cachedPassphrase;
  cachedPassphrase = fs.readFileSync(PASS_FILE, 'utf8').trim();
  return cachedPassphrase;
}

function deriveKey(salt) {
  return crypto.pbkdf2Sync(getPassphrase(), salt, KDF_ITER, KEY_LEN, 'sha256');
}

// Compresses + encrypts plainPath into outPath. Does NOT touch plainPath -
// caller decides when it's safe to delete the original, after verifying.
export function archiveFile(plainPath, outPath) {
  const plain = fs.readFileSync(plainPath);
  const gzipped = zlib.gzipSync(plain);

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const key = deriveKey(salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(gzipped), cipher.final()]);
  const authTag = cipher.getAuthTag();

  fs.writeFileSync(outPath, Buffer.concat([salt, iv, authTag, ciphertext]));
}

// Reverses archiveFile - returns the original plaintext bytes.
export function restoreFileToBuffer(encPath) {
  const data = fs.readFileSync(encPath);
  const salt = data.subarray(0, 16);
  const iv = data.subarray(16, 32);
  const authTag = data.subarray(32, 48);
  const ciphertext = data.subarray(48);

  const key = deriveKey(salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const gzipped = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return zlib.gunzipSync(gzipped);
}

// Decrypts to a short-lived temp file (some downstream code, like
// buildMergedPdf, needs a real path rather than a Buffer). Caller MUST call
// the returned cleanup() when done - on every response path, success or
// error, so nothing decrypted lingers on disk.
export function restoreFileToTemp(encPath, suffix = '.pdf') {
  const buf = restoreFileToBuffer(encPath);
  const tmpPath = path.join(os.tmpdir(), `jo-archive-${crypto.randomUUID()}${suffix}`);
  fs.writeFileSync(tmpPath, buf);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    fs.unlink(tmpPath, () => {});
  };
  return { path: tmpPath, cleanup };
}
