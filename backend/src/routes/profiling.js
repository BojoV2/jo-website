import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

const storageRoot = process.env.STORAGE_ROOT || path.resolve(process.cwd(), '../storage');
const profilingDir = path.join(storageRoot, 'profiling');
fs.mkdirSync(profilingDir, { recursive: true });

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const ALLOWED_MIMES = [
  'application/pdf',
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/heic',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv'
];

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, profilingDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '';
      cb(null, `${uuidv4()}${ext}`);
    }
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIMES.includes(file.mimetype)) {
      return cb(new Error(`File type not allowed: ${file.mimetype}`));
    }
    return cb(null, true);
  }
});

function isPrivilegedRole(role) {
  return role === 'admin' || role === 'super_admin';
}

function cleanName(value) {
  return String(value || '').trim().replace(/[\\/]/g, '-').slice(0, 120);
}

async function getFolder(id) {
  const result = await query('SELECT * FROM profiling_folders WHERE id = $1', [id]);
  return result.rowCount === 0 ? null : result.rows[0];
}

// A folder is locked when it is locked itself or sits under a locked ancestor.
async function isLockedBranch(folderId) {
  if (!folderId) return false;
  const result = await query(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_id, locked FROM profiling_folders WHERE id = $1
       UNION ALL
       SELECT f.id, f.parent_id, f.locked FROM profiling_folders f JOIN chain c ON f.id = c.parent_id
     )
     SELECT bool_or(locked) AS locked FROM chain`,
    [folderId]
  );
  return Boolean(result.rows[0]?.locked);
}

async function buildBreadcrumb(folderId) {
  const result = await query(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_id, name, kind, 0 AS depth FROM profiling_folders WHERE id = $1
       UNION ALL
       SELECT f.id, f.parent_id, f.name, f.kind, c.depth + 1
       FROM profiling_folders f JOIN chain c ON f.id = c.parent_id
     )
     SELECT id, name, kind FROM chain ORDER BY depth DESC`,
    [folderId]
  );
  return result.rows;
}

// Would moving `folderId` under `targetId` create a cycle?
async function isDescendant(folderId, targetId) {
  if (!targetId) return false;
  if (folderId === targetId) return true;
  const result = await query(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_id FROM profiling_folders WHERE id = $1
       UNION ALL
       SELECT f.id, f.parent_id FROM profiling_folders f JOIN chain c ON f.id = c.parent_id
     )
     SELECT 1 FROM chain WHERE id = $2 LIMIT 1`,
    [targetId, folderId]
  );
  return result.rowCount > 0;
}

// The archive is Template > Year > Month. Every template owns a root folder,
// and a year/month row appears for each period that template has generated PDFs
// in, plus the current period so a new month (and a new year) shows up on its
// own. Rows rather than virtual folders because admins lock and hide them.
async function ensureAutoFolders() {
  const [templates, periods, existing] = await Promise.all([
    query('SELECT id, title FROM pdf_templates ORDER BY created_at ASC'),
    query(
      `SELECT DISTINCT template_id,
              EXTRACT(YEAR FROM created_at)::int AS year,
              EXTRACT(MONTH FROM created_at)::int AS month
       FROM generated_pdfs
       WHERE created_at IS NOT NULL AND template_id IS NOT NULL`
    ),
    query("SELECT id, parent_id, name, kind, template_id, year, month FROM profiling_folders WHERE kind IN ('template', 'auto')")
  ]);

  const key = (templateId, year, month) => `${templateId}|${year === null || year === undefined ? '' : year}|${month === null || month === undefined ? '' : month}`;
  const known = new Map();
  for (const row of existing.rows) {
    known.set(key(row.template_id, row.year, row.month), row);
  }

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  async function ensureFolder({ templateId, parentId, name, kind, year = null, month = null }) {
    const cached = known.get(key(templateId, year, month));
    if (cached) {
      if (cached.name !== name && kind === 'template') {
        // the template was renamed - keep its folder label in step
        await query('UPDATE profiling_folders SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [name, cached.id]);
        cached.name = name;
      }
      return cached.id;
    }
    const id = uuidv4();
    try {
      await query(
        `INSERT INTO profiling_folders (id, parent_id, name, kind, template_id, year, month)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, parentId, name, kind, templateId, year, month]
      );
      known.set(key(templateId, year, month), { id, parent_id: parentId, name, kind, template_id: templateId, year, month });
      return id;
    } catch (err) {
      // two templates with the same title - suffix so both archives exist
      const fallbackName = `${name} (${String(templateId).slice(0, 4)})`;
      await query(
        `INSERT INTO profiling_folders (id, parent_id, name, kind, template_id, year, month)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING`,
        [id, parentId, fallbackName, kind, templateId, year, month]
      );
      known.set(key(templateId, year, month), { id, parent_id: parentId, name: fallbackName, kind, template_id: templateId, year, month });
      return id;
    }
  }

  for (const template of templates.rows) {
    const rootId = await ensureFolder({
      templateId: template.id,
      parentId: null,
      name: template.title,
      kind: 'template'
    });

    const templatePeriods = periods.rows.filter((row) => row.template_id === template.id);
    const wanted = [...templatePeriods, { template_id: template.id, year: currentYear, month: currentMonth }];
    const years = [...new Set(wanted.map((row) => row.year))];

    const yearIds = new Map();
    for (const year of years) {
      yearIds.set(
        year,
        await ensureFolder({
          templateId: template.id,
          parentId: rootId,
          name: String(year),
          kind: 'auto',
          year
        })
      );
    }

    const seen = new Set();
    for (const row of wanted) {
      const monthKey = `${row.year}-${row.month}`;
      if (seen.has(monthKey)) continue;
      seen.add(monthKey);
      await ensureFolder({
        templateId: template.id,
        parentId: yearIds.get(row.year),
        name: MONTH_NAMES[row.month - 1],
        kind: 'auto',
        year: row.year,
        month: row.month
      });
    }
  }
}

// Called right after a template is uploaded so its archive exists immediately.
export async function ensureProfilingForTemplate() {
  await ensureAutoFolders();
}

function mapFolder(row) {
  return {
    id: row.id,
    parent_id: row.parent_id,
    name: row.name,
    kind: row.kind,
    year: row.year,
    month: row.month,
    locked: row.locked,
    hidden: row.hidden,
    created_at: row.created_at,
    created_by: row.created_by,
    created_by_name: row.created_by_name || null,
    template_id: row.template_id,
    folder_count: Number(row.folder_count || 0),
    file_count: Number(row.file_count || 0),
    generated_count: Number(row.generated_count || 0)
  };
}

async function listChildFolders(parentId, includeHidden) {
  const result = await query(
    `SELECT f.*, u.name AS created_by_name,
            (SELECT COUNT(*) FROM profiling_folders c WHERE c.parent_id = f.id) AS folder_count,
            (SELECT COUNT(*) FROM profiling_files fi WHERE fi.folder_id = f.id) AS file_count,
            CASE
              WHEN f.template_id IS NULL THEN 0
              WHEN f.kind = 'auto' AND f.month IS NOT NULL THEN (
                SELECT COUNT(*) FROM generated_pdfs g
                WHERE g.template_id = f.template_id
                  AND EXTRACT(YEAR FROM g.created_at) = f.year
                  AND EXTRACT(MONTH FROM g.created_at) = f.month)
              WHEN f.kind = 'auto' THEN (
                SELECT COUNT(*) FROM generated_pdfs g
                WHERE g.template_id = f.template_id
                  AND EXTRACT(YEAR FROM g.created_at) = f.year)
              WHEN f.kind = 'template' THEN (
                SELECT COUNT(*) FROM generated_pdfs g WHERE g.template_id = f.template_id)
              ELSE 0
            END AS generated_count
     FROM profiling_folders f
     LEFT JOIN users u ON u.id = f.created_by
     WHERE ${parentId ? 'f.parent_id = $1' : 'f.parent_id IS NULL'}
       ${includeHidden ? '' : 'AND f.hidden = FALSE'}
     ORDER BY f.kind ASC, COALESCE(f.year, 0) DESC, COALESCE(f.month, 0) ASC, f.name ASC`,
    parentId ? [parentId] : []
  );
  return result.rows.map(mapFolder);
}

async function listManualFiles(folderId) {
  const result = await query(
    `SELECT fi.id, fi.title, fi.date_installed, fi.original_name, fi.mime_type,
            fi.size_bytes, fi.created_at, fi.uploaded_by, u.name AS uploaded_by_name
     FROM profiling_files fi
     LEFT JOIN users u ON u.id = fi.uploaded_by
     WHERE fi.folder_id = $1
     ORDER BY fi.created_at DESC`,
    [folderId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    source: 'manual',
    title: row.title,
    date_installed: row.date_installed,
    original_name: row.original_name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes === null ? null : Number(row.size_bytes),
    created_at: row.created_at,
    uploaded_by: row.uploaded_by,
    uploaded_by_name: row.uploaded_by_name
  }));
}

// The generated PDFs of an auto month are listed, never copied - the archive is
// a view over generated_pdfs, so nothing is duplicated on disk.
async function listGeneratedFiles(folder) {
  if (folder.kind !== 'auto' || !folder.year || !folder.month || !folder.template_id) return [];
  const result = await query(
    `SELECT g.id, g.file_path, g.created_at, g.status,
            COALESCE(
              NULLIF(TRIM(g.submitted_data->>'Name'), ''),
              NULLIF(TRIM(g.submitted_data->>'name'), ''),
              NULLIF(TRIM(g.submitted_data->>'Relocation name'), ''),
              NULLIF(TRIM(g.submitted_data->>'Client Name'), ''),
              NULLIF(TRIM(g.submitted_data->>'Customer Name'), ''),
              NULLIF(TRIM(g.submitted_data->>'Subscriber'), '')
            ) AS client_name,
            COALESCE(
              NULLIF(TRIM(g.submitted_data->>'Order Number'), ''),
              NULLIF(TRIM(g.submitted_data->>'Order number'), ''),
              NULLIF(TRIM(g.submitted_data->>'Application number'), ''),
              NULLIF(TRIM(g.submitted_data->>'Account ID'), ''),
              NULLIF(TRIM(g.submitted_data->>'Account number'), ''),
              NULLIF(TRIM(g.submitted_data->>'Account No.'), '')
            ) AS reference,
            t.title AS template_title, u.name AS owner_name
     FROM generated_pdfs g
     LEFT JOIN pdf_templates t ON t.id = g.template_id
     LEFT JOIN users u ON u.id = g.user_id
     WHERE g.template_id = $1
       AND EXTRACT(YEAR FROM g.created_at) = $2
       AND EXTRACT(MONTH FROM g.created_at) = $3
     ORDER BY g.created_at DESC`,
    [folder.template_id, folder.year, folder.month]
  );
  return result.rows.map((row) => ({
    id: row.id,
    source: 'generated',
    // Named for the person the document is about, not the stored file name.
    title: row.client_name || row.template_title || 'Generated PDF',
    reference: row.reference,
    template_title: row.template_title,
    date_installed: row.created_at,
    original_name: null,
    mime_type: 'application/pdf',
    size_bytes: null,
    status: row.status,
    created_at: row.created_at,
    uploaded_by_name: row.owner_name
  }));
}

router.use(requireAuth);

// GET /api/profiling/folders?parent_id= - browse one level
router.get('/folders', async (req, res) => {
  try {
    await ensureAutoFolders();
    const includeHidden = isPrivilegedRole(req.user.role);
    const parentId = req.query.parent_id || null;

    let folder = null;
    if (parentId) {
      folder = await getFolder(parentId);
      if (!folder) return res.status(404).json({ error: 'Folder not found' });
      if (folder.hidden && !includeHidden) return res.status(404).json({ error: 'Folder not found' });
    }

    const [folders, breadcrumb] = await Promise.all([
      listChildFolders(parentId, includeHidden),
      parentId ? buildBreadcrumb(parentId) : Promise.resolve([])
    ]);

    let files = [];
    if (folder) {
      const [manual, generated] = await Promise.all([listManualFiles(folder.id), listGeneratedFiles(folder)]);
      files = [...generated, ...manual];
    }

    return res.json({
      folder: folder ? { ...mapFolder(folder), locked_branch: await isLockedBranch(folder.id) } : null,
      breadcrumb,
      folders,
      files
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/profiling/folder-list - flat list with full paths, for move pickers
router.get('/folder-list', async (req, res) => {
  try {
    await ensureAutoFolders();
    const includeHidden = isPrivilegedRole(req.user.role);
    const result = await query(
      `WITH RECURSIVE tree AS (
         SELECT id, parent_id, name, kind, hidden, name::text AS path, 1 AS depth
         FROM profiling_folders WHERE parent_id IS NULL
         UNION ALL
         SELECT f.id, f.parent_id, f.name, f.kind, f.hidden, t.path || ' / ' || f.name, t.depth + 1
         FROM profiling_folders f JOIN tree t ON f.parent_id = t.id
       )
       SELECT id, parent_id, name, kind, hidden, path, depth FROM tree
       ${includeHidden ? '' : 'WHERE hidden = FALSE'}
       ORDER BY path`
    );
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/profiling/folders - create a manual folder
router.post('/folders', async (req, res) => {
  try {
    const name = cleanName(req.body.name);
    const parentId = req.body.parent_id || null;
    if (!name) return res.status(400).json({ error: 'Folder name is required' });

    if (parentId) {
      const parent = await getFolder(parentId);
      if (!parent) return res.status(404).json({ error: 'Parent folder not found' });
      if (await isLockedBranch(parentId)) {
        return res.status(403).json({ error: 'That year is locked. Ask an admin to unlock it first.' });
      }
    }

    const duplicate = await query(
      `SELECT id FROM profiling_folders
       WHERE lower(name) = lower($1) AND parent_id IS NOT DISTINCT FROM $2`,
      [name, parentId]
    );
    if (duplicate.rowCount > 0) {
      return res.status(409).json({ error: `"${name}" already exists here` });
    }

    const id = uuidv4();
    await query(
      `INSERT INTO profiling_folders (id, parent_id, name, kind, created_by)
       VALUES ($1, $2, $3, 'manual', $4)`,
      [id, parentId, name, req.user.id]
    );
    const created = await getFolder(id);
    return res.status(201).json(mapFolder(created));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /api/profiling/folders/:id - rename, move, lock, hide
router.patch('/folders/:folderId', async (req, res) => {
  try {
    const folder = await getFolder(req.params.folderId);
    if (!folder) return res.status(404).json({ error: 'Folder not found' });

    const privileged = isPrivilegedRole(req.user.role);
    const wantsAdminField = req.body.locked !== undefined || req.body.hidden !== undefined;
    if (wantsAdminField && !privileged) {
      return res.status(403).json({ error: 'Only an admin can lock or hide folders' });
    }

    const renaming = req.body.name !== undefined;
    const moving = req.body.parent_id !== undefined;

    if ((renaming || moving) && !privileged) {
      if (folder.kind === 'auto') {
        return res.status(403).json({ error: 'Year and month folders are managed automatically' });
      }
      if (folder.created_by !== req.user.id) {
        return res.status(403).json({ error: 'You can only rename folders you created' });
      }
      if (await isLockedBranch(folder.id)) {
        return res.status(403).json({ error: 'That folder is locked' });
      }
    }

    const name = renaming ? cleanName(req.body.name) : folder.name;
    if (renaming && !name) return res.status(400).json({ error: 'Folder name is required' });

    let parentId = folder.parent_id;
    if (moving) {
      parentId = req.body.parent_id || null;
      if (parentId) {
        const parent = await getFolder(parentId);
        if (!parent) return res.status(404).json({ error: 'Target folder not found' });
        if (await isDescendant(folder.id, parentId)) {
          return res.status(400).json({ error: 'A folder cannot be moved inside itself' });
        }
      }
    }

    if (renaming || moving) {
      const duplicate = await query(
        `SELECT id FROM profiling_folders
         WHERE lower(name) = lower($1) AND parent_id IS NOT DISTINCT FROM $2 AND id <> $3`,
        [name, parentId, folder.id]
      );
      if (duplicate.rowCount > 0) {
        return res.status(409).json({ error: `"${name}" already exists in the target folder` });
      }
    }

    await query(
      `UPDATE profiling_folders
       SET name = $1,
           parent_id = $2,
           locked = COALESCE($3, locked),
           hidden = COALESCE($4, hidden),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
      [
        name,
        parentId,
        req.body.locked === undefined ? null : Boolean(req.body.locked),
        req.body.hidden === undefined ? null : Boolean(req.body.hidden),
        folder.id
      ]
    );

    return res.json(mapFolder(await getFolder(folder.id)));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/profiling/folders/:id - admins delete anything, users delete their
// own empty manual folders
router.delete('/folders/:folderId', async (req, res) => {
  try {
    const folder = await getFolder(req.params.folderId);
    if (!folder) return res.status(404).json({ error: 'Folder not found' });

    const privileged = isPrivilegedRole(req.user.role);
    const children = await query('SELECT COUNT(*)::int AS count FROM profiling_folders WHERE parent_id = $1', [folder.id]);
    const files = await query('SELECT COUNT(*)::int AS count FROM profiling_files WHERE folder_id = $1', [folder.id]);
    const isEmpty = children.rows[0].count === 0 && files.rows[0].count === 0;

    if (!privileged) {
      if (folder.kind === 'auto') {
        return res.status(403).json({ error: 'Year and month folders cannot be deleted' });
      }
      if (folder.created_by !== req.user.id) {
        return res.status(403).json({ error: 'You can only delete folders you created' });
      }
      if (!isEmpty) {
        return res.status(409).json({ error: 'Folder is not empty. Ask an admin to delete it.' });
      }
      if (await isLockedBranch(folder.id)) {
        return res.status(403).json({ error: 'That folder is locked' });
      }
    }

    // Remove the uploaded files of the whole subtree from disk before the
    // cascade wipes their rows.
    const doomed = await query(
      `WITH RECURSIVE tree AS (
         SELECT id FROM profiling_folders WHERE id = $1
         UNION ALL
         SELECT f.id FROM profiling_folders f JOIN tree t ON f.parent_id = t.id
       )
       SELECT fi.file_path FROM profiling_files fi WHERE fi.folder_id IN (SELECT id FROM tree)`,
      [folder.id]
    );

    await query('DELETE FROM profiling_folders WHERE id = $1', [folder.id]);

    for (const row of doomed.rows) {
      try {
        fs.unlinkSync(row.file_path);
      } catch (_err) {
        // file already gone - the row is what mattered
      }
    }

    return res.json({ success: true, deleted_files: doomed.rowCount });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/profiling/files - upload a document into a folder
router.post('/files', upload.single('file'), async (req, res) => {
  try {
    const folderId = req.body.folder_id;
    const title = String(req.body.title || '').trim().slice(0, 200);
    const dateInstalled = req.body.date_installed ? String(req.body.date_installed).slice(0, 10) : null;

    if (!req.file) return res.status(400).json({ error: 'A file is required' });
    if (!folderId || !title) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Folder, name, and file are required' });
    }

    const folder = await getFolder(folderId);
    if (!folder) {
      fs.unlink(req.file.path, () => {});
      return res.status(404).json({ error: 'Folder not found' });
    }
    if (await isLockedBranch(folder.id)) {
      fs.unlink(req.file.path, () => {});
      return res.status(403).json({ error: 'That folder is locked' });
    }

    const id = uuidv4();
    await query(
      `INSERT INTO profiling_files
       (id, folder_id, title, date_installed, file_path, original_name, mime_type, size_bytes, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        folder.id,
        title,
        dateInstalled,
        req.file.path,
        req.file.originalname,
        req.file.mimetype,
        req.file.size,
        req.user.id
      ]
    );

    return res.status(201).json({ id, title, folder_id: folder.id });
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /api/profiling/files/:id - fix the name, date, or folder
router.patch('/files/:fileId', async (req, res) => {
  try {
    const result = await query('SELECT * FROM profiling_files WHERE id = $1', [req.params.fileId]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'File not found' });
    const file = result.rows[0];

    const privileged = isPrivilegedRole(req.user.role);
    if (!privileged && file.uploaded_by !== req.user.id) {
      return res.status(403).json({ error: 'You can only edit files you uploaded' });
    }

    let folderId = file.folder_id;
    if (req.body.folder_id !== undefined) {
      folderId = req.body.folder_id;
      const target = await getFolder(folderId);
      if (!target) return res.status(404).json({ error: 'Target folder not found' });
      if (!privileged && (await isLockedBranch(folderId))) {
        return res.status(403).json({ error: 'That folder is locked' });
      }
    }

    const title = req.body.title === undefined ? file.title : String(req.body.title).trim().slice(0, 200);
    if (!title) return res.status(400).json({ error: 'Name is required' });

    await query(
      `UPDATE profiling_files
       SET title = $1,
           date_installed = COALESCE($2, date_installed),
           folder_id = $3
       WHERE id = $4`,
      [title, req.body.date_installed || null, folderId, file.id]
    );

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/profiling/files/:id
router.delete('/files/:fileId', async (req, res) => {
  try {
    const result = await query('SELECT * FROM profiling_files WHERE id = $1', [req.params.fileId]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'File not found' });
    const file = result.rows[0];

    const privileged = isPrivilegedRole(req.user.role);
    if (!privileged && file.uploaded_by !== req.user.id) {
      return res.status(403).json({ error: 'You can only delete files you uploaded' });
    }
    if (!privileged && (await isLockedBranch(file.folder_id))) {
      return res.status(403).json({ error: 'That folder is locked' });
    }

    await query('DELETE FROM profiling_files WHERE id = $1', [file.id]);
    try {
      fs.unlinkSync(file.file_path);
    } catch (_err) {
      // already gone
    }

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/profiling/files/:id/download
router.get('/files/:fileId/download', async (req, res) => {
  try {
    const result = await query('SELECT * FROM profiling_files WHERE id = $1', [req.params.fileId]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'File not found' });
    const file = result.rows[0];

    if (!fs.existsSync(file.file_path)) {
      return res.status(404).json({ error: 'File is missing from storage' });
    }

    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${(file.original_name || 'document').replace(/"/g, '')}"`
    );
    return fs.createReadStream(file.file_path).pipe(res);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/profiling/audit - admin view: who uploaded what, and where
router.get('/audit', async (req, res) => {
  try {
    if (!isPrivilegedRole(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const result = await query(
      `SELECT fi.id, fi.title, fi.date_installed, fi.original_name, fi.mime_type,
              fi.size_bytes, fi.created_at, fi.folder_id,
              u.name AS uploaded_by_name, f.name AS folder_name
       FROM profiling_files fi
       LEFT JOIN users u ON u.id = fi.uploaded_by
       LEFT JOIN profiling_folders f ON f.id = fi.folder_id
       ORDER BY fi.created_at DESC
       LIMIT $1`,
      [limit]
    );

    const rows = [];
    for (const row of result.rows) {
      const trail = await buildBreadcrumb(row.folder_id);
      rows.push({
        ...row,
        size_bytes: row.size_bytes === null ? null : Number(row.size_bytes),
        path: trail.map((item) => item.name).join(' / ')
      });
    }

    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/profiling/stats - counters for the admin tab
router.get('/stats', async (req, res) => {
  try {
    if (!isPrivilegedRole(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await ensureAutoFolders();
    const result = await query(
      `SELECT
         (SELECT COUNT(*) FROM profiling_folders WHERE kind = 'auto' AND month IS NULL) AS years,
         (SELECT COUNT(*) FROM profiling_folders WHERE kind = 'manual') AS manual_folders,
         (SELECT COUNT(*) FROM profiling_folders WHERE locked) AS locked_folders,
         (SELECT COUNT(*) FROM profiling_folders WHERE hidden) AS hidden_folders,
         (SELECT COUNT(*) FROM profiling_files) AS uploads,
         (SELECT COALESCE(SUM(size_bytes), 0) FROM profiling_files) AS upload_bytes,
         (SELECT COUNT(*) FROM generated_pdfs) AS archived_pdfs`
    );
    const row = result.rows[0];
    return res.json(Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)])));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
