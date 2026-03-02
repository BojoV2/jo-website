import express from 'express';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { generatePdfFromTemplate } from '../services/pdfService.js';

const router = express.Router();

const storageRoot = process.env.STORAGE_ROOT || path.resolve(process.cwd(), '../storage');
const generatedDir = path.join(storageRoot, 'generated');
fs.mkdirSync(generatedDir, { recursive: true });

const allowedStatus = ['pending', 'done', 'cancelled', 'rescheduled'];

function normalizeSubmittedData(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed ? parsed : {};
    } catch (_err) {
      return {};
    }
  }
  return {};
}

function csvEscape(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (str.includes('"') || str.includes(',') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function parseDateStart(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseDateEnd(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(23, 59, 59, 999);
  return d;
}

function normalizeValidationRules(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw;
}

function isConditionMet(payload, requiredIf) {
  if (!requiredIf || typeof requiredIf !== 'object') return false;
  const field = String(requiredIf.field || '').trim();
  if (!field) return false;
  return String(payload[field] ?? '') === String(requiredIf.equals ?? '');
}

function validateFieldValue(field, value) {
  const rules = normalizeValidationRules(field.validation_rules);
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const strValue = String(value);
  if (rules.min_length !== undefined && strValue.length < Number(rules.min_length)) {
    return `Field ${field.field_name} must be at least ${rules.min_length} characters`;
  }
  if (rules.max_length !== undefined && strValue.length > Number(rules.max_length)) {
    return `Field ${field.field_name} must be at most ${rules.max_length} characters`;
  }
  if (rules.regex) {
    try {
      const re = new RegExp(String(rules.regex));
      if (!re.test(strValue)) {
        return `Field ${field.field_name} format is invalid`;
      }
    } catch (_err) {
      return `Field ${field.field_name} has invalid regex rule`;
    }
  }
  return null;
}

router.post('/generate', requireAuth, async (req, res) => {
  try {
    const { template_id, submitted_data } = req.body;

    if (!template_id || !submitted_data || typeof submitted_data !== 'object') {
      return res.status(400).json({ error: 'template_id and submitted_data(object) are required' });
    }

    const templateResult = await query('SELECT id, file_path, version FROM pdf_templates WHERE id = $1', [template_id]);
    if (templateResult.rowCount === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const fieldsResult = await query(
      `SELECT id, field_name, field_type, validation_rules, page_number, x_position, y_position, box_width, box_height, font_size, auto_font, required
       FROM pdf_fields
       WHERE template_id = $1
       ORDER BY created_at ASC`,
      [template_id]
    );

    for (const field of fieldsResult.rows) {
      const fieldValue = submitted_data[field.field_name];
      const rules = normalizeValidationRules(field.validation_rules);
      const mustRequire = field.required || isConditionMet(submitted_data, rules.required_if);
      if (mustRequire && (fieldValue === undefined || fieldValue === null || fieldValue === '')) {
        return res.status(400).json({ error: `Required field missing: ${field.field_name}` });
      }

      const validationError = validateFieldValue(field, fieldValue);
      if (validationError) {
        return res.status(400).json({ error: validationError });
      }
    }

    const templatePath = path.join(storageRoot, templateResult.rows[0].file_path);
    if (!fs.existsSync(templatePath)) {
      return res.status(500).json({ error: 'Template file is missing from storage' });
    }

    const generatedId = uuidv4();
    const outputName = `${req.user.id}_${template_id}_${Date.now()}.pdf`;
    const outputRelativePath = path.join('generated', outputName);
    const outputAbsolutePath = path.join(storageRoot, outputRelativePath);

    await generatePdfFromTemplate({
      templatePath,
      fields: fieldsResult.rows,
      payload: submitted_data,
      outputPath: outputAbsolutePath
    });

    await query(
      `INSERT INTO generated_pdfs
      (id, template_id, template_version, user_id, file_path, submitted_data, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [generatedId, template_id, Number(templateResult.rows[0].version || 1), req.user.id, outputRelativePath, JSON.stringify(submitted_data)]
    );

    await query(
      `INSERT INTO status_history (id, generated_pdf_id, old_status, new_status, changed_by, note)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uuidv4(), generatedId, null, 'pending', req.user.id, 'PDF generated']
    );

    return res.status(201).json({
      id: generatedId,
      template_id,
      user_id: req.user.id,
      file_path: outputRelativePath,
      status: 'pending'
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/', requireAuth, async (req, res) => {
  try {
    const { template_id, status, user_id, keyword, date_from, date_to } = req.query;
    const params = [];
    const where = [];

    if (template_id) {
      params.push(template_id);
      where.push(`g.template_id = $${params.length}`);
    }

    if (status) {
      if (!allowedStatus.includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      params.push(status);
      where.push(`g.status = $${params.length}`);
    }

    const fromDate = parseDateStart(date_from);
    if (date_from && !fromDate) {
      return res.status(400).json({ error: 'Invalid date_from' });
    }
    if (fromDate) {
      params.push(fromDate.toISOString());
      where.push(`g.created_at >= $${params.length}`);
    }

    const toDate = parseDateEnd(date_to);
    if (date_to && !toDate) {
      return res.status(400).json({ error: 'Invalid date_to' });
    }
    if (toDate) {
      params.push(toDate.toISOString());
      where.push(`g.created_at <= $${params.length}`);
    }

    if (keyword) {
      params.push(`%${String(keyword).trim()}%`);
      where.push(`(g.id::text ILIKE $${params.length} OR g.submitted_data::text ILIKE $${params.length} OR t.title ILIKE $${params.length} OR COALESCE(u.name,'') ILIKE $${params.length})`);
    }

    if (user_id) {
      params.push(user_id);
      where.push(`g.user_id = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const result = await query(
      `SELECT g.id, g.template_id, g.user_id, g.file_path, g.submitted_data, g.status, g.status_note, g.reschedule_date, g.created_at, g.updated_at,
              t.title AS template_title,
              u.name AS user_name
       FROM generated_pdfs g
       LEFT JOIN pdf_templates t ON t.id = g.template_id
       LEFT JOIN users u ON u.id = g.user_id
       ${whereSql}
       ORDER BY g.created_at DESC`,
      params
    );

    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/analytics/template/:templateId', requireAuth, async (req, res) => {
  try {
    const { templateId } = req.params;
    const params = [templateId];
    const where = ['template_id = $1'];

    if (req.user.role === 'user') {
      params.push(req.user.id);
      where.push(`user_id = $${params.length}`);
    }

    const baseWhere = where.join(' AND ');
    const summary = await query(
      `SELECT
          COUNT(*)::int AS total_generated,
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_backlog,
          COUNT(*) FILTER (WHERE status = 'done')::int AS done_count,
          COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_count,
          COUNT(*) FILTER (WHERE status = 'rescheduled')::int AS rescheduled_count,
          COALESCE(AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) FILTER (WHERE status = 'done'), 0) AS avg_processing_seconds,
          CASE WHEN COUNT(*) = 0 THEN 0
               ELSE (COUNT(*) FILTER (WHERE status = 'cancelled')::float / COUNT(*)::float) * 100
          END AS cancellation_rate
       FROM generated_pdfs
       WHERE ${baseWhere}`,
      params
    );

    return res.json({
      template_id: templateId,
      ...summary.rows[0]
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/analytics/templates', requireAuth, async (req, res) => {
  try {
    const params = [];
    const userFilter = req.user.role === 'user'
      ? 'WHERE g.user_id = $1'
      : '';
    if (req.user.role === 'user') {
      params.push(req.user.id);
    }

    const result = await query(
      `SELECT
          g.template_id,
          COALESCE(t.title, 'Unknown Template') AS template_title,
          COUNT(*)::int AS total_generated,
          COUNT(*) FILTER (WHERE g.status = 'pending')::int AS pending_backlog,
          COALESCE(AVG(EXTRACT(EPOCH FROM (g.updated_at - g.created_at))) FILTER (WHERE g.status = 'done'), 0) AS avg_processing_seconds,
          CASE WHEN COUNT(*) = 0 THEN 0
               ELSE (COUNT(*) FILTER (WHERE g.status = 'cancelled')::float / COUNT(*)::float) * 100
          END AS cancellation_rate
       FROM generated_pdfs g
       LEFT JOIN pdf_templates t ON t.id = g.template_id
       ${userFilter}
       GROUP BY g.template_id, t.title
       ORDER BY total_generated DESC`,
      params
    );

    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/export', requireAuth, async (req, res) => {
  try {
    const { template_id, status, format = 'csv' } = req.query;

    if (!template_id) {
      return res.status(400).json({ error: 'template_id is required' });
    }
    if (status && !allowedStatus.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    if (!['csv', 'json'].includes(format)) {
      return res.status(400).json({ error: 'format must be csv or json' });
    }

    const params = [template_id];
    const where = ['g.template_id = $1'];

    if (status) {
      params.push(status);
      where.push(`g.status = $${params.length}`);
    }

    if (req.user.role === 'user') {
      params.push(req.user.id);
      where.push(`g.user_id = $${params.length}`);
    }

    const result = await query(
      `SELECT g.id, g.template_id, g.user_id, g.file_path, g.submitted_data, g.status, g.status_note, g.reschedule_date, g.created_at, g.updated_at,
              t.title AS template_title
       FROM generated_pdfs g
       LEFT JOIN pdf_templates t ON t.id = g.template_id
       WHERE ${where.join(' AND ')}
       ORDER BY g.created_at DESC`,
      params
    );

    if (format === 'json') {
      const rows = result.rows.map((row) => ({
        ...row,
        submitted_data: normalizeSubmittedData(row.submitted_data)
      }));
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="template-${template_id}-data.json"`);
      return res.send(JSON.stringify(rows, null, 2));
    }

    const normalizedRows = result.rows.map((row) => ({
      ...row,
      submitted_data: normalizeSubmittedData(row.submitted_data)
    }));

    const dynamicKeys = Array.from(
      new Set(
        normalizedRows.flatMap((row) => Object.keys(row.submitted_data || {}))
      )
    ).sort();

    const fixedHeaders = [
      'id',
      'template_id',
      'template_title',
      'user_id',
      'status',
      'status_note',
      'reschedule_date',
      'created_at',
      'updated_at',
      'file_path'
    ];
    const headers = [...fixedHeaders, ...dynamicKeys];

    const lines = [];
    lines.push(headers.join(','));
    for (const row of normalizedRows) {
      const values = [
        row.id,
        row.template_id,
        row.template_title || '',
        row.user_id,
        row.status,
        row.status_note || '',
        row.reschedule_date || '',
        row.created_at,
        row.updated_at,
        row.file_path
      ];
      for (const key of dynamicKeys) {
        values.push(row.submitted_data?.[key] ?? '');
      }
      lines.push(values.map(csvEscape).join(','));
    }

    const fileName = `template-${template_id}-data.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(lines.join('\n'));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.patch('/:generatedPdfId/status', requireAuth, async (req, res) => {
  try {
    const { status, note = null, reschedule_date = null } = req.body;

    if (!allowedStatus.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    if (status !== 'rescheduled' && reschedule_date !== null) {
      return res.status(400).json({ error: 'reschedule_date is only allowed for rescheduled status' });
    }

    const current = await query('SELECT id, user_id, status FROM generated_pdfs WHERE id = $1', [req.params.generatedPdfId]);
    if (current.rowCount === 0) {
      return res.status(404).json({ error: 'Generated PDF not found' });
    }

    if (req.user.role === 'user' && current.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const oldStatus = current.rows[0].status;

    const updated = await query(
      `UPDATE generated_pdfs
       SET status = $1,
           status_note = $2,
           reschedule_date = $3,
           updated_at = NOW()
       WHERE id = $4
       RETURNING id, template_id, user_id, file_path, submitted_data, status, status_note, reschedule_date, created_at, updated_at`,
      [status, note, status === 'rescheduled' ? reschedule_date : null, req.params.generatedPdfId]
    );

    await query(
      `INSERT INTO status_history (id, generated_pdf_id, old_status, new_status, changed_by, note)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uuidv4(), req.params.generatedPdfId, oldStatus, status, req.user.id, note]
    );

    return res.json(updated.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/bulk-status', requireAuth, async (req, res) => {
  try {
    const { ids, status, note = null, reschedule_date = null } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array is required' });
    }
    if (!allowedStatus.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    if (status !== 'rescheduled' && reschedule_date !== null) {
      return res.status(400).json({ error: 'reschedule_date is only allowed for rescheduled status' });
    }

    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const ownershipParams = [...ids];
    let ownershipWhere = `id IN (${placeholders})`;
    if (req.user.role === 'user') {
      ownershipParams.push(req.user.id);
      ownershipWhere += ` AND user_id = $${ownershipParams.length}`;
    }

    const currentRows = await query(
      `SELECT id, status FROM generated_pdfs WHERE ${ownershipWhere}`,
      ownershipParams
    );

    if (currentRows.rowCount === 0) {
      return res.status(404).json({ error: 'No matching records found' });
    }

    const updatePlaceholders = currentRows.rows.map((_, i) => `$${i + 1}`).join(',');
    const updateParams = currentRows.rows.map((r) => r.id);
    updateParams.push(status, note, status === 'rescheduled' ? reschedule_date : null);

    const updated = await query(
      `UPDATE generated_pdfs
       SET status = $${updateParams.length - 2},
           status_note = $${updateParams.length - 1},
           reschedule_date = $${updateParams.length},
           updated_at = NOW()
       WHERE id IN (${updatePlaceholders})
       RETURNING id, status, status_note, reschedule_date, updated_at`,
      updateParams
    );

    for (const row of currentRows.rows) {
      await query(
        `INSERT INTO status_history (id, generated_pdf_id, old_status, new_status, changed_by, note)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [uuidv4(), row.id, row.status, status, req.user.id, note]
      );
    }

    return res.json({ updated_count: updated.rowCount, records: updated.rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/:generatedPdfId/history', requireAuth, async (req, res) => {
  try {
    const generatedPdf = await query('SELECT id, user_id FROM generated_pdfs WHERE id = $1', [req.params.generatedPdfId]);
    if (generatedPdf.rowCount === 0) {
      return res.status(404).json({ error: 'Generated PDF not found' });
    }

    if (req.user.role === 'user' && generatedPdf.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const history = await query(
      `SELECT h.id, h.generated_pdf_id, h.old_status, h.new_status, h.changed_by, h.note, h.created_at, u.name AS changed_by_name
       FROM status_history h
       LEFT JOIN users u ON u.id = h.changed_by
       WHERE h.generated_pdf_id = $1
       ORDER BY h.created_at ASC`,
      [req.params.generatedPdfId]
    );

    return res.json(history.rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/:generatedPdfId/download', requireAuth, async (req, res) => {
  try {
    const record = await query('SELECT id, user_id, file_path FROM generated_pdfs WHERE id = $1', [req.params.generatedPdfId]);
    if (record.rowCount === 0) {
      return res.status(404).json({ error: 'Generated PDF not found' });
    }

    if (req.user.role === 'user' && record.rows[0].user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const absolutePath = path.join(storageRoot, record.rows[0].file_path);
    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: 'File not found in storage' });
    }

    return res.download(absolutePath);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
