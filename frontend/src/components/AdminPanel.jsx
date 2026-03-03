import { useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest, downloadWithToken, fetchArrayBuffer } from '../api.js';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/build/pdf.mjs';
import workerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url';

GlobalWorkerOptions.workerSrc = workerSrc;

const statusTabs = ['pending', 'done', 'cancelled', 'rescheduled'];

function clampRect(rect) {
  if (!rect) return null;
  const width = Math.max(6, rect.width);
  const height = Math.max(6, rect.height);
  return { ...rect, width, height };
}

export default function AdminPanel({ token, user, onLogout, theme = 'light', onToggleTheme }) {
  const [templates, setTemplates] = useState([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [fields, setFields] = useState([]);
  const [items, setItems] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [activeStatus, setActiveStatus] = useState('pending');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [users, setUsers] = useState([]);
  const [presets, setPresets] = useState([]);
  const [editingFieldId, setEditingFieldId] = useState('');

  const [uploadForm, setUploadForm] = useState({ title: '', description: '', file: null });
  const [templateEditForm, setTemplateEditForm] = useState({ title: '', description: '' });
  const [userForm, setUserForm] = useState({
    name: '',
    email: '',
    password: '',
    role: 'user'
  });
  const [showCreatePassword, setShowCreatePassword] = useState(false);
  const [presetForm, setPresetForm] = useState({
    name: '',
    field_type: 'text',
    field_options_text: '',
    regex: '',
    min_length: '',
    max_length: ''
  });
  const [fieldForm, setFieldForm] = useState({
    field_name: '',
    field_type: 'text',
    field_options_text: '',
    regex: '',
    min_length: '',
    max_length: '',
    required_if_field: '',
    required_if_value: '',
    page_number: 1,
    x_position: 0,
    y_position: 0,
    box_width: 0,
    box_height: 0,
    auto_font: true,
    required: false
  });

  const [pdfDoc, setPdfDoc] = useState(null);
  const [pdfMeta, setPdfMeta] = useState({ width: 0, height: 0, pages: 0 });
  const [renderMeta, setRenderMeta] = useState({ width: 0, height: 0 });
  const [drawing, setDrawing] = useState(null);
  const [selectedRect, setSelectedRect] = useState(null);
  const [selectedRows, setSelectedRows] = useState({});
  const [bulkStatus, setBulkStatus] = useState('done');
  const [bulkRescheduleDate, setBulkRescheduleDate] = useState('');
  const [listFilters, setListFilters] = useState({
    keyword: '',
    user_id: '',
    date_from: '',
    date_to: ''
  });

  const canvasRef = useRef(null);
  const overlayRef = useRef(null);

  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === selectedTemplateId),
    [templates, selectedTemplateId]
  );

  const pageFields = useMemo(
    () => fields.filter((field) => Number(field.page_number) === Number(fieldForm.page_number)),
    [fields, fieldForm.page_number]
  );

  async function loadTemplates() {
    const data = await apiRequest('/templates', { token });
    setTemplates(data);
    if (!selectedTemplateId && data[0]?.id) {
      setSelectedTemplateId(data[0].id);
    }
  }

  async function loadFields(templateId) {
    if (!templateId) return;
    const data = await apiRequest(`/templates/${templateId}/fields`, { token });
    setFields(data);
  }

  async function loadGenerated(templateId, status) {
    if (!templateId) return;
    const params = new URLSearchParams({ template_id: templateId, status });
    if (listFilters.keyword) params.set('keyword', listFilters.keyword);
    if (listFilters.user_id) params.set('user_id', listFilters.user_id);
    if (listFilters.date_from) params.set('date_from', listFilters.date_from);
    if (listFilters.date_to) params.set('date_to', listFilters.date_to);
    const data = await apiRequest(`/generated-pdfs?${params.toString()}`, { token });
    setItems(data);
    setSelectedRows({});
  }

  async function loadUsers() {
    const data = await apiRequest('/users', { token });
    setUsers(data);
  }

  async function loadPresets() {
    const data = await apiRequest('/templates/presets', { token });
    setPresets(data);
  }

  async function loadAnalytics(templateId) {
    if (!templateId) {
      setAnalytics(null);
      return;
    }
    const data = await apiRequest(`/generated-pdfs/analytics/template/${templateId}`, { token });
    setAnalytics(data);
  }

  async function loadPdfPreview(templateId) {
    if (!templateId) {
      setPdfDoc(null);
      return;
    }

    const bytes = await fetchArrayBuffer(`/templates/${templateId}/file`, token);
    const doc = await getDocument({ data: bytes }).promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });

    setPdfDoc(doc);
    setPdfMeta({ width: base.width, height: base.height, pages: doc.numPages });
    setFieldForm((prev) => ({ ...prev, page_number: Math.min(prev.page_number || 1, doc.numPages) }));
  }

  async function renderPage() {
    if (!pdfDoc || !canvasRef.current) return;

    const pageNumber = Number(fieldForm.page_number) || 1;
    const page = await pdfDoc.getPage(pageNumber);
    const desiredWidth = Math.min(900, window.innerWidth - 120);
    const scale = desiredWidth / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({ scale });

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await page.render({ canvasContext: ctx, viewport }).promise;

    const bounds = canvas.getBoundingClientRect();
    setRenderMeta({ width: bounds.width, height: bounds.height });
    setSelectedRect(null);
  }

  useEffect(() => {
    loadTemplates().catch((err) => setMessage(err.message));
    loadUsers().catch((err) => setMessage(err.message));
    loadPresets().catch((err) => setMessage(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedTemplateId) return;
    loadFields(selectedTemplateId).catch((err) => setMessage(err.message));
    loadGenerated(selectedTemplateId, activeStatus).catch((err) => setMessage(err.message));
    loadAnalytics(selectedTemplateId).catch((err) => setMessage(err.message));
    loadPdfPreview(selectedTemplateId).catch((err) => setMessage(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTemplateId, activeStatus, listFilters.keyword, listFilters.user_id, listFilters.date_from, listFilters.date_to]);

  useEffect(() => {
    renderPage().catch((err) => setMessage(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfDoc, fieldForm.page_number]);

  useEffect(() => {
    const onResize = () => {
      renderPage().catch((err) => setMessage(err.message));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfDoc, fieldForm.page_number]);

  useEffect(() => {
    if (!selectedTemplate) return;
    setTemplateEditForm({
      title: selectedTemplate.title || '',
      description: selectedTemplate.description || ''
    });
  }, [selectedTemplate]);

  async function submitTemplate(e) {
    e.preventDefault();
    if (!uploadForm.file) {
      setMessage('Please choose a PDF file.');
      return;
    }

    setBusy(true);
    setMessage('');
    try {
      const formData = new FormData();
      formData.append('title', uploadForm.title);
      formData.append('description', uploadForm.description);
      formData.append('template', uploadForm.file);

      const created = await apiRequest('/templates', {
        method: 'POST',
        token,
        formData
      });

      setUploadForm({ title: '', description: '', file: null });
      await loadTemplates();
      setSelectedTemplateId(created.id);
      setMessage('Template uploaded.');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitUser(e) {
    e.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      await apiRequest('/users', {
        method: 'POST',
        token,
        body: userForm
      });
      setUserForm({ name: '', email: '', password: '', role: 'user' });
      await loadUsers();
      setMessage('User account created.');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  function resetFieldForm() {
    setEditingFieldId('');
    setFieldForm((prev) => ({
      ...prev,
      field_name: '',
      field_type: 'text',
      field_options_text: '',
      regex: '',
      min_length: '',
      max_length: '',
      required_if_field: '',
      required_if_value: '',
      x_position: 0,
      y_position: 0,
      box_width: 0,
      box_height: 0,
      required: false
    }));
    setSelectedRect(null);
  }

  function startEditField(field) {
    const pageNumber = Number(field.page_number);
    setEditingFieldId(field.id);
    const rules = field.validation_rules || {};
    setFieldForm({
      field_name: field.field_name,
      field_type: field.field_type || 'text',
      field_options_text: Array.isArray(field.field_options) ? field.field_options.join('\n') : '',
      regex: rules.regex || '',
      min_length: rules.min_length ?? '',
      max_length: rules.max_length ?? '',
      required_if_field: rules.required_if?.field || '',
      required_if_value: rules.required_if?.equals ?? '',
      page_number: pageNumber,
      x_position: Number(field.x_position),
      y_position: Number(field.y_position),
      box_width: Number(field.box_width || 0),
      box_height: Number(field.box_height || 0),
      auto_font: field.auto_font !== false,
      required: Boolean(field.required)
    });

    if (renderMeta.width && pdfMeta.width && pageNumber === Number(fieldForm.page_number)) {
      const left = (Number(field.x_position) / pdfMeta.width) * renderMeta.width;
      const top = ((pdfMeta.height - Number(field.y_position) - Number(field.box_height || 0)) / pdfMeta.height) * renderMeta.height;
      const width = (Number(field.box_width || 0) / pdfMeta.width) * renderMeta.width;
      const height = (Number(field.box_height || 0) / pdfMeta.height) * renderMeta.height;
      setSelectedRect(clampRect({ left, top, width, height }));
    } else {
      setSelectedRect(null);
    }
  }

  async function removeField(fieldId) {
    const ok = window.confirm('Delete this mapped field?');
    if (!ok) return;
    setBusy(true);
    setMessage('');
    try {
      await apiRequest(`/templates/fields/${fieldId}`, { method: 'DELETE', token });
      if (editingFieldId === fieldId) {
        resetFieldForm();
      }
      await loadFields(selectedTemplateId);
      setMessage('Field deleted.');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitField(e) {
    e.preventDefault();
    if (!selectedTemplateId) {
      setMessage('Select a template first.');
      return;
    }

    if (!selectedRect) {
      setMessage('Draw a box on the preview first.');
      return;
    }

    setBusy(true);
    setMessage('');
    try {
      const payload = {
        field_name: fieldForm.field_name,
        field_type: fieldForm.field_type,
        field_options: fieldForm.field_type === 'dropdown'
          ? fieldForm.field_options_text.split('\n').map((v) => v.trim()).filter(Boolean)
          : [],
        validation_rules: {
          regex: fieldForm.regex || undefined,
          min_length: fieldForm.min_length === '' ? undefined : Number(fieldForm.min_length),
          max_length: fieldForm.max_length === '' ? undefined : Number(fieldForm.max_length),
          required_if: fieldForm.required_if_field
            ? { field: fieldForm.required_if_field, equals: fieldForm.required_if_value }
            : undefined
        },
        page_number: Number(fieldForm.page_number),
        x_position: Number(fieldForm.x_position),
        y_position: Number(fieldForm.y_position),
        box_width: Number(fieldForm.box_width),
        box_height: Number(fieldForm.box_height),
        font_size: Math.round(Number(fieldForm.box_height) * 0.75),
        auto_font: true,
        required: fieldForm.required
      };

      if (editingFieldId) {
        await apiRequest(`/templates/fields/${editingFieldId}`, {
          method: 'PUT',
          token,
          body: payload
        });
      } else {
        await apiRequest(`/templates/${selectedTemplateId}/fields`, {
          method: 'POST',
          token,
          body: payload
        });
      }

      resetFieldForm();
      await loadFields(selectedTemplateId);
      setMessage(editingFieldId ? 'Field updated.' : 'Field mapped with box coordinates.');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function updateTemplate() {
    if (!selectedTemplateId) return;
    setBusy(true);
    setMessage('');
    try {
      await apiRequest(`/templates/${selectedTemplateId}`, {
        method: 'PUT',
        token,
        body: {
          title: templateEditForm.title,
          description: templateEditForm.description
        }
      });
      await loadTemplates();
      setMessage('Template updated.');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteTemplate() {
    if (!selectedTemplateId) return;
    const ok = window.confirm('Delete this template and all generated files under it?');
    if (!ok) return;
    setBusy(true);
    setMessage('');
    try {
      await apiRequest(`/templates/${selectedTemplateId}`, {
        method: 'DELETE',
        token
      });
      setSelectedTemplateId('');
      setFields([]);
      setItems([]);
      setPdfDoc(null);
      resetFieldForm();
      await loadTemplates();
      setMessage('Template deleted.');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function exportTemplateData(format = 'csv') {
    if (!selectedTemplateId) {
      setMessage('Select a template first.');
      return;
    }
    try {
      const params = new URLSearchParams({
        template_id: selectedTemplateId,
        format
      });
      await downloadWithToken(`/generated-pdfs/export?${params.toString()}`, token);
    } catch (err) {
      setMessage(err.message);
    }
  }

  function applyPreset(preset) {
    const rules = preset.validation_rules || {};
    setFieldForm((prev) => ({
      ...prev,
      field_type: preset.field_type || 'text',
      field_options_text: Array.isArray(preset.field_options) ? preset.field_options.join('\n') : '',
      regex: rules.regex || '',
      min_length: rules.min_length ?? '',
      max_length: rules.max_length ?? ''
    }));
  }

  async function createPreset(e) {
    e.preventDefault();
    try {
      await apiRequest('/templates/presets', {
        method: 'POST',
        token,
        body: {
          name: presetForm.name,
          field_type: presetForm.field_type,
          field_options: presetForm.field_type === 'dropdown'
            ? presetForm.field_options_text.split('\n').map((v) => v.trim()).filter(Boolean)
            : [],
          validation_rules: {
            regex: presetForm.regex || undefined,
            min_length: presetForm.min_length === '' ? undefined : Number(presetForm.min_length),
            max_length: presetForm.max_length === '' ? undefined : Number(presetForm.max_length)
          }
        }
      });
      setPresetForm({
        name: '',
        field_type: 'text',
        field_options_text: '',
        regex: '',
        min_length: '',
        max_length: ''
      });
      await loadPresets();
      setMessage('Preset created.');
    } catch (err) {
      setMessage(err.message);
    }
  }

  async function deletePreset(presetId) {
    const ok = window.confirm('Delete this preset?');
    if (!ok) return;
    try {
      await apiRequest(`/templates/presets/${presetId}`, {
        method: 'DELETE',
        token
      });
      await loadPresets();
      setMessage('Preset deleted.');
    } catch (err) {
      setMessage(err.message);
    }
  }

  async function viewHistory(generatedPdfId) {
    try {
      const rows = await apiRequest(`/generated-pdfs/${generatedPdfId}/history`, { token });
      const text = rows.length
        ? rows.map((h) => `${new Date(h.created_at).toLocaleString()} | ${h.old_status || '-'} -> ${h.new_status} | ${h.changed_by_name || h.changed_by || '-'} | ${h.note || ''}`).join('\n')
        : 'No history found.';
      window.alert(text);
    } catch (err) {
      setMessage(err.message);
    }
  }

  async function applyBulkStatus() {
    const ids = Object.entries(selectedRows).filter(([, v]) => v).map(([id]) => id);
    if (!ids.length) {
      setMessage('Select at least one record.');
      return;
    }
    const note = window.prompt('Optional note for bulk action:', '') || null;
    try {
      await apiRequest('/generated-pdfs/bulk-status', {
        method: 'POST',
        token,
        body: {
          ids,
          status: bulkStatus,
          note,
          reschedule_date: bulkStatus === 'rescheduled' ? (bulkRescheduleDate || null) : null
        }
      });
      await loadGenerated(selectedTemplateId, activeStatus);
      await loadAnalytics(selectedTemplateId);
      setMessage(`Bulk status updated: ${ids.length} records.`);
    } catch (err) {
      setMessage(err.message);
    }
  }

  function toPdfRect(clientX, clientY, startX, startY) {
    if (!overlayRef.current || !renderMeta.width || !pdfMeta.width) return null;

    const bounds = overlayRef.current.getBoundingClientRect();
    const endX = clientX - bounds.left;
    const endY = clientY - bounds.top;

    const left = Math.max(0, Math.min(startX, endX));
    const top = Math.max(0, Math.min(startY, endY));
    const width = Math.min(bounds.width - left, Math.abs(endX - startX));
    const height = Math.min(bounds.height - top, Math.abs(endY - startY));

    const rect = clampRect({ left, top, width, height });
    if (!rect) return null;

    const scaleX = pdfMeta.width / renderMeta.width;
    const scaleY = pdfMeta.height / renderMeta.height;

    const x = rect.left * scaleX;
    const boxWidth = rect.width * scaleX;
    const boxHeight = rect.height * scaleY;
    const y = pdfMeta.height - (rect.top + rect.height) * scaleY;

    setFieldForm((prev) => ({
      ...prev,
      x_position: Number(x.toFixed(2)),
      y_position: Number(y.toFixed(2)),
      box_width: Number(boxWidth.toFixed(2)),
      box_height: Number(boxHeight.toFixed(2))
    }));

    return rect;
  }

  function onOverlayMouseDown(e) {
    if (!overlayRef.current) return;
    const bounds = overlayRef.current.getBoundingClientRect();
    const x = e.clientX - bounds.left;
    const y = e.clientY - bounds.top;
    setDrawing({ startX: x, startY: y });
    setSelectedRect({ left: x, top: y, width: 6, height: 6 });
  }

  function onOverlayMouseMove(e) {
    if (!drawing) return;
    const rect = toPdfRect(e.clientX, e.clientY, drawing.startX, drawing.startY);
    if (rect) setSelectedRect(rect);
  }

  function onOverlayMouseUp(e) {
    if (!drawing) return;
    const rect = toPdfRect(e.clientX, e.clientY, drawing.startX, drawing.startY);
    setDrawing(null);
    if (rect) setSelectedRect(rect);
  }

  async function updateStatus(itemId, status) {
    const note = window.prompt('Optional note/reason:', '') || null;
    let rescheduleDate = null;

    if (status === 'rescheduled') {
      const raw = window.prompt('Reschedule date/time (YYYY-MM-DDTHH:mm:ss), optional:', '');
      rescheduleDate = raw || null;
    }

    setBusy(true);
    setMessage('');
    try {
      await apiRequest(`/generated-pdfs/${itemId}/status`, {
        method: 'PATCH',
        token,
        body: {
          status,
          note,
          reschedule_date: rescheduleDate
        }
      });
      await loadGenerated(selectedTemplateId, activeStatus);
      setMessage(`Status updated to ${status}.`);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function changeUserPassword(userId) {
    const password = window.prompt('Enter new password (min 6 chars):', '');
    if (!password) return;
    setBusy(true);
    setMessage('');
    try {
      await apiRequest(`/users/${userId}/password`, {
        method: 'PATCH',
        token,
        body: { password }
      });
      setMessage('Password updated.');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function resetAndShowUserPassword(userId) {
    const ok = window.confirm('Reset this user password and view the temporary password?');
    if (!ok) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await apiRequest(`/users/${userId}/password/reset`, {
        method: 'POST',
        token
      });
      window.prompt('Temporary password (copy now):', result.temp_password);
      setMessage('Temporary password generated.');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="layout">
      <header className="topbar">
        <div>
          <h2>Admin Console</h2>
          <p className="muted">{user.name} ({user.role})</p>
        </div>
        <div className="topbar-actions">
          <button type="button" className="theme-btn" onClick={onToggleTheme}>
            {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
          </button>
          <button type="button" className="logout-btn" onClick={onLogout}>Logout</button>
        </div>
      </header>

      {message && <div className="notice">{message}</div>}

      <section className="grid two">
        <form className="card" onSubmit={submitTemplate}>
          <h3>Upload Template</h3>
          <label>Title</label>
          <input
            value={uploadForm.title}
            onChange={(e) => setUploadForm({ ...uploadForm, title: e.target.value })}
            required
          />
          <label>Description</label>
          <textarea
            value={uploadForm.description}
            onChange={(e) => setUploadForm({ ...uploadForm, description: e.target.value })}
            rows={3}
          />
          <label>PDF File</label>
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => setUploadForm({ ...uploadForm, file: e.target.files?.[0] || null })}
            required
          />
          <button disabled={busy}>{busy ? 'Saving...' : 'Save Template'}</button>
        </form>

        <div className="card">
          <h3>Template Selector</h3>
          <select value={selectedTemplateId} onChange={(e) => setSelectedTemplateId(e.target.value)}>
            <option value="">Select template</option>
            {templates.map((tpl) => (
              <option key={tpl.id} value={tpl.id}>{tpl.title}</option>
            ))}
          </select>
          {selectedTemplate && (
            <div className="template-meta">
              <div><strong>Title:</strong> {selectedTemplate.title}</div>
              <div><strong>Description:</strong> {selectedTemplate.description || '-'}</div>
            </div>
          )}
          {selectedTemplate && (
            <div className="template-ops">
              <label>Rename Title</label>
              <input
                value={templateEditForm.title}
                onChange={(e) => setTemplateEditForm({ ...templateEditForm, title: e.target.value })}
              />
              <label>Edit Description</label>
              <textarea
                rows={2}
                value={templateEditForm.description}
                onChange={(e) => setTemplateEditForm({ ...templateEditForm, description: e.target.value })}
              />
              <div className="actions">
                <button type="button" onClick={updateTemplate} disabled={busy || !templateEditForm.title}>Save Template</button>
                <button type="button" className="warn" onClick={deleteTemplate} disabled={busy}>Delete Template</button>
                <button type="button" onClick={() => exportTemplateData('csv')} disabled={busy}>Export Data CSV</button>
                <button type="button" onClick={() => exportTemplateData('json')} disabled={busy}>Export Data JSON</button>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="grid two">
        <form className="card" onSubmit={submitUser}>
          <h3>Create User Account</h3>
          <p className="muted">User can login using name or email.</p>
          <label>Name</label>
          <input
            value={userForm.name}
            onChange={(e) => setUserForm({ ...userForm, name: e.target.value })}
            required
          />
          <label>Email</label>
          <input
            type="email"
            value={userForm.email}
            onChange={(e) => setUserForm({ ...userForm, email: e.target.value })}
            required
          />
          <label>Password</label>
          <input
            type={showCreatePassword ? 'text' : 'password'}
            value={userForm.password}
            onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
            required
          />
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={showCreatePassword}
              onChange={(e) => setShowCreatePassword(e.target.checked)}
            />
            View typed password
          </label>
          <label>Role</label>
          <select
            value={userForm.role}
            onChange={(e) => setUserForm({ ...userForm, role: e.target.value })}
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
            {user.role === 'super_admin' && <option value="super_admin">super_admin</option>}
          </select>
          <button disabled={busy}>{busy ? 'Saving...' : 'Create User'}</button>
        </form>

        <div className="card">
          <h3>User Accounts</h3>
          <p className="muted">Stored passwords are hashed. Use "View Temp" to reset and reveal a temporary password.</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Password</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.name}</td>
                    <td>{u.email}</td>
                    <td>{u.role}</td>
                    <td className="actions">
                      <button type="button" onClick={() => changeUserPassword(u.id)}>Change</button>
                      <button type="button" onClick={() => resetAndShowUserPassword(u.id)}>View Temp</button>
                    </td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr>
                    <td colSpan="4">No users found.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="grid two">
        <form className="card" onSubmit={createPreset}>
          <h3>Field Presets</h3>
          <label>Preset Name</label>
          <input
            value={presetForm.name}
            onChange={(e) => setPresetForm({ ...presetForm, name: e.target.value })}
            required
          />
          <label>Type</label>
          <select
            value={presetForm.field_type}
            onChange={(e) => setPresetForm({ ...presetForm, field_type: e.target.value })}
          >
            <option value="text">text</option>
            <option value="dropdown">dropdown</option>
            <option value="date">date</option>
            <option value="order_number">order_number</option>
          </select>
          {presetForm.field_type === 'dropdown' && (
            <>
              <label>Options (one per line)</label>
              <textarea
                rows={3}
                value={presetForm.field_options_text}
                onChange={(e) => setPresetForm({ ...presetForm, field_options_text: e.target.value })}
                required
              />
            </>
          )}
          <label>Regex (optional)</label>
          <input
            value={presetForm.regex}
            onChange={(e) => setPresetForm({ ...presetForm, regex: e.target.value })}
          />
          <label>Min Length</label>
          <input
            type="number"
            min="0"
            value={presetForm.min_length}
            onChange={(e) => setPresetForm({ ...presetForm, min_length: e.target.value })}
          />
          <label>Max Length</label>
          <input
            type="number"
            min="0"
            value={presetForm.max_length}
            onChange={(e) => setPresetForm({ ...presetForm, max_length: e.target.value })}
          />
          <button>Create Preset</button>
        </form>

        <div className="card">
          <h3>Available Presets</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {presets.map((preset) => (
                  <tr key={preset.id}>
                    <td>{preset.name}</td>
                    <td>{preset.field_type}</td>
                    <td className="actions">
                      <button type="button" onClick={() => applyPreset(preset)}>Use</button>
                      <button type="button" onClick={() => deletePreset(preset.id)}>Delete</button>
                    </td>
                  </tr>
                ))}
                {presets.length === 0 && (
                  <tr>
                    <td colSpan="3">No presets yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="grid two">
        <form className="card" onSubmit={submitField}>
          <h3>{editingFieldId ? 'Edit Field Mapping' : 'Field Mapping'}</h3>
          <label>Field Name</label>
          <input
            value={fieldForm.field_name}
            onChange={(e) => setFieldForm({ ...fieldForm, field_name: e.target.value })}
            required
          />
          <label>Field Type</label>
          <select
            value={fieldForm.field_type}
            onChange={(e) => setFieldForm({ ...fieldForm, field_type: e.target.value })}
          >
            <option value="text">text</option>
            <option value="dropdown">dropdown</option>
            <option value="date">date (today default)</option>
            <option value="order_number">order number (auto)</option>
          </select>
          {fieldForm.field_type === 'dropdown' && (
            <>
              <label>Dropdown Options (one per line)</label>
              <textarea
                rows={4}
                value={fieldForm.field_options_text}
                onChange={(e) => setFieldForm({ ...fieldForm, field_options_text: e.target.value })}
                placeholder={'Option 1\nOption 2\nOption 3'}
                required
              />
            </>
          )}
          <label>Regex Rule (optional)</label>
          <input
            value={fieldForm.regex}
            onChange={(e) => setFieldForm({ ...fieldForm, regex: e.target.value })}
            placeholder="e.g. ^[0-9]{11}$"
          />
          <label>Min Length (optional)</label>
          <input
            type="number"
            min="0"
            value={fieldForm.min_length}
            onChange={(e) => setFieldForm({ ...fieldForm, min_length: e.target.value })}
          />
          <label>Max Length (optional)</label>
          <input
            type="number"
            min="0"
            value={fieldForm.max_length}
            onChange={(e) => setFieldForm({ ...fieldForm, max_length: e.target.value })}
          />
          <label>Required If Field (optional)</label>
          <input
            value={fieldForm.required_if_field}
            onChange={(e) => setFieldForm({ ...fieldForm, required_if_field: e.target.value })}
            placeholder="other_field_name"
          />
          <label>Required If Equals (optional)</label>
          <input
            value={fieldForm.required_if_value}
            onChange={(e) => setFieldForm({ ...fieldForm, required_if_value: e.target.value })}
            placeholder="trigger value"
          />
          <label>Page Number</label>
          <input
            type="number"
            min="1"
            max={pdfMeta.pages || 1}
            value={fieldForm.page_number}
            onChange={(e) => setFieldForm({ ...fieldForm, page_number: Number(e.target.value || 1) })}
            required
          />
          <label>Mapped X</label>
          <input type="number" value={fieldForm.x_position} readOnly />
          <label>Mapped Y</label>
          <input type="number" value={fieldForm.y_position} readOnly />
          <label>Box Width</label>
          <input type="number" value={fieldForm.box_width} readOnly />
          <label>Box Height</label>
          <input type="number" value={fieldForm.box_height} readOnly />
          <label>Auto Font Size</label>
          <input type="number" value={Math.max(6, Math.round(Number(fieldForm.box_height || 0) * 0.75))} readOnly />
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={fieldForm.required}
              onChange={(e) => setFieldForm({ ...fieldForm, required: e.target.checked })}
            />
            Required
          </label>
          <div className="actions">
            <button disabled={busy || !selectedRect}>
              {editingFieldId ? 'Update Field' : 'Add Field From Box'}
            </button>
            {editingFieldId && (
              <button type="button" onClick={resetFieldForm}>Cancel Edit</button>
            )}
          </div>
        </form>

        <div className="card">
          <h3>Template Preview Mapper</h3>
          <p className="muted">Drag a box on the PDF page to set X, Y, width, height.</p>
          <div className="pdf-stage">
            <canvas ref={canvasRef} className="pdf-canvas" />
            <div
              ref={overlayRef}
              className="pdf-overlay"
              style={{ width: `${renderMeta.width}px`, height: `${renderMeta.height}px` }}
              onMouseDown={onOverlayMouseDown}
              onMouseMove={onOverlayMouseMove}
              onMouseUp={onOverlayMouseUp}
              onMouseLeave={onOverlayMouseUp}
            >
              {pageFields.map((field) => {
                const left = (Number(field.x_position) / pdfMeta.width) * renderMeta.width;
                const top = ((pdfMeta.height - Number(field.y_position) - Number(field.box_height || 0)) / pdfMeta.height) * renderMeta.height;
                const width = (Number(field.box_width || 0) / pdfMeta.width) * renderMeta.width;
                const height = (Number(field.box_height || 0) / pdfMeta.height) * renderMeta.height;
                return (
                  <div
                    key={field.id}
                    className="field-rect existing"
                    style={{ left, top, width, height }}
                    title={field.field_name}
                  >
                    <span>{field.field_name}</span>
                  </div>
                );
              })}

              {selectedRect && (
                <div
                  className="field-rect active"
                  style={{
                    left: selectedRect.left,
                    top: selectedRect.top,
                    width: selectedRect.width,
                    height: selectedRect.height
                  }}
                />
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="card">
        <h3>Mapped Fields</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Page</th>
                <th>X</th>
                <th>Y</th>
                <th>W</th>
                <th>H</th>
                <th>Auto Font</th>
                <th>Req</th>
                <th>Rules</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((field) => (
                <tr key={field.id}>
                  <td>{field.field_name}</td>
                  <td>{field.field_type || 'text'}</td>
                  <td>{field.page_number}</td>
                  <td>{field.x_position}</td>
                  <td>{field.y_position}</td>
                  <td>{field.box_width || '-'}</td>
                  <td>{field.box_height || '-'}</td>
                  <td>{field.auto_font ? 'Yes' : 'No'}</td>
                  <td>{field.required ? 'Yes' : 'No'}</td>
                  <td>
                    {field.validation_rules
                      ? JSON.stringify(field.validation_rules)
                      : '-'}
                  </td>
                  <td className="actions">
                    <button type="button" onClick={() => startEditField(field)}>Edit</button>
                    <button type="button" onClick={() => removeField(field.id)}>Delete</button>
                  </td>
                </tr>
              ))}
              {fields.length === 0 && (
                <tr>
                  <td colSpan="11">No fields mapped yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h3>Template Analytics</h3>
        <p className="muted">Monthly metrics (reset every 1st day of the month).</p>
        {analytics ? (
          <div className="grid two">
            <div className="card">
              <div><strong>Total Generated:</strong> {analytics.total_generated}</div>
              <div><strong>Pending Backlog:</strong> {analytics.pending_backlog}</div>
              <div><strong>Done:</strong> {analytics.done_count}</div>
              <div><strong>Cancelled:</strong> {analytics.cancelled_count}</div>
              <div><strong>Rescheduled:</strong> {analytics.rescheduled_count}</div>
            </div>
            <div className="card">
              <div><strong>Avg Processing:</strong> {Math.round(Number(analytics.avg_processing_seconds || 0))} sec</div>
              <div><strong>Cancellation Rate:</strong> {Number(analytics.cancellation_rate || 0).toFixed(2)}%</div>
            </div>
          </div>
        ) : (
          <p className="muted">Select a template to view analytics.</p>
        )}
      </section>

      <section className="card">
        <h3>Workflow Board ({selectedTemplate?.title || 'Select template'})</h3>

        <div className="tabs">
          {statusTabs.map((tab) => (
            <button
              key={tab}
              type="button"
              className={tab === activeStatus ? 'tab active' : 'tab'}
              onClick={() => setActiveStatus(tab)}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="grid two">
          <div className="card">
            <h4>Filters</h4>
            <label>Keyword</label>
            <input
              value={listFilters.keyword}
              onChange={(e) => setListFilters({ ...listFilters, keyword: e.target.value })}
              placeholder="Search submitted data / id / user"
            />
            <label>User</label>
            <select
              value={listFilters.user_id}
              onChange={(e) => setListFilters({ ...listFilters, user_id: e.target.value })}
            >
              <option value="">All users</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.name} ({u.email})</option>
              ))}
            </select>
            <label>Date From</label>
            <input
              type="date"
              value={listFilters.date_from}
              onChange={(e) => setListFilters({ ...listFilters, date_from: e.target.value })}
            />
            <label>Date To</label>
            <input
              type="date"
              value={listFilters.date_to}
              onChange={(e) => setListFilters({ ...listFilters, date_to: e.target.value })}
            />
          </div>

          <div className="card">
            <h4>Bulk Actions</h4>
            <label>Status</label>
            <select value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)}>
              {statusTabs.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            {bulkStatus === 'rescheduled' && (
              <>
                <label>Reschedule Date</label>
                <input
                  type="datetime-local"
                  value={bulkRescheduleDate}
                  onChange={(e) => setBulkRescheduleDate(e.target.value)}
                />
              </>
            )}
            <button type="button" onClick={applyBulkStatus}>Apply To Selected Rows</button>
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    checked={items.length > 0 && items.every((i) => selectedRows[i.id])}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      const next = {};
                      for (const row of items) next[row.id] = checked;
                      setSelectedRows(next);
                    }}
                  />
                </th>
                <th>PDF ID</th>
                <th>User</th>
                <th>Created</th>
                <th>Status Note</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={Boolean(selectedRows[item.id])}
                      onChange={(e) => setSelectedRows({ ...selectedRows, [item.id]: e.target.checked })}
                    />
                  </td>
                  <td className="mono">{item.id.slice(0, 8)}...</td>
                  <td>{item.user_name || item.user_id || '-'}</td>
                  <td>{new Date(item.created_at).toLocaleString()}</td>
                  <td>{item.status_note || '-'}</td>
                  <td className="actions">
                    <button type="button" onClick={() => downloadWithToken(`/generated-pdfs/${item.id}/download`, token)}>Download</button>
                    <button type="button" onClick={() => viewHistory(item.id)}>History</button>
                    <button type="button" onClick={() => updateStatus(item.id, 'done')}>Done</button>
                    <button type="button" onClick={() => updateStatus(item.id, 'cancelled')}>Cancel</button>
                    <button type="button" onClick={() => updateStatus(item.id, 'rescheduled')}>Reschedule</button>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan="6">No records in this status.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
