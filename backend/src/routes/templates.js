import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = express.Router();

const storageRoot = process.env.STORAGE_ROOT || path.resolve(process.cwd(), '../storage');
const templateDir = path.join(storageRoot, 'templates');
fs.mkdirSync(templateDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, templateDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '.pdf';
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    }
  }),
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Only PDF files are allowed'));
    }
    return cb(null, true);
  }
});

const allowedFieldTypes = ['text', 'dropdown', 'date', 'order_number', 'checkbox'];

function normalizeFieldOptions(fieldType, rawOptions) {
  if (fieldType !== 'dropdown') {
    return [];
  }

  if (Array.isArray(rawOptions)) {
    return rawOptions.map((v) => String(v).trim()).filter(Boolean);
  }

  if (typeof rawOptions === 'string') {
    return rawOptions
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  return [];
}

function normalizeValidationRules(rawRules) {
  if (!rawRules || typeof rawRules !== 'object' || Array.isArray(rawRules)) {
    return {};
  }

  const rules = {};
  if (rawRules.regex !== undefined && rawRules.regex !== null && String(rawRules.regex).trim() !== '') {
    rules.regex = String(rawRules.regex);
  }
  if (rawRules.min_length !== undefined && rawRules.min_length !== null && String(rawRules.min_length) !== '') {
    rules.min_length = Number(rawRules.min_length);
  }
  if (rawRules.max_length !== undefined && rawRules.max_length !== null && String(rawRules.max_length) !== '') {
    rules.max_length = Number(rawRules.max_length);
  }
  if (rawRules.required_if && typeof rawRules.required_if === 'object') {
    rules.required_if = {
      field: String(rawRules.required_if.field || '').trim(),
      equals: rawRules.required_if.equals
    };
  }
  return rules;
}

async function bumpTemplateVersion(templateId) {
  const result = await query(
    'UPDATE pdf_templates SET version = COALESCE(version, 1) + 1 WHERE id = $1 RETURNING version',
    [templateId]
  );
  if (result.rowCount === 0) {
    throw new Error('Template not found');
  }
  return Number(result.rows[0].version || 1);
}

router.get('/', requireAuth, async (_req, res) => {
  try {
    const result = await query(
      `SELECT t.id, t.title, t.description, t.file_path, t.created_by, t.created_at,
        t.version,
        u.name AS created_by_name
       FROM pdf_templates t
       LEFT JOIN users u ON u.id = t.created_by
       ORDER BY t.created_at DESC`
    );

    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/', requireAuth, requireRole('super_admin', 'admin'), upload.single('template'), async (req, res) => {
  try {
    const { title, description } = req.body;

    if (!title || !req.file) {
      return res.status(400).json({ error: 'title and template file are required' });
    }

    const id = uuidv4();
    const filePath = path.join('templates', req.file.filename);

    await query(
      'INSERT INTO pdf_templates (id, title, description, file_path, version, created_by) VALUES ($1, $2, $3, $4, 1, $5)',
      [id, title, description || null, filePath, req.user.id]
    );

    return res.status(201).json({ id, title, description: description || null, file_path: filePath, version: 1 });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.put('/:templateId', requireAuth, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { title, description } = req.body;
    if (!title) {
      return res.status(400).json({ error: 'title is required' });
    }

    const result = await query(
      `UPDATE pdf_templates
       SET title = $1,
           description = $2
       WHERE id = $3
       RETURNING id, title, description, file_path, version, created_by, created_at`,
      [title, description || null, req.params.templateId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }

    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete('/:templateId', requireAuth, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const templateResult = await query('SELECT id, file_path FROM pdf_templates WHERE id = $1', [req.params.templateId]);
    if (templateResult.rowCount === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const generatedFiles = await query('SELECT file_path FROM generated_pdfs WHERE template_id = $1', [req.params.templateId]);

    await query('DELETE FROM pdf_templates WHERE id = $1', [req.params.templateId]);

    const templateAbsolutePath = path.join(storageRoot, templateResult.rows[0].file_path);
    if (fs.existsSync(templateAbsolutePath)) {
      fs.unlinkSync(templateAbsolutePath);
    }

    for (const row of generatedFiles.rows) {
      const absPath = path.join(storageRoot, row.file_path);
      if (fs.existsSync(absPath)) {
        fs.unlinkSync(absPath);
      }
    }

    return res.status(204).send();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/:templateId/fields', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT id, template_id, template_version, field_name, field_type, field_options, validation_rules, page_number, x_position, y_position, box_width, box_height, font_size, auto_font, required, created_at
       FROM pdf_fields
       WHERE template_id = $1
       ORDER BY created_at ASC`,
      [req.params.templateId]
    );

    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/:templateId/fields', requireAuth, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const {
      field_name,
      field_type = 'text',
      field_options = [],
      validation_rules = {},
      page_number,
      x_position,
      y_position,
      box_width,
      box_height,
      font_size = 12,
      auto_font = true,
      required = false
    } = req.body;

    if (!field_name || !page_number || x_position === undefined || y_position === undefined) {
      return res.status(400).json({
        error: 'field_name, page_number, x_position, and y_position are required'
      });
    }
    if (box_width === undefined || box_height === undefined || Number(box_width) <= 0 || Number(box_height) <= 0) {
      return res.status(400).json({
        error: 'box_width and box_height are required and must be > 0'
      });
    }
    if (!allowedFieldTypes.includes(field_type)) {
      return res.status(400).json({ error: 'Invalid field_type' });
    }

    const normalizedOptions = normalizeFieldOptions(field_type, field_options);
    const normalizedRules = normalizeValidationRules(validation_rules);
    if (field_type === 'dropdown' && normalizedOptions.length === 0) {
      return res.status(400).json({ error: 'Dropdown field requires at least one option' });
    }

    const id = uuidv4();
    const templateVersion = await bumpTemplateVersion(req.params.templateId);
    await query(
      `INSERT INTO pdf_fields
      (id, template_id, template_version, field_name, field_type, field_options, validation_rules, page_number, x_position, y_position, box_width, box_height, font_size, auto_font, required)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [id, req.params.templateId, templateVersion, field_name, field_type, JSON.stringify(normalizedOptions), JSON.stringify(normalizedRules), page_number, x_position, y_position, box_width, box_height, font_size, auto_font, required]
    );
    return res.status(201).json({
      id,
      template_id: req.params.templateId,
      template_version: templateVersion,
      field_name,
      field_type,
      field_options: normalizedOptions,
      validation_rules: normalizedRules,
      page_number,
      x_position,
      y_position,
      box_width,
      box_height,
      font_size,
      auto_font,
      required
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.put('/fields/:fieldId', requireAuth, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const {
      field_name,
      field_type = 'text',
      field_options = [],
      validation_rules = {},
      page_number,
      x_position,
      y_position,
      box_width,
      box_height,
      font_size = 12,
      auto_font = true,
      required = false
    } = req.body;

    if (!field_name || !page_number || x_position === undefined || y_position === undefined) {
      return res.status(400).json({
        error: 'field_name, page_number, x_position, and y_position are required'
      });
    }
    if (box_width === undefined || box_height === undefined || Number(box_width) <= 0 || Number(box_height) <= 0) {
      return res.status(400).json({
        error: 'box_width and box_height are required and must be > 0'
      });
    }
    if (!allowedFieldTypes.includes(field_type)) {
      return res.status(400).json({ error: 'Invalid field_type' });
    }
    const normalizedOptions = normalizeFieldOptions(field_type, field_options);
    const normalizedRules = normalizeValidationRules(validation_rules);
    if (field_type === 'dropdown' && normalizedOptions.length === 0) {
      return res.status(400).json({ error: 'Dropdown field requires at least one option' });
    }

    const fieldResult = await query('SELECT template_id FROM pdf_fields WHERE id = $1', [req.params.fieldId]);
    if (fieldResult.rowCount === 0) {
      return res.status(404).json({ error: 'Field not found' });
    }
    const templateId = fieldResult.rows[0].template_id;
    const bumpedVersion = await bumpTemplateVersion(templateId);

    const result = await query(
      `UPDATE pdf_fields
       SET field_name = $1,
           field_type = $2,
           field_options = $3::jsonb,
           validation_rules = $4::jsonb,
           template_version = $5,
           page_number = $6,
           x_position = $7,
           y_position = $8,
           box_width = $9,
           box_height = $10,
           font_size = $11,
           auto_font = $12,
           required = $13
       WHERE id = $14
       RETURNING id, template_id, template_version, field_name, field_type, field_options, validation_rules, page_number, x_position, y_position, box_width, box_height, font_size, auto_font, required`,
      [field_name, field_type, JSON.stringify(normalizedOptions), JSON.stringify(normalizedRules), bumpedVersion, page_number, x_position, y_position, box_width, box_height, font_size, auto_font, required, req.params.fieldId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Field not found' });
    }

    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete('/fields/:fieldId', requireAuth, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const fieldResult = await query('SELECT template_id FROM pdf_fields WHERE id = $1', [req.params.fieldId]);
    if (fieldResult.rowCount === 0) {
      return res.status(404).json({ error: 'Field not found' });
    }
    await bumpTemplateVersion(fieldResult.rows[0].template_id);
    const result = await query('DELETE FROM pdf_fields WHERE id = $1', [req.params.fieldId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Field not found' });
    }

    return res.status(204).send();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/:templateId/file', requireAuth, async (req, res) => {
  try {
    const result = await query('SELECT file_path FROM pdf_templates WHERE id = $1', [req.params.templateId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const absolutePath = path.join(storageRoot, result.rows[0].file_path);
    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: 'Template file missing' });
    }

    return res.sendFile(absolutePath);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.put('/:templateId/file', requireAuth, requireRole('super_admin', 'admin'), upload.single('template'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'template file is required' });
    }

    const existing = await query(
      'SELECT id, title, description, file_path, version, created_by, created_at FROM pdf_templates WHERE id = $1',
      [req.params.templateId]
    );

    if (existing.rowCount === 0) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Template not found' });
    }

    const nextFilePath = path.join('templates', req.file.filename);
    const result = await query(
      `UPDATE pdf_templates
       SET file_path = $1,
           version = COALESCE(version, 1) + 1
       WHERE id = $2
       RETURNING id, title, description, file_path, version, created_by, created_at`,
      [nextFilePath, req.params.templateId]
    );

    const previousAbsolutePath = path.join(storageRoot, existing.rows[0].file_path);
    if (fs.existsSync(previousAbsolutePath)) {
      fs.unlinkSync(previousAbsolutePath);
    }

    return res.json(result.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/presets', requireAuth, async (_req, res) => {
  try {
    const result = await query(
      `SELECT id, name, field_type, field_options, validation_rules, created_by, created_at
       FROM field_presets
       ORDER BY name ASC`
    );
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/presets', requireAuth, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const {
      name,
      field_type = 'text',
      field_options = [],
      validation_rules = {}
    } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!allowedFieldTypes.includes(field_type)) {
      return res.status(400).json({ error: 'Invalid field_type' });
    }

    const normalizedOptions = normalizeFieldOptions(field_type, field_options);
    const normalizedRules = normalizeValidationRules(validation_rules);

    if (field_type === 'dropdown' && normalizedOptions.length === 0) {
      return res.status(400).json({ error: 'Dropdown preset requires at least one option' });
    }

    const id = uuidv4();
    await query(
      `INSERT INTO field_presets (id, name, field_type, field_options, validation_rules, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
      [id, String(name).trim(), field_type, JSON.stringify(normalizedOptions), JSON.stringify(normalizedRules), req.user.id]
    );

    return res.status(201).json({
      id,
      name: String(name).trim(),
      field_type,
      field_options: normalizedOptions,
      validation_rules: normalizedRules
    });
  } catch (err) {
    if (String(err.message).includes('duplicate key')) {
      return res.status(409).json({ error: 'Preset name already exists' });
    }
    return res.status(500).json({ error: err.message });
  }
});

router.delete('/presets/:presetId', requireAuth, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const result = await query('DELETE FROM field_presets WHERE id = $1', [req.params.presetId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Preset not found' });
    }
    return res.status(204).send();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
