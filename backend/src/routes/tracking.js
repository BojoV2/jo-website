import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getVehicleData, invalidateSession } from '../services/aikaService.js';

const router = express.Router();

// Columns returned to admin — password is intentionally excluded
const ADMIN_SELECT = `id, name, base_url, api_url, username, login_mode, device_id,
  CASE WHEN password IS NOT NULL AND password <> '' THEN true ELSE false END AS has_password,
  enabled, notes, refresh_interval_seconds,
  last_sync_at, sync_status, sync_error, created_by, created_at, updated_at`;

// ── Admin: list all tracker configs ──────────────────────────────
router.get('/admin', requireAuth, requireRole('super_admin', 'admin'), async (_req, res) => {
  try {
    const result = await query(
      `SELECT ${ADMIN_SELECT} FROM tracker_settings ORDER BY created_at ASC`
    );
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Admin: create tracker config ──────────────────────────────────
router.post('/', requireAuth, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { name, base_url, api_url, username, password, enabled, notes, refresh_interval_seconds, login_mode, device_id } = req.body;
    if (!name || !base_url) {
      return res.status(400).json({ error: 'name and base_url are required' });
    }
    const id = uuidv4();
    await query(
      `INSERT INTO tracker_settings
         (id, name, base_url, api_url, username, password, enabled, notes, refresh_interval_seconds, login_mode, device_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [id, name.trim(), base_url.trim(), api_url?.trim() || null,
       username?.trim() || null, password || null, enabled !== false,
       notes?.trim() || null, parseInt(refresh_interval_seconds) || 60,
       login_mode || 'account', device_id?.trim() || null,
       req.user.id]
    );
    const result = await query(`SELECT ${ADMIN_SELECT} FROM tracker_settings WHERE id = $1`, [id]);
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Admin: update tracker config ──────────────────────────────────
router.put('/:id', requireAuth, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { name, base_url, api_url, username, password, enabled, notes, refresh_interval_seconds, login_mode, device_id } = req.body;
    if (!name || !base_url) {
      return res.status(400).json({ error: 'name and base_url are required' });
    }

    // Build parameterised update — only include password if a new value was given
    const sets   = ['name=$1', 'base_url=$2', 'api_url=$3', 'username=$4', 'enabled=$5',
                    'notes=$6', 'refresh_interval_seconds=$7', 'login_mode=$8', 'device_id=$9', 'updated_at=NOW()'];
    const params = [name.trim(), base_url.trim(), api_url?.trim() || null,
                    username?.trim() || null, enabled !== false,
                    notes?.trim() || null, parseInt(refresh_interval_seconds) || 60,
                    login_mode || 'account', device_id?.trim() || null];

    if (password) {
      sets.push(`password=$${params.length + 1}`);
      params.push(password);
      invalidateSession(req.params.id);
    }

    params.push(req.params.id);
    const idPlaceholder = `$${params.length}`;

    const upd = await query(
      `UPDATE tracker_settings SET ${sets.join(', ')} WHERE id = ${idPlaceholder} RETURNING id`,
      params
    );
    if (upd.rowCount === 0) return res.status(404).json({ error: 'Tracker not found' });

    const result = await query(`SELECT ${ADMIN_SELECT} FROM tracker_settings WHERE id = $1`, [req.params.id]);
    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Admin: delete tracker config ──────────────────────────────────
router.delete('/:id', requireAuth, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM tracker_settings WHERE id = $1 RETURNING id', [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Tracker not found' });
    invalidateSession(req.params.id);
    return res.status(204).send();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Admin: force sync ────────────────────────────────────────────
router.post('/:id/sync', requireAuth, requireRole('super_admin', 'admin'), async (req, res) => {
  return syncTracker(req.params.id, res);
});

// ── Shared sync logic ─────────────────────────────────────────────
async function syncTracker(trackerId, res) {
  try {
    const cfg = await query(
      'SELECT id, base_url, api_url, username, password, enabled, login_mode, device_id FROM tracker_settings WHERE id = $1',
      [trackerId]
    );
    if (cfg.rowCount === 0) return res.status(404).json({ error: 'Tracker not found' });

    const tracker = cfg.rows[0];
    if (!tracker.enabled) return res.status(403).json({ error: 'Tracker is disabled' });
    const isDeviceMode = tracker.login_mode === 'device';
    const hasIdentifier = isDeviceMode ? !!tracker.device_id : !!tracker.username;
    if (!hasIdentifier || !tracker.password) {
      return res.status(422).json({ error: 'Tracker credentials not configured' });
    }

    const { source, vehicles } = await getVehicleData(trackerId, tracker);

    await query(
      `UPDATE tracker_settings
         SET cached_vehicles = $1, last_sync_at = NOW(), sync_status = 'success', sync_error = NULL
       WHERE id = $2`,
      [JSON.stringify(vehicles), trackerId]
    );

    return res ? res.json({ vehicles, source, synced_at: new Date().toISOString() }) : { vehicles, source };
  } catch (err) {
    await query(
      `UPDATE tracker_settings
         SET sync_status = 'error', sync_error = $1, last_sync_at = NOW()
       WHERE id = $2`,
      [err.message, trackerId]
    ).catch(() => {});

    if (res) return res.status(502).json({ error: err.message });
    throw err;
  }
}

// ── User: list enabled trackers (safe — no credentials, no URL) ──
router.get('/status', requireAuth, async (_req, res) => {
  try {
    const result = await query(
      `SELECT id, name, notes, enabled, sync_status, last_sync_at
         FROM tracker_settings WHERE enabled = true ORDER BY created_at ASC`
    );
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── User: get vehicle data (from cache, sync if stale) ────────────
router.get('/:id/vehicles', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, enabled, username, password, base_url, api_url, login_mode, device_id,
              cached_vehicles, last_sync_at, sync_status, sync_error,
              refresh_interval_seconds
         FROM tracker_settings WHERE id = $1`,
      [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Tracker not found' });

    const t = result.rows[0];
    if (!t.enabled) return res.status(403).json({ error: 'Tracker is currently disabled' });
    const isDeviceMode = t.login_mode === 'device';
    const hasIdentifier = isDeviceMode ? !!t.device_id : !!t.username;
    if (!hasIdentifier || !t.password) {
      return res.status(422).json({ error: 'Tracker credentials not configured' });
    }

    // Serve cached data if it is fresh enough
    const intervalMs = (t.refresh_interval_seconds || 60) * 1000;
    const lastSync   = t.last_sync_at ? new Date(t.last_sync_at).getTime() : 0;
    const isFresh    = Date.now() - lastSync < intervalMs;

    if (isFresh && t.cached_vehicles && t.sync_status === 'success') {
      return res.json({
        vehicles:  t.cached_vehicles,
        synced_at: t.last_sync_at,
        cached:    true,
      });
    }

    // Data is stale — trigger sync inline
    try {
      const { source, vehicles } = await getVehicleData(req.params.id, t);
      await query(
        `UPDATE tracker_settings
           SET cached_vehicles = $1, last_sync_at = NOW(), sync_status = 'success', sync_error = NULL
         WHERE id = $2`,
        [JSON.stringify(vehicles), req.params.id]
      );
      return res.json({ vehicles, source, synced_at: new Date().toISOString(), cached: false });
    } catch (syncErr) {
      await query(
        `UPDATE tracker_settings SET sync_status='error', sync_error=$1, last_sync_at=NOW() WHERE id=$2`,
        [syncErr.message, req.params.id]
      ).catch(() => {});

      // Return stale cache if we have it, with error flag
      if (t.cached_vehicles) {
        return res.json({
          vehicles:  t.cached_vehicles,
          synced_at: t.last_sync_at,
          cached:    true,
          sync_error: syncErr.message,
        });
      }
      return res.status(502).json({ error: syncErr.message });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── User: secure launch (legacy — opens portal in new tab) ────────
router.post('/:id/launch', requireAuth, async (req, res) => {
  try {
    const result = await query(
      'SELECT base_url, enabled FROM tracker_settings WHERE id = $1', [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Tracker not found' });
    const { base_url, enabled } = result.rows[0];
    if (!enabled) return res.status(403).json({ error: 'Tracker is currently disabled' });
    return res.json({ url: base_url });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
