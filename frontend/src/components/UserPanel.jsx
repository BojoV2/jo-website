import { useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest, downloadWithToken, fetchArrayBuffer } from '../api.js';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/build/pdf.mjs';
import workerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url';
import ProfileSidebar from './ProfileSidebar.jsx';
import { resolveAvatar } from '../utils/avatar.js';

GlobalWorkerOptions.workerSrc = workerSrc;

const statusTabs = ['pending', 'done', 'cancelled', 'rescheduled'];
const emptyListFilters = {
  keyword: '',
  date_from: '',
  date_to: ''
};

function todayIsoDate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toDatetimeLocal(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

function nowDatetimeLocal() {
  return toDatetimeLocal(new Date().toISOString());
}

function parseFieldOptions(raw) {
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((v) => String(v).trim()).filter(Boolean);
      }
    } catch (_err) {
      return raw.split('\n').map((v) => v.trim()).filter(Boolean);
    }
  }
  return [];
}

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

function normalizeFieldKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

function pickFieldValue(submittedData, fieldName) {
  const source = normalizeSubmittedData(submittedData);
  const exact = source[fieldName];
  if (exact !== undefined && exact !== null && String(exact).trim() !== '') {
    if (typeof exact === 'boolean') {
      return exact ? 'Checked' : 'Unchecked';
    }
    return String(exact);
  }
  const target = normalizeFieldKey(fieldName);
  for (const [key, value] of Object.entries(source)) {
    if (normalizeFieldKey(key) === target && value !== undefined && value !== null && String(value).trim() !== '') {
      if (typeof value === 'boolean') {
        return value ? 'Checked' : 'Unchecked';
      }
      return String(value);
    }
  }
  return '-';
}

function isRequiredIfTriggered(field, formValues) {
  const rules = field.validation_rules || {};
  const requiredIf = rules.required_if;
  if (!requiredIf || typeof requiredIf !== 'object') return false;
  const key = String(requiredIf.field || '').trim();
  if (!key) return false;
  return String(formValues[key] ?? '') === String(requiredIf.equals ?? '');
}

function isCheckedCheckboxValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return ['true', '1', 'yes', 'checked', 'on'].includes(normalized);
  }
  return false;
}

function isMissingRequiredValue(field, value) {
  if (field.field_type === 'checkbox') {
    return !isCheckedCheckboxValue(value);
  }
  return value === undefined || value === null || String(value).trim() === '';
}

function messageTone(message) {
  const text = String(message || '').toLowerCase();
  if (!text) return 'is-info';
  if (text.includes('error') || text.includes('failed') || text.includes('invalid') || text.includes('not found') || text.includes('required') || text.includes('forbidden')) {
    return 'is-error';
  }
  if (text.includes('cancel') || text.includes('reschedule')) {
    return 'is-warning';
  }
  return 'is-success';
}

function buildPageItems(totalPages, currentPage) {
  const pages = [];
  for (let i = 1; i <= totalPages; i += 1) {
    const isEdge = i === 1 || i === totalPages;
    const isNearCurrent = Math.abs(i - currentPage) <= 1;
    if (isEdge || isNearCurrent) {
      pages.push(i);
    } else if (pages[pages.length - 1] !== '...') {
      pages.push('...');
    }
  }
  return pages;
}

export default function UserPanel({
  token,
  user,
  onLogout,
  theme = 'light',
  onToggleTheme,
  onSessionUserUpdate
}) {
  const [templates, setTemplates] = useState([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [fields, setFields] = useState([]);
  const [formValues, setFormValues] = useState({});
  const [activeStatus, setActiveStatus] = useState('pending');
  const [generated, setGenerated] = useState([]);
  const [statusDrafts, setStatusDrafts] = useState({});
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [pdfDoc, setPdfDoc] = useState(null);
  const [pdfMeta, setPdfMeta] = useState({ width: 0, height: 0, pages: 0 });
  const [renderMeta, setRenderMeta] = useState({ width: 0, height: 0 });
  const [previewPage, setPreviewPage] = useState(1);
  const [editingCell, setEditingCell] = useState(null);
  const [editingValue, setEditingValue] = useState('');
  const [showPreviewMapper, setShowPreviewMapper] = useState(false);
  const [analytics, setAnalytics] = useState(null);
  const [monthlyReport, setMonthlyReport] = useState([]);
  const [pendingPageSize, setPendingPageSize] = useState('20');
  const [pendingPage, setPendingPage] = useState(1);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [listFilters, setListFilters] = useState(emptyListFilters);

  const canvasRef = useRef(null);

  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === selectedTemplateId),
    [templates, selectedTemplateId]
  );
  const orderedTemplates = useMemo(() => {
    const favoriteId = user?.favorite_template_id || '';
    if (!favoriteId) return templates;
    return [...templates].sort((a, b) => {
      if (a.id === favoriteId) return -1;
      if (b.id === favoriteId) return 1;
      return 0;
    });
  }, [templates, user?.favorite_template_id]);
  const listColumns = useMemo(
    () => fields.slice(0, 3).map((field) => field.field_name),
    [fields]
  );
  const pendingTotalPages = useMemo(() => {
    if (activeStatus !== 'pending' || pendingPageSize === 'all') {
      return 1;
    }
    const pageSize = Number(pendingPageSize) || 20;
    return Math.max(1, Math.ceil(generated.length / pageSize));
  }, [activeStatus, pendingPageSize, generated.length]);
  const visibleGenerated = useMemo(() => {
    if (activeStatus !== 'pending' || pendingPageSize === 'all') {
      return generated;
    }
    const pageSize = Number(pendingPageSize) || 20;
    const start = (pendingPage - 1) * pageSize;
    return generated.slice(start, start + pageSize);
  }, [activeStatus, generated, pendingPage, pendingPageSize]);
  const pendingPageItems = useMemo(
    () => buildPageItems(pendingTotalPages, pendingPage),
    [pendingTotalPages, pendingPage]
  );
  const analyticsItems = useMemo(() => {
    if (!analytics) return [];
    return [
      {
        label: 'Total Generated',
        value: analytics.total_generated ?? 0,
        meta: 'This month'
      },
      {
        label: 'Pending Backlog',
        value: analytics.pending_backlog ?? 0,
        meta: 'Awaiting action'
      },
      {
        label: 'Done',
        value: analytics.done_count ?? 0,
        meta: 'Completed'
      },
      {
        label: 'Cancelled',
        value: analytics.cancelled_count ?? 0,
        meta: `${Number(analytics.cancellation_rate || 0).toFixed(2)}% rate`
      },
      {
        label: 'Rescheduled',
        value: analytics.rescheduled_count ?? 0,
        meta: 'Moved forward'
      },
      {
        label: 'Avg Processing',
        value: `${Math.round(Number(analytics.avg_processing_seconds || 0))} sec`,
        meta: 'Done records only'
      }
    ];
  }, [analytics]);

  async function loadTemplates() {
    const data = await apiRequest('/templates', { token });
    setTemplates(data);
    const favoriteTemplateId = user?.favorite_template_id;
    const defaultTemplateId = favoriteTemplateId && data.some((tpl) => tpl.id === favoriteTemplateId)
      ? favoriteTemplateId
      : data[0]?.id || '';
    setSelectedTemplateId((prev) => (
      prev && data.some((tpl) => tpl.id === prev)
        ? prev
        : defaultTemplateId
    ));
    return data;
  }

  async function setFavoriteTemplate(templateId) {
    try {
      const result = await apiRequest('/auth/me', {
        method: 'PATCH',
        token,
        body: { favorite_template_id: templateId }
      });
      onSessionUserUpdate?.(result.user);
      setSelectedTemplateId(templateId);
      setMessage('Favorite template saved. It will auto-select on your next login.');
    } catch (err) {
      setMessage(err.message);
    }
  }

  async function exportMyTemplateData(format = 'csv') {
    if (!selectedTemplateId) {
      setMessage('Please select a template first.');
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

  async function loadFields(templateId) {
    if (!templateId) return;
    const data = await apiRequest(`/templates/${templateId}/fields`, { token });
    setFields(data);
    setFormValues((prev) => {
      const next = {};
      for (const field of data) {
        const key = field.field_name;
        if (field.field_type === 'date') {
          next[key] = prev[key] || todayIsoDate();
          continue;
        }
        if (field.field_type === 'checkbox') {
          next[key] = prev[key] === undefined ? false : isCheckedCheckboxValue(prev[key]);
          continue;
        }
        next[key] = prev[key] ?? '';
      }
      return next;
    });
  }

  async function loadGenerated(status, templateId = selectedTemplateId, filters = listFilters) {
    const params = new URLSearchParams({ status });
    if (templateId) {
      params.set('template_id', templateId);
    }
    if (filters.keyword) params.set('keyword', filters.keyword);
    if (filters.date_from) params.set('date_from', filters.date_from);
    if (filters.date_to) params.set('date_to', filters.date_to);
    const data = await apiRequest(`/generated-pdfs?${params.toString()}`, { token });
    setGenerated(data);
    const nextDrafts = {};
    for (const row of data) {
      nextDrafts[row.id] = row.status;
    }
    setStatusDrafts(nextDrafts);
  }

  async function loadAnalytics(templateId = selectedTemplateId) {
    if (!templateId) {
      setAnalytics(null);
      return;
    }
    const data = await apiRequest(`/generated-pdfs/analytics/template/${templateId}`, { token });
    setAnalytics(data);
  }

  async function loadMonthlyReport() {
    const data = await apiRequest('/generated-pdfs/analytics/templates/monthly?months=6', { token });
    setMonthlyReport(data.templates || []);
  }

  async function loadPdfPreview(templateId, cacheKey) {
    if (!templateId) {
      setPdfDoc(null);
      return;
    }
    const resolvedCacheKey = cacheKey || templates.find((template) => template.id === templateId)?.version || Date.now();
    const bytes = await fetchArrayBuffer(`/templates/${templateId}/file?cache_key=${resolvedCacheKey}`, token);
    const doc = await getDocument({ data: bytes }).promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    setPdfDoc(doc);
    setPdfMeta({ width: base.width, height: base.height, pages: doc.numPages });
    setPreviewPage(1);
  }

  async function renderPage() {
    if (!pdfDoc || !canvasRef.current) return;
    const pageNumber = Number(previewPage) || 1;
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
  }

  useEffect(() => {
    loadTemplates().catch((err) => setMessage(err.message));
    loadMonthlyReport().catch((err) => setMessage(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const favoriteTemplateId = user?.favorite_template_id;
    if (!favoriteTemplateId) return;
    if (!templates.some((template) => template.id === favoriteTemplateId)) return;
    setSelectedTemplateId((current) => (current === favoriteTemplateId ? current : favoriteTemplateId));
  }, [templates, user?.favorite_template_id]);

  useEffect(() => {
    if (!selectedTemplateId) return;
    loadFields(selectedTemplateId).catch((err) => setMessage(err.message));
    loadAnalytics(selectedTemplateId).catch((err) => setMessage(err.message));
    loadMonthlyReport().catch((err) => setMessage(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTemplateId]);

  useEffect(() => {
    if (!selectedTemplateId || !showPreviewMapper) return;
    loadPdfPreview(selectedTemplateId, selectedTemplate?.version).catch((err) => setMessage(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTemplateId, selectedTemplate?.version, showPreviewMapper]);

  useEffect(() => {
    if (!selectedTemplateId) {
      setGenerated([]);
      setStatusDrafts({});
      return;
    }
    setPendingPage(1);
    loadGenerated(activeStatus, selectedTemplateId).catch((err) => setMessage(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStatus, selectedTemplateId, listFilters.keyword, listFilters.date_from, listFilters.date_to]);

  useEffect(() => {
    if (pendingPage > pendingTotalPages) {
      setPendingPage(pendingTotalPages);
    }
  }, [pendingPage, pendingTotalPages]);

  useEffect(() => {
    renderPage().catch((err) => setMessage(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfDoc, previewPage]);

  useEffect(() => {
    const onResize = () => {
      renderPage().catch((err) => setMessage(err.message));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfDoc, previewPage]);

  async function submitGeneration(e) {
    e.preventDefault();
    if (!selectedTemplateId) {
      setMessage('Please select a template.');
      return;
    }

    setLoading(true);
    setMessage('');
    try {
      for (const field of fields) {
        const value = formValues[field.field_name];
        const rules = field.validation_rules || {};
        const requiredNow = field.required || isRequiredIfTriggered(field, formValues);
        if (requiredNow && isMissingRequiredValue(field, value)) {
          throw new Error(`Required field missing: ${field.field_name}`);
        }
        if (field.field_type !== 'checkbox' && value !== undefined && value !== null && String(value) !== '') {
          const str = String(value);
          if (rules.min_length !== undefined && str.length < Number(rules.min_length)) {
            throw new Error(`${field.field_name} must be at least ${rules.min_length} characters`);
          }
          if (rules.max_length !== undefined && str.length > Number(rules.max_length)) {
            throw new Error(`${field.field_name} must be at most ${rules.max_length} characters`);
          }
          if (rules.regex) {
            const re = new RegExp(String(rules.regex));
            if (!re.test(str)) {
              throw new Error(`${field.field_name} has invalid format`);
            }
          }
        }
      }

      const created = await apiRequest('/generated-pdfs/generate', {
        method: 'POST',
        token,
        body: {
          template_id: selectedTemplateId,
          submitted_data: formValues
        }
      });

      let autoDownloadFailed = false;
      try {
        await downloadWithToken(`/generated-pdfs/${created.id}/download`, token);
      } catch (_downloadErr) {
        autoDownloadFailed = true;
      }

      setMessage(
        autoDownloadFailed
          ? 'PDF generated. Auto-download did not start, use manual Download button in Pending.'
          : 'PDF generated, auto-downloaded, and queued as pending.'
      );
      setActiveStatus('pending');
      setPendingPage(1);
      setListFilters(emptyListFilters);
      await loadGenerated('pending', selectedTemplateId, emptyListFilters);
      await loadAnalytics(selectedTemplateId);
      await loadMonthlyReport();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function applyStatusChange(item) {
    const nextStatus = statusDrafts[item.id] || item.status;
    setLoading(true);
    setMessage('');
    try {
      await apiRequest(`/generated-pdfs/${item.id}/status`, {
        method: 'PATCH',
        token,
        body: {
          status: nextStatus,
          note: item.status_note || null,
          reschedule_date: nextStatus === 'rescheduled' ? (item.reschedule_date || null) : null
        }
      });
      await loadGenerated(activeStatus, selectedTemplateId);
      await loadAnalytics(selectedTemplateId);
      await loadMonthlyReport();
      setMessage(`Status updated to ${nextStatus}.`);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  }

  function startCellEdit(item, field) {
    setEditingCell({ id: item.id, field });
    if (field === 'status_note') {
      setEditingValue(item.status_note || '');
    } else if (field === 'reschedule_date') {
      setEditingValue(toDatetimeLocal(item.reschedule_date) || nowDatetimeLocal());
    }
  }

  async function saveCellEdit(item) {
    if (!editingCell || editingCell.id !== item.id) return;

    let status = item.status;
    let note = item.status_note || null;
    let rescheduleDate = item.reschedule_date || null;

    if (editingCell.field === 'status_note') {
      note = editingValue.trim() || null;
    }

    if (editingCell.field === 'reschedule_date') {
      rescheduleDate = editingValue ? new Date(editingValue).toISOString() : null;
      if (rescheduleDate) {
        status = 'rescheduled';
      } else if (status !== 'rescheduled') {
        rescheduleDate = null;
      }
    }

    setLoading(true);
    setMessage('');
    try {
      await apiRequest(`/generated-pdfs/${item.id}/status`, {
        method: 'PATCH',
        token,
        body: {
          status,
          note,
          reschedule_date: status === 'rescheduled' ? rescheduleDate : null
        }
      });
      setEditingCell(null);
      setEditingValue('');
      await loadGenerated(activeStatus, selectedTemplateId);
      await loadAnalytics(selectedTemplateId);
      await loadMonthlyReport();
      setMessage('Saved.');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="layout">
      <header className="topbar">
        <div className="profile-head">
          <button
            type="button"
            className="avatar-trigger"
            onClick={() => setIsSidebarOpen(true)}
            title="Open settings"
          >
            <img className="avatar avatar-md" src={resolveAvatar(user)} alt={user.name} />
          </button>
          <div>
            <h2>User Portal</h2>
            <p className="muted">{user.name} ({user.role})</p>
          </div>
        </div>
        <div className="topbar-actions">
          <button type="button" className="theme-btn" onClick={onToggleTheme}>
            {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
          </button>
          <button type="button" className="logout-btn" onClick={onLogout}>Logout</button>
        </div>
      </header>
      <ProfileSidebar
        open={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
        token={token}
        user={user}
        onUserUpdated={onSessionUserUpdate}
      />

      {message && (
        <div className={`notice ${messageTone(message)}`}>
          <div className="notice-title">{messageTone(message) === 'is-error' ? 'Attention needed' : 'Update'}</div>
          <div>{message}</div>
        </div>
      )}

      <section className="grid two">
        <div className="card">
          <h3>Choose Template</h3>
          <div className="template-stack" role="list" aria-label="Templates">
            {orderedTemplates.map((tpl) => (
              <div
                key={tpl.id}
                role="listitem"
                className={tpl.id === selectedTemplateId ? 'template-stack-item active' : 'template-stack-item'}
              >
                <button
                  type="button"
                  className="template-stack-select"
                  onClick={() => setSelectedTemplateId(tpl.id)}
                  title={`${tpl.title}${tpl.description ? ` - ${tpl.description}` : ''}`}
                >
                  <span className="template-stack-title-row">
                    <span className="template-stack-title">{tpl.title}</span>
                    {user?.favorite_template_id === tpl.id && (
                      <span className="template-badge">Favorite</span>
                    )}
                  </span>
                  <span className="template-stack-desc">{tpl.description || 'No description.'}</span>
                </button>
                <button
                  type="button"
                  className={user?.favorite_template_id === tpl.id ? 'template-favorite-btn active' : 'template-favorite-btn'}
                  onClick={() => setFavoriteTemplate(tpl.id)}
                  disabled={user?.favorite_template_id === tpl.id}
                >
                  {user?.favorite_template_id === tpl.id ? 'Auto-selected' : 'Set Favorite'}
                </button>
              </div>
            ))}
            {templates.length === 0 && (
              <div className="template-stack-empty">No templates available.</div>
            )}
          </div>
          {selectedTemplate && (
            <div className="template-stack-summary">
              <span className="template-stack-summary-title">{selectedTemplate.title}</span>
              <span className="template-stack-summary-desc">{selectedTemplate.description || 'No description.'}</span>
            </div>
          )}
          <div className="actions" style={{ marginTop: '10px' }}>
            <button type="button" onClick={() => exportMyTemplateData('csv')} disabled={!selectedTemplateId}>Export My Data CSV</button>
            <button type="button" onClick={() => exportMyTemplateData('json')} disabled={!selectedTemplateId}>Export My Data JSON</button>
          </div>
        </div>

        <form className="card" onSubmit={submitGeneration}>
          <h3>Fill Form Fields</h3>
          {fields.map((field) => (
            <div key={field.id}>
              <label>{field.field_name}{(field.required || isRequiredIfTriggered(field, formValues)) ? ' *' : ''}</label>
              {field.field_type === 'dropdown' ? (
                <>
                  <input
                    list={`dropdown-options-${field.id}`}
                    value={formValues[field.field_name] || ''}
                    onChange={(e) => setFormValues({ ...formValues, [field.field_name]: e.target.value })}
                    placeholder={`Type to search or pick ${field.field_name}`}
                    required={field.required || isRequiredIfTriggered(field, formValues)}
                  />
                  <datalist id={`dropdown-options-${field.id}`}>
                    {parseFieldOptions(field.field_options).map((option) => (
                      <option key={option} value={option} />
                    ))}
                  </datalist>
                </>
              ) : field.field_type === 'date' ? (
                <input
                  type="date"
                  value={formValues[field.field_name] || ''}
                  onChange={(e) => setFormValues({ ...formValues, [field.field_name]: e.target.value })}
                  required={field.required || isRequiredIfTriggered(field, formValues)}
                />
              ) : field.field_type === 'checkbox' ? (
                <label className="checkbox-line">
                  <input
                    type="checkbox"
                    checked={Boolean(formValues[field.field_name])}
                    onChange={(e) => setFormValues({ ...formValues, [field.field_name]: e.target.checked })}
                  />
                  Check on generated PDF
                </label>
              ) : field.field_type === 'order_number' ? (
                <input
                  value="Auto-generated on submit"
                  readOnly
                />
              ) : (
                <input
                  value={formValues[field.field_name] || ''}
                  onChange={(e) => setFormValues({ ...formValues, [field.field_name]: e.target.value })}
                  minLength={field.validation_rules?.min_length ?? undefined}
                  maxLength={field.validation_rules?.max_length ?? undefined}
                  pattern={field.validation_rules?.regex || undefined}
                  required={field.required || isRequiredIfTriggered(field, formValues)}
                />
              )}
            </div>
          ))}
          {fields.length === 0 && <p className="muted">No mapped fields for this template yet.</p>}
          <button disabled={loading || fields.length === 0}>
            {loading ? 'Generating...' : 'Generate PDF'}
          </button>
        </form>
      </section>

      <section className="card">
        <h3>Template Analytics</h3>
        <p className="muted">Current month metrics for the selected template.</p>
        {analytics ? (
          <div className="analytics-strip">
            {analyticsItems.map((item) => (
              <div key={item.label} className="analytics-strip-item">
                <span className="analytics-strip-label">{item.label}</span>
                <strong className="analytics-strip-value">{item.value}</strong>
                <span className="analytics-strip-meta">{item.meta}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">Select a template to view analytics.</p>
        )}
      </section>

      <section className="card">
        <h3>Monthly Report By Template</h3>
        <p className="muted">How many PDFs were created per month for every template.</p>
        <div className="report-grid">
          {monthlyReport.map((template) => {
            const maxValue = Math.max(1, ...template.months.map((m) => Number(m.total_generated || 0)));
            return (
              <div key={template.template_id} className="report-card">
                <div className="report-head">{template.template_title}</div>
                <div className="report-bars">
                  {template.months.map((month) => (
                    <div key={`${template.template_id}-${month.month_key}`} className="report-col" title={`${month.month_label}: ${month.total_generated}`}>
                      <div className="report-bar" style={{ height: `${Math.max(8, (Number(month.total_generated || 0) / maxValue) * 100)}%` }} />
                      <span>{month.month_label}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
          {monthlyReport.length === 0 && (
            <p className="muted">No template report data yet.</p>
          )}
        </div>
      </section>

      <section className="card">
        <div className="actions" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h3>Template Preview Mapper</h3>
          <button type="button" onClick={() => setShowPreviewMapper((prev) => !prev)}>
            {showPreviewMapper ? 'Hide Preview' : 'Show Preview'}
          </button>
        </div>
        {!showPreviewMapper && (
          <p className="muted">Preview is hidden. Click "Show Preview" if you want to see mapped field positions.</p>
        )}
        {showPreviewMapper && (
          <>
            <p className="muted">Preview where each field is placed on the PDF.</p>
            <label>Preview Page</label>
            <input
              type="number"
              min="1"
              max={pdfMeta.pages || 1}
              value={previewPage}
              onChange={(e) => setPreviewPage(Number(e.target.value || 1))}
            />
            <div className="pdf-stage">
              <canvas ref={canvasRef} className="pdf-canvas" />
              <div className="pdf-overlay" style={{ width: `${renderMeta.width}px`, height: `${renderMeta.height}px` }}>
                {fields
                  .filter((field) => Number(field.page_number) === Number(previewPage))
                  .map((field) => {
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
              </div>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <h3>My Generated PDFs</h3>
        <p className="muted">Double click Note or Reschedule Date to edit and auto-save.</p>
        <div className="grid two">
          <div className="card">
            <label>Keyword</label>
            <input
              value={listFilters.keyword}
              onChange={(e) => setListFilters({ ...listFilters, keyword: e.target.value })}
              placeholder="Search data/notes"
            />
          </div>
          <div className="card">
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
        </div>
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
        {activeStatus === 'pending' && (
          <div className="pagination-stack">
            <div className="actions" style={{ alignItems: 'center', marginBottom: '8px' }}>
              <label style={{ marginTop: 0 }}>Rows</label>
              <select
                value={pendingPageSize}
                onChange={(e) => {
                  setPendingPageSize(e.target.value);
                  setPendingPage(1);
                }}
              >
                <option value="20">20</option>
                <option value="50">50</option>
                <option value="all">All</option>
              </select>
            </div>
            {pendingPageSize !== 'all' && (
              <div className="pager-shell">
                <button type="button" className="pager-nav" onClick={() => setPendingPage((p) => Math.max(1, p - 1))} disabled={pendingPage <= 1}>
                  Previous
                </button>
                <div className="pager-pages">
                  {pendingPageItems.map((item, index) => (
                    item === '...'
                      ? <span key={`dots-${index}`} className="pager-dots">...</span>
                      : (
                        <button
                          key={`page-${item}`}
                          type="button"
                          className={Number(item) === pendingPage ? 'pager-page active' : 'pager-page'}
                          onClick={() => setPendingPage(Number(item))}
                        >
                          {item}
                        </button>
                      )
                  ))}
                </div>
                <button type="button" className="pager-nav" onClick={() => setPendingPage((p) => Math.min(pendingTotalPages, p + 1))} disabled={pendingPage >= pendingTotalPages}>
                  Next
                </button>
              </div>
            )}
          </div>
        )}

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {listColumns.map((column, index) => (
                  <th key={`head-${index}-${column}`}>{column}</th>
                ))}
                <th>Created</th>
                <th>Note</th>
                <th>Reschedule Date</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {visibleGenerated.map((item) => (
                <tr key={item.id}>
                  {listColumns.map((column, index) => (
                    <td key={`${item.id}-${index}-${column}`}>{pickFieldValue(item.submitted_data, column)}</td>
                  ))}
                  <td>{new Date(item.created_at).toLocaleString()}</td>
                  <td onDoubleClick={() => startCellEdit(item, 'status_note')}>
                    {editingCell?.id === item.id && editingCell.field === 'status_note' ? (
                      <input
                        autoFocus
                        value={editingValue}
                        onChange={(e) => setEditingValue(e.target.value)}
                        onBlur={() => saveCellEdit(item)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            saveCellEdit(item);
                          }
                        }}
                      />
                    ) : (item.status_note || '-')}
                  </td>
                  <td onDoubleClick={() => startCellEdit(item, 'reschedule_date')}>
                    {editingCell?.id === item.id && editingCell.field === 'reschedule_date' ? (
                      <input
                        autoFocus
                        type="datetime-local"
                        value={editingValue}
                        onChange={(e) => setEditingValue(e.target.value)}
                        onBlur={() => saveCellEdit(item)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            saveCellEdit(item);
                          }
                        }}
                      />
                    ) : (item.reschedule_date ? new Date(item.reschedule_date).toLocaleString() : '-')}
                  </td>
                  <td className="actions">
                    <select
                      value={statusDrafts[item.id] || item.status}
                      onChange={(e) => setStatusDrafts({ ...statusDrafts, [item.id]: e.target.value })}
                    >
                      {statusTabs.map((status) => (
                        <option key={status} value={status}>{status}</option>
                      ))}
                    </select>
                    <button type="button" onClick={() => applyStatusChange(item)}>Move</button>
                    <button type="button" onClick={() => downloadWithToken(`/generated-pdfs/${item.id}/download`, token)}>Download</button>
                  </td>
                </tr>
              ))}
              {visibleGenerated.length === 0 && (
                <tr>
                  <td colSpan={listColumns.length + 4}>No generated PDFs in this status.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
