import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db.js';
import { requireAuth, requireAuthOrQueryToken, requireRole } from '../middleware/auth.js';

const router = express.Router();

const storageRoot = process.env.STORAGE_ROOT || path.resolve(process.cwd(), '../storage');
const imageDir = path.join(storageRoot, 'auto-reply-images');
fs.mkdirSync(imageDir, { recursive: true });

const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, imageDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    }
  }),
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    return cb(null, true);
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB per image
});

// ── Helper: fetch messages with their images ──────────────────────
async function fetchMessagesWithImages() {
  const msgRows = await query(
    `SELECT id, title, message_text, created_by, created_at, updated_at
     FROM auto_reply_messages
     ORDER BY created_at ASC`
  );
  if (msgRows.rows.length === 0) return [];

  const ids = msgRows.rows.map((r) => r.id);
  const imgRows = await query(
    `SELECT id, message_id, file_path, original_name, created_at
     FROM auto_reply_images
     WHERE message_id = ANY($1::uuid[])
     ORDER BY created_at ASC`,
    [ids]
  );

  const imgMap = {};
  for (const img of imgRows.rows) {
    if (!imgMap[img.message_id]) imgMap[img.message_id] = [];
    imgMap[img.message_id].push(img);
  }

  return msgRows.rows.map((msg) => ({
    ...msg,
    images: imgMap[msg.id] || []
  }));
}

// ── GET /api/auto-reply  — all users (auth required) ─────────────
router.get('/', requireAuth, async (_req, res) => {
  try {
    const messages = await fetchMessagesWithImages();
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/auto-reply/images/:imageId — serve image (public, UUIDs are non-guessable) ──
router.get('/images/:imageId', requireAuthOrQueryToken, async (req, res) => {
  try {
    const row = await query(
      'SELECT file_path, original_name FROM auto_reply_images WHERE id = $1',
      [req.params.imageId]
    );
    if (row.rows.length === 0) return res.status(404).json({ error: 'Image not found' });

    const filePath = row.rows[0].file_path;
    if (!fs.existsSync(filePath)) {
      await query('DELETE FROM auto_reply_images WHERE id = $1', [req.params.imageId]);
      return res.status(404).json({ error: 'Image file missing' });
    }

    res.sendFile(filePath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/auto-reply — create message (admin) ────────────────
router.post(
  '/',
  requireAuth,
  requireRole('admin', 'super_admin'),
  imageUpload.array('images', 20),
  async (req, res) => {
    const { title, message_text } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
    if (!message_text || !message_text.trim()) return res.status(400).json({ error: 'Message text is required' });

    const id = uuidv4();
    try {
      await query(
        `INSERT INTO auto_reply_messages (id, title, message_text, created_by)
         VALUES ($1, $2, $3, $4)`,
        [id, title.trim(), message_text.trim(), req.user.id]
      );

      if (req.files && req.files.length > 0) {
        for (const file of req.files) {
          await query(
            `INSERT INTO auto_reply_images (id, message_id, file_path, original_name)
             VALUES ($1, $2, $3, $4)`,
            [uuidv4(), id, file.path, file.originalname]
          );
        }
      }

      const messages = await fetchMessagesWithImages();
      const created = messages.find((m) => m.id === id);
      res.status(201).json(created);
    } catch (err) {
      // Clean up uploaded files on error
      if (req.files) req.files.forEach((f) => fs.unlink(f.path, () => {}));
      res.status(500).json({ error: err.message });
    }
  }
);

// ── PUT /api/auto-reply/:id — update title/text (admin) ──────────
router.put('/:id', requireAuth, requireRole('admin', 'super_admin'), async (req, res) => {
  const { title, message_text } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
  if (!message_text || !message_text.trim()) return res.status(400).json({ error: 'Message text is required' });

  try {
    const result = await query(
      `UPDATE auto_reply_messages
       SET title = $1, message_text = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING id`,
      [title.trim(), message_text.trim(), req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Message not found' });

    const messages = await fetchMessagesWithImages();
    res.json(messages.find((m) => m.id === req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/auto-reply/:id — delete message (admin) ──────────
router.delete('/:id', requireAuth, requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const imgRows = await query(
      'SELECT file_path FROM auto_reply_images WHERE message_id = $1',
      [req.params.id]
    );

    const result = await query(
      'DELETE FROM auto_reply_messages WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Message not found' });

    // Delete image files from disk
    for (const row of imgRows.rows) {
      fs.unlink(row.file_path, () => {});
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/auto-reply/:id/images — add images (admin) ─────────
router.post(
  '/:id/images',
  requireAuth,
  requireRole('admin', 'super_admin'),
  imageUpload.array('images', 20),
  async (req, res) => {
    try {
      const exists = await query(
        'SELECT id FROM auto_reply_messages WHERE id = $1',
        [req.params.id]
      );
      if (exists.rows.length === 0) {
        if (req.files) req.files.forEach((f) => fs.unlink(f.path, () => {}));
        return res.status(404).json({ error: 'Message not found' });
      }

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No images provided' });
      }

      for (const file of req.files) {
        await query(
          `INSERT INTO auto_reply_images (id, message_id, file_path, original_name)
           VALUES ($1, $2, $3, $4)`,
          [uuidv4(), req.params.id, file.path, file.originalname]
        );
      }

      const messages = await fetchMessagesWithImages();
      res.json(messages.find((m) => m.id === req.params.id));
    } catch (err) {
      if (req.files) req.files.forEach((f) => fs.unlink(f.path, () => {}));
      res.status(500).json({ error: err.message });
    }
  }
);

// ── DELETE /api/auto-reply/:id/images/:imageId — remove image (admin) ──
router.delete('/:id/images/:imageId', requireAuth, requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const imgRow = await query(
      'SELECT file_path FROM auto_reply_images WHERE id = $1 AND message_id = $2',
      [req.params.imageId, req.params.id]
    );
    if (imgRow.rows.length === 0) return res.status(404).json({ error: 'Image not found' });

    await query('DELETE FROM auto_reply_images WHERE id = $1', [req.params.imageId]);
    fs.unlink(imgRow.rows[0].file_path, () => {});

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
