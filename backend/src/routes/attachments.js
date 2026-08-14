import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = express.Router();

const storageRoot = process.env.STORAGE_ROOT || path.resolve(process.cwd(), '../storage');
const attachmentsDir = path.join(storageRoot, 'attachments');
fs.mkdirSync(attachmentsDir, { recursive: true });

const ALLOWED_MIMES = {
  image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'],
  pdf: ['application/pdf'],
  image_or_pdf: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'application/pdf']
};

const allAllowedMimes = [...new Set(Object.values(ALLOWED_MIMES).flat())];

const attachmentUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, attachmentsDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '';
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!allAllowedMimes.includes(file.mimetype)) {
      return cb(new Error(`File type not allowed: ${file.mimetype}`));
    }
    return cb(null, true);
  }
});

// GET /api/generated-pdfs/:id/attachments — list attachments for a record
// Reads are team-wide (shared CSR queue). Uploads are owner-only for the `user`
// role — admin and super_admin may act on any record.
function isPrivilegedRole(role) {
  return role === 'admin' || role === 'super_admin';
}

function ownsRecord(req, row) {
  return isPrivilegedRole(req.user.role) || row.user_id === req.user.id;
}

router.get('/generated-pdfs/:generatedPdfId/attachments', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT a.id, a.generated_pdf_id, a.requirement_id, a.original_name, a.mime_type,
              a.file_path, a.uploaded_by, a.created_at,
              r.document_name
       FROM generated_pdf_attachments a
       LEFT JOIN template_document_requirements r ON r.id = a.requirement_id
       WHERE a.generated_pdf_id = $1
       ORDER BY a.created_at ASC`,
      [req.params.generatedPdfId]
    );
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/generated-pdfs/:id/attachments — upload files
// Expects multipart: files[] + requirement_ids[] (parallel arrays)
router.post(
  '/generated-pdfs/:generatedPdfId/attachments',
  requireAuth,
  attachmentUpload.array('files', 20),
  async (req, res) => {
    const uploadedAbsPaths = (req.files || []).map((f) => f.path);
    try {
      const { generatedPdfId } = req.params;

      const pdfResult = await query('SELECT id, user_id FROM generated_pdfs WHERE id = $1', [generatedPdfId]);
      if (pdfResult.rowCount === 0) {
        for (const p of uploadedAbsPaths) { if (fs.existsSync(p)) fs.unlinkSync(p); }
        return res.status(404).json({ error: 'Generated PDF not found' });
      }
      if (!ownsRecord(req, pdfResult.rows[0])) {
        for (const p of uploadedAbsPaths) { if (fs.existsSync(p)) fs.unlinkSync(p); }
        return res.status(403).json({ error: 'Forbidden' });
      }

      const files = req.files || [];
      if (files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
      }

      const rawReqIds = req.body.requirement_ids;
      const reqIds = Array.isArray(rawReqIds)
        ? rawReqIds
        : rawReqIds
          ? [rawReqIds]
          : [];

      const inserted = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const requirementId = reqIds[i] || null;

        if (requirementId) {
          const reqResult = await query(
            'SELECT allowed_types FROM template_document_requirements WHERE id = $1',
            [requirementId]
          );
          if (reqResult.rowCount > 0) {
            const allowed = ALLOWED_MIMES[reqResult.rows[0].allowed_types] || [];
            if (!allowed.includes(file.mimetype)) {
              for (const p of uploadedAbsPaths) { if (fs.existsSync(p)) fs.unlinkSync(p); }
              return res.status(400).json({
                error: `File type "${file.mimetype}" is not allowed for this requirement (expected: ${reqResult.rows[0].allowed_types})`
              });
            }
          }
        }

        const id = uuidv4();
        const relPath = path.join('attachments', file.filename);
        await query(
          `INSERT INTO generated_pdf_attachments
           (id, generated_pdf_id, requirement_id, original_name, mime_type, file_path, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, generatedPdfId, requirementId, file.originalname, file.mimetype, relPath, req.user.id]
        );
        inserted.push({
          id,
          generated_pdf_id: generatedPdfId,
          requirement_id: requirementId,
          original_name: file.originalname,
          mime_type: file.mimetype,
          file_path: relPath,
          uploaded_by: req.user.id
        });
      }

      return res.status(201).json(inserted);
    } catch (err) {
      for (const p of uploadedAbsPaths) { if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (_e) { /* ignore */ } } }
      return res.status(500).json({ error: err.message });
    }
  }
);

// GET /api/attachments/:id/file — serve a file
router.get('/attachments/:attachmentId/file', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT a.id, a.file_path, a.original_name, a.mime_type, g.user_id
         FROM generated_pdf_attachments a
         JOIN generated_pdfs g ON g.id = a.generated_pdf_id
        WHERE a.id = $1`,
      [req.params.attachmentId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    const { file_path, original_name, mime_type } = result.rows[0];
    const absolutePath = path.join(storageRoot, file_path);
    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: 'Attachment file missing from storage' });
    }
    if (mime_type) res.setHeader('Content-Type', mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(original_name)}"`);
    return res.sendFile(absolutePath);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/attachments/:id — admin only
router.delete('/attachments/:attachmentId', requireAuth, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM generated_pdf_attachments WHERE id = $1 RETURNING file_path',
      [req.params.attachmentId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Attachment not found' });
    }
    const absolutePath = path.join(storageRoot, result.rows[0].file_path);
    if (fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);
    return res.status(204).send();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
