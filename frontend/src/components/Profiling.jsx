import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiRequest, getApiBase } from '../api.js';

/* Profiling - the document archive.
   Year and month folders are created automatically from the generated PDFs;
   everything else is folders and uploads staff add by hand. The same component
   serves both portals: mode="admin" unlocks lock/hide, delete-anything, move,
   and the upload audit. */

function formatBytes(value) {
  if (value === null || value === undefined) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = Number(value);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleDateString();
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

const dialogTitles = {
  'create-folder': 'New folder',
  'rename-folder': 'Rename folder',
  'move-folder': 'Move folder',
  'edit-file': 'Edit document'
};

function folderMeta(folder) {
  const parts = [];
  if (folder.folder_count > 0) parts.push(`${folder.folder_count} folder${folder.folder_count === 1 ? '' : 's'}`);
  if (folder.generated_count > 0) parts.push(`${folder.generated_count} PDF${folder.generated_count === 1 ? '' : 's'}`);
  if (folder.file_count > 0) parts.push(`${folder.file_count} upload${folder.file_count === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' - ') : 'Empty';
}

function fileGlyph(file) {
  if (file.source === 'generated') return 'PDF';
  const mime = file.mime_type || '';
  if (mime.startsWith('image/')) return 'IMG';
  if (mime === 'application/pdf') return 'PDF';
  if (mime.includes('sheet') || mime.includes('excel') || mime === 'text/csv') return 'XLS';
  if (mime.includes('word')) return 'DOC';
  return 'FILE';
}

export default function Profiling({ token, user, mode = 'user' }) {
  const isAdmin = mode === 'admin';
  const [folderId, setFolderId] = useState(null);
  const [view, setView] = useState({ folder: null, breadcrumb: [], folders: [], files: [] });
  const [folderList, setFolderList] = useState([]);
  const [audit, setAudit] = useState([]);
  const [stats, setStats] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [uploadForm, setUploadForm] = useState({ title: '', date_installed: '', file: null });
  const [uploadKey, setUploadKey] = useState(0);
  const [visibleCount, setVisibleCount] = useState(100);
  const [dialog, setDialog] = useState(null);
  const [dialogForm, setDialogForm] = useState({});
  const [confirmBox, setConfirmBox] = useState(null);

  const canWriteHere = useMemo(() => {
    if (!view.folder) return false;
    if (view.folder.locked_branch && !isAdmin) return false;
    return true;
  }, [view.folder, isAdmin]);

  const loadFolder = useCallback(
    async (targetId) => {
      setBusy(true);
      try {
        const params = targetId ? `?parent_id=${encodeURIComponent(targetId)}` : '';
        const data = await apiRequest(`/profiling/folders${params}`, { token });
        setView(data);
        setFolderId(targetId || null);
        setVisibleCount(100);
      } catch (err) {
        setMessage(err.message);
      } finally {
        setBusy(false);
      }
    },
    [token]
  );

  useEffect(() => {
    loadFolder(null);
  }, [loadFolder]);

  const refreshAdminPanels = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const [auditRows, statRow, list] = await Promise.all([
        apiRequest('/profiling/audit?limit=50', { token }),
        apiRequest('/profiling/stats', { token }),
        apiRequest('/profiling/folder-list', { token })
      ]);
      setAudit(auditRows);
      setStats(statRow);
      setFolderList(list);
    } catch (err) {
      setMessage(err.message);
    }
  }, [isAdmin, token]);

  useEffect(() => {
    refreshAdminPanels();
  }, [refreshAdminPanels]);

  // The box searches the whole archive, not the folder on screen: type once and
  // every template, year and month is looked through.
  useEffect(() => {
    const term = search.trim();
    if (term.length < 2) {
      setSearchResults(null);
      setSearching(false);
      return undefined;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const data = await apiRequest(`/profiling/search?q=${encodeURIComponent(term)}`, { token });
        if (!cancelled) setSearchResults(data);
      } catch (err) {
        if (!cancelled) {
          setMessage(err.message);
          setSearchResults({ term, results: [], truncated: false });
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, token]);

  async function reload() {
    await loadFolder(folderId);
    await refreshAdminPanels();
  }

  function openDialog(kind, target = null, form = {}) {
    setDialog({ kind, target });
    setDialogForm(form);
  }

  function closeDialog() {
    setDialog(null);
    setDialogForm({});
  }

  async function submitDialog(event) {
    event.preventDefault();
    if (!dialog) return;
    const { kind, target } = dialog;

    if (kind === 'create-folder') {
      const name = String(dialogForm.name || '').trim();
      if (!name) return;
      setBusy(true);
      setMessage('');
      try {
        await apiRequest('/profiling/folders', {
          method: 'POST',
          token,
          body: { name, parent_id: folderId }
        });
        setMessage(`Created ${name}.`);
        closeDialog();
        await reload();
      } catch (err) {
        setMessage(err.message);
      } finally {
        setBusy(false);
      }
      return;
    }

    if (kind === 'rename-folder') {
      const name = String(dialogForm.name || '').trim();
      if (!name || name === target.name) {
        closeDialog();
        return;
      }
      closeDialog();
      await patchFolder(target.id, { name }, `Renamed to ${name}.`);
      return;
    }

    if (kind === 'move-folder') {
      const parentId = dialogForm.parent_id === 'ROOT' ? null : dialogForm.parent_id;
      closeDialog();
      await patchFolder(
        target.id,
        { parent_id: parentId },
        parentId ? `Moved ${target.name}.` : `Moved ${target.name} to the top level.`
      );
      return;
    }

    if (kind === 'edit-file') {
      const title = String(dialogForm.title || '').trim();
      if (!title) return;
      setBusy(true);
      setMessage('');
      try {
        await apiRequest(`/profiling/files/${target.id}`, {
          method: 'PATCH',
          token,
          body: { title, date_installed: dialogForm.date_installed || undefined }
        });
        setMessage('File updated.');
        closeDialog();
        await reload();
      } catch (err) {
        setMessage(err.message);
      } finally {
        setBusy(false);
      }
    }
  }

  function createFolder() {
    openDialog('create-folder', null, { name: '' });
  }

  async function submitUpload(event) {
    event.preventDefault();
    if (!uploadForm.file || !uploadForm.title.trim()) {
      setMessage('Name and file are required.');
      return;
    }
    const formData = new FormData();
    formData.append('folder_id', folderId);
    formData.append('title', uploadForm.title.trim());
    if (uploadForm.date_installed) formData.append('date_installed', uploadForm.date_installed);
    formData.append('file', uploadForm.file);

    setBusy(true);
    setMessage('');
    try {
      await apiRequest('/profiling/files', { method: 'POST', token, formData });
      setMessage(`Uploaded ${uploadForm.title.trim()}.`);
      setUploadForm({ title: '', date_installed: '', file: null });
      setUploadKey((key) => key + 1);
      setShowUpload(false);
      await reload();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  function renameFolder(folder) {
    openDialog('rename-folder', folder, { name: folder.name });
  }

  function moveFolder(folder) {
    openDialog('move-folder', folder, { parent_id: folder.parent_id || 'ROOT' });
  }

  async function patchFolder(id, body, successMessage) {
    setBusy(true);
    setMessage('');
    try {
      await apiRequest(`/profiling/folders/${id}`, { method: 'PATCH', token, body });
      setMessage(successMessage);
      await reload();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  function deleteFolder(folder) {
    const hasContent = folder.folder_count > 0 || folder.file_count > 0;
    setConfirmBox({
      title: `Delete "${folder.name}"?`,
      body: hasContent
        ? `It holds ${folder.folder_count} folder(s) and ${folder.file_count} upload(s). All of them go with it.`
        : 'The folder is empty.',
      confirmLabel: 'Delete folder',
      onConfirm: () => runDeleteFolder(folder)
    });
  }

  async function runDeleteFolder(folder) {
    setConfirmBox(null);
    setBusy(true);
    setMessage('');
    try {
      const result = await apiRequest(`/profiling/folders/${folder.id}`, { method: 'DELETE', token });
      setMessage(`Deleted ${folder.name}${result.deleted_files ? ` and ${result.deleted_files} file(s)` : ''}.`);
      await reload();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  function deleteFile(file) {
    setConfirmBox({
      title: `Delete "${file.title}"?`,
      body: 'The uploaded file is removed from storage as well.',
      confirmLabel: 'Delete file',
      onConfirm: () => runDeleteFile(file)
    });
  }

  async function runDeleteFile(file) {
    setConfirmBox(null);
    setBusy(true);
    setMessage('');
    try {
      await apiRequest(`/profiling/files/${file.id}`, { method: 'DELETE', token });
      setMessage(`Deleted ${file.title}.`);
      await reload();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  function renameFile(file) {
    openDialog('edit-file', file, {
      title: file.title,
      date_installed: file.date_installed ? String(file.date_installed).slice(0, 10) : ''
    });
  }

  function openFile(file) {
    const base = getApiBase();
    const path = file.source === 'generated'
      ? `/generated-pdfs/${file.id}/download`
      : `/profiling/files/${file.id}/download`;
    fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => {
        if (!response.ok) throw new Error(`Could not open the file (${response.status})`);
        return response.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank', 'noopener,noreferrer');
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      })
      .catch((err) => setMessage(err.message));
  }

  const filteredFiles = view.files;
  const isSearching = search.trim().length >= 2;

  const shownFiles = useMemo(() => filteredFiles.slice(0, visibleCount), [filteredFiles, visibleCount]);

  const lockedNotice = view.folder?.locked_branch;

  return (
    <div className="pf ui-plain">
      {message && (
        <div className="pf-message" role="status" aria-live="polite">
          <span>{message}</span>
          <button type="button" className="pf-message-close" onClick={() => setMessage('')} aria-label="Dismiss">
            &times;
          </button>
        </div>
      )}

      {isAdmin && stats && (
        <div className="pf-stats">
          <div className="pf-stat"><span>Years</span><strong>{stats.years}</strong></div>
          <div className="pf-stat"><span>Manual folders</span><strong>{stats.manual_folders}</strong></div>
          <div className="pf-stat"><span>Uploads</span><strong>{stats.uploads}</strong></div>
          <div className="pf-stat"><span>Upload size</span><strong>{formatBytes(stats.upload_bytes)}</strong></div>
          <div className="pf-stat"><span>Archived PDFs</span><strong>{stats.archived_pdfs}</strong></div>
          <div className="pf-stat"><span>Locked</span><strong>{stats.locked_folders}</strong></div>
        </div>
      )}

      <div className="pf-bar">
        <nav className="pf-crumbs" aria-label="Folder path">
          <button type="button" className="pf-crumb" onClick={() => loadFolder(null)}>Profiling</button>
          {view.breadcrumb.map((crumb) => (
            <React.Fragment key={crumb.id}>
              <span className="pf-crumb-sep">/</span>
              <button
                type="button"
                className={crumb.id === folderId ? 'pf-crumb active' : 'pf-crumb'}
                onClick={() => loadFolder(crumb.id)}
              >
                {crumb.name}
              </button>
            </React.Fragment>
          ))}
        </nav>

        <div className="pf-bar-actions">
          <input
            className="pf-search"
            type="search"
            placeholder="Search the whole archive"
            aria-label="Search the whole archive"
            value={search}
            onChange={(event) => { setSearch(event.target.value); setVisibleCount(100); }}
          />
          <button type="button" onClick={createFolder} disabled={busy || (lockedNotice && !isAdmin)}>
            New folder
          </button>
          <button
            type="button"
            className="pf-primary"
            onClick={() => setShowUpload((open) => !open)}
            disabled={busy || !canWriteHere}
            title={canWriteHere ? 'Upload a document into this folder' : 'Open a folder first'}
          >
            {showUpload ? 'Close upload' : 'Upload file'}
          </button>
        </div>
      </div>

      {lockedNotice && (
        <p className="pf-locked-note">
          This year is locked{isAdmin ? ' - as an admin you can still change it.' : '. Ask an admin to unlock it before adding or removing anything.'}
        </p>
      )}

      {showUpload && canWriteHere && (
        <form className="pf-upload" onSubmit={submitUpload}>
          <div className="pf-upload-head">
            <h4>Add a document to {view.folder?.name}</h4>
            <p className="muted">Name it properly - this is what everyone else will search for.</p>
          </div>
          <div className="pf-upload-grid">
            <label className="pf-field">
              <span>Name</span>
              <input
                type="text"
                value={uploadForm.title}
                onChange={(event) => setUploadForm({ ...uploadForm, title: event.target.value })}
                placeholder="Job order - Dela Cruz, Kawit"
                required
              />
            </label>
            <label className="pf-field">
              <span>Date installed</span>
              <input
                type="date"
                value={uploadForm.date_installed}
                onChange={(event) => setUploadForm({ ...uploadForm, date_installed: event.target.value })}
              />
            </label>
            <label className="pf-field">
              <span>File or image</span>
              <input
                key={uploadKey}
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.bmp,.doc,.docx,.xls,.xlsx,.csv,.txt"
                onChange={(event) => setUploadForm({ ...uploadForm, file: event.target.files?.[0] || null })}
                required
              />
            </label>
          </div>
          <div className="pf-upload-actions">
            <span className="muted">PDF, image, Word, Excel, or text. Up to 25 MB.</span>
            <button type="submit" className="pf-primary" disabled={busy}>
              {busy ? 'Uploading...' : 'Upload'}
            </button>
          </div>
        </form>
      )}

      {isSearching && (
        <section className="pf-section">
          <div className="pf-section-head">
            <h4>Search results</h4>
            <span className="pf-count">{searching ? '...' : (searchResults?.results.length || 0)}</span>
            <span className="muted pf-search-note">
              {searching
                ? `Looking through the archive for "${search.trim()}"`
                : `Everything matching "${search.trim()}", across every template`}
            </span>
            <button type="button" className="pf-clear-search" onClick={() => setSearch('')}>Clear</button>
          </div>

          {!searching && (searchResults?.results.length || 0) === 0 ? (
            <p className="muted pf-empty">No document or upload matches that.</p>
          ) : (
            <div className="table-wrap">
              <table className="pf-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Folder</th>
                    <th>Date</th>
                    <th>Source</th>
                    <th>Added by</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(searchResults?.results || []).map((file) => (
                    <tr key={`${file.source}-${file.id}`}>
                      <td>
                        <div className="pf-file-name">
                          <span className={`pf-file-glyph pf-file-glyph--${fileGlyph(file).toLowerCase()}`}>{fileGlyph(file)}</span>
                          <div>
                            <strong>{file.title}</strong>
                            <span className="pf-file-sub">
                              {file.source === 'generated'
                                ? [file.reference, file.status].filter(Boolean).join(' - ')
                                : file.original_name}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td>
                        <button type="button" className="pf-path-link" onClick={() => { setSearch(''); loadFolder(file.folder_id); }}>
                          {file.path}
                        </button>
                      </td>
                      <td>{formatDate(file.date_installed || file.created_at)}</td>
                      <td>
                        <span className={`pf-badge pf-badge--${file.source === 'generated' ? 'auto' : 'manual'}`}>
                          {file.source === 'generated' ? 'Generated' : 'Upload'}
                        </span>
                      </td>
                      <td>{file.uploaded_by_name || '-'}</td>
                      <td className="actions">
                        <button type="button" onClick={() => openFile(file)}>Open</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {searchResults?.truncated && (
                <div className="pf-more">
                  <span className="muted">Showing the first {searchResults.results.length} matches - narrow the search to see fewer.</span>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {!isSearching && (<>
      <section className="pf-section">
        <div className="pf-section-head">
          <h4>Folders</h4>
          <span className="pf-count">{view.folders.length}</span>
        </div>
        {view.folders.length === 0 ? (
          <p className="muted pf-empty">
            {view.folder ? 'No folders inside this one yet.' : 'No years yet - generate a PDF or create a folder by hand.'}
          </p>
        ) : (
          <div className="pf-folder-grid">
            {view.folders.map((folder) => (
              <article key={folder.id} className={`pf-folder${folder.hidden ? ' is-hidden' : ''}`}>
                <button type="button" className="pf-folder-open" onClick={() => loadFolder(folder.id)}>
                  <span className={`pf-folder-icon pf-folder-icon--${folder.kind}`} aria-hidden="true" />
                  <span className="pf-folder-name">{folder.name}</span>
                  <span className="pf-folder-meta">{folderMeta(folder)}</span>
                </button>
                <div className="pf-folder-badges">
                  {folder.kind === 'template' && <span className="pf-badge pf-badge--template">Template</span>}
                  {folder.kind === 'auto' && <span className="pf-badge pf-badge--auto">Auto</span>}
                  {folder.locked && <span className="pf-badge pf-badge--locked">Locked</span>}
                  {folder.hidden && <span className="pf-badge pf-badge--hidden">Hidden</span>}
                </div>
                {isAdmin && (
                  <div className="pf-folder-admin">
                    <button type="button" onClick={() => renameFolder(folder)}>Rename</button>
                    <button type="button" onClick={() => moveFolder(folder)}>Move</button>
                    <button
                      type="button"
                      onClick={() => patchFolder(folder.id, { locked: !folder.locked }, folder.locked ? 'Unlocked.' : 'Locked.')}
                    >
                      {folder.locked ? 'Unlock' : 'Lock'}
                    </button>
                    <button
                      type="button"
                      onClick={() => patchFolder(folder.id, { hidden: !folder.hidden }, folder.hidden ? 'Visible again.' : 'Hidden from staff.')}
                    >
                      {folder.hidden ? 'Show' : 'Hide'}
                    </button>
                    <button type="button" className="btn-danger" onClick={() => deleteFolder(folder)}>Delete</button>
                  </div>
                )}
                {!isAdmin && folder.kind === 'manual' && folder.created_by === user?.id && (
                  <div className="pf-folder-admin">
                    <button type="button" onClick={() => renameFolder(folder)}>Rename</button>
                    <button type="button" className="btn-danger" onClick={() => deleteFolder(folder)}>Delete</button>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="pf-section">
        <div className="pf-section-head">
          <h4>Files</h4>
          <span className="pf-count">{filteredFiles.length}</span>
        </div>
        {!view.folder ? (
          <p className="muted pf-empty">Open a year to see its documents.</p>
        ) : filteredFiles.length === 0 ? (
          <p className="muted pf-empty">No documents in this folder yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="pf-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Date</th>
                  <th>Source</th>
                  <th>Added by</th>
                  <th>Added</th>
                  <th>Size</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {shownFiles.map((file) => (
                  <tr key={`${file.source}-${file.id}`}>
                    <td>
                      <div className="pf-file-name">
                        <span className={`pf-file-glyph pf-file-glyph--${fileGlyph(file).toLowerCase()}`}>{fileGlyph(file)}</span>
                        <div>
                          <strong>{file.title}</strong>
                          {file.source === 'manual' && file.original_name && (
                            <span className="pf-file-sub">{file.original_name}</span>
                          )}
                          {file.source === 'generated' && (
                            <span className="pf-file-sub">
                              {[file.reference, file.template_title, file.status].filter(Boolean).join(' - ')}
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td>{formatDate(file.date_installed)}</td>
                    <td>
                      <span className={`pf-badge pf-badge--${file.source === 'generated' ? 'auto' : 'manual'}`}>
                        {file.source === 'generated' ? 'Generated' : 'Upload'}
                      </span>
                    </td>
                    <td>{file.uploaded_by_name || '-'}</td>
                    <td>{formatDateTime(file.created_at)}</td>
                    <td>{formatBytes(file.size_bytes)}</td>
                    <td className="actions">
                      <button type="button" onClick={() => openFile(file)}>Open</button>
                      {file.source === 'manual' && (isAdmin || file.uploaded_by === user?.id) && (
                        <>
                          <button type="button" onClick={() => renameFile(file)}>Edit</button>
                          <button type="button" className="btn-danger" onClick={() => deleteFile(file)}>Delete</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filteredFiles.length > shownFiles.length && (
              <div className="pf-more">
                <span className="muted">
                  Showing {shownFiles.length} of {filteredFiles.length}
                </span>
                <button type="button" onClick={() => setVisibleCount((count) => count + 200)}>
                  Show more
                </button>
              </div>
            )}
          </div>
        )}
      </section>
      </>)}


      {dialog && (
        <div className="pf-modal-backdrop" role="presentation" onClick={closeDialog}>
          <form
            className="pf-modal"
            role="dialog"
            aria-modal="true"
            aria-label={dialogTitles[dialog.kind]}
            onClick={(event) => event.stopPropagation()}
            onSubmit={submitDialog}
          >
            <h4>{dialogTitles[dialog.kind]}</h4>

            {(dialog.kind === 'create-folder' || dialog.kind === 'rename-folder') && (
              <label className="pf-field">
                <span>Folder name</span>
                <input
                  type="text"
                  autoFocus
                  value={dialogForm.name || ''}
                  onChange={(event) => setDialogForm({ ...dialogForm, name: event.target.value })}
                  placeholder={folderId ? 'January' : '2021'}
                  required
                />
              </label>
            )}

            {dialog.kind === 'move-folder' && (
              <label className="pf-field">
                <span>Move into</span>
                <select
                  value={dialogForm.parent_id || 'ROOT'}
                  onChange={(event) => setDialogForm({ ...dialogForm, parent_id: event.target.value })}
                >
                  <option value="ROOT">Top level</option>
                  {folderList
                    .filter((item) => item.id !== dialog.target.id)
                    .map((item) => (
                      <option key={item.id} value={item.id}>{item.path}</option>
                    ))}
                </select>
              </label>
            )}

            {dialog.kind === 'edit-file' && (
              <>
                <label className="pf-field">
                  <span>Name</span>
                  <input
                    type="text"
                    autoFocus
                    value={dialogForm.title || ''}
                    onChange={(event) => setDialogForm({ ...dialogForm, title: event.target.value })}
                    required
                  />
                </label>
                <label className="pf-field">
                  <span>Date installed</span>
                  <input
                    type="date"
                    value={dialogForm.date_installed || ''}
                    onChange={(event) => setDialogForm({ ...dialogForm, date_installed: event.target.value })}
                  />
                </label>
              </>
            )}

            <div className="pf-modal-actions">
              <button type="button" onClick={closeDialog}>Cancel</button>
              <button type="submit" className="pf-primary" disabled={busy}>
                {dialog.kind === 'create-folder' ? 'Create folder' : 'Save'}
              </button>
            </div>
          </form>
        </div>
      )}

      {confirmBox && (
        <div className="pf-modal-backdrop" role="presentation" onClick={() => setConfirmBox(null)}>
          <div
            className="pf-modal"
            role="alertdialog"
            aria-modal="true"
            aria-label={confirmBox.title}
            onClick={(event) => event.stopPropagation()}
          >
            <h4>{confirmBox.title}</h4>
            <p className="muted">{confirmBox.body}</p>
            <div className="pf-modal-actions">
              <button type="button" onClick={() => setConfirmBox(null)}>Cancel</button>
              <button type="button" className="btn-danger" onClick={confirmBox.onConfirm} disabled={busy}>
                {confirmBox.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {isAdmin && (
        <section className="pf-section">
          <div className="pf-section-head">
            <h4>Upload history</h4>
            <span className="pf-count">{audit.length}</span>
          </div>
          {audit.length === 0 ? (
            <p className="muted pf-empty">Nobody has uploaded anything yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="pf-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Where</th>
                    <th>Date installed</th>
                    <th>Uploaded by</th>
                    <th>Uploaded</th>
                    <th>Size</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((row) => (
                    <tr key={row.id}>
                      <td><strong>{row.title}</strong><span className="pf-file-sub">{row.original_name}</span></td>
                      <td>{row.path || row.folder_name || '-'}</td>
                      <td>{formatDate(row.date_installed)}</td>
                      <td>{row.uploaded_by_name || '-'}</td>
                      <td>{formatDateTime(row.created_at)}</td>
                      <td>{formatBytes(row.size_bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
