import { query } from '../db.js';

// Section keys switch a whole group off; app keys switch off one card.
export const SECTION_KEYS = ['pdf_creation', 'applications', 'tools'];
export const APP_KEYS = [
  'create', 'templates', 'my-pdfs',
  'analytics', 'profiling', 'fieldeng', 'macfinder',
  'tool-client-lookup', 'tool-adjustment', 'tool-calculator', 'tool-contract', 'tool-discount',
  'tool-auto-reply', 'tool-link-to-qr', 'tool-imperial-tracking', 'tool-ticketing',
];
export const PERMISSION_KEYS = [...SECTION_KEYS, ...APP_KEYS];

export function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (fwd || req.ip || '').replace(/^::ffff:/, '').slice(0, 64);
}

// Best-effort: an audit write must never break the action it records.
export async function logAccount(req, { action, actor = req.user, targetName = null, detail = null }) {
  try {
    await query(
      `INSERT INTO account_audit (action, actor_id, actor_name, target_name, detail, ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [action, actor?.id || null, actor?.name || null, targetName, detail, clientIp(req)]
    );
  } catch (_err) {
    // audit table missing or DB hiccup - the action itself already succeeded
  }
}
