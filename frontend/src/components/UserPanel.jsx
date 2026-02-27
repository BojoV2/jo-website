import { useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest, downloadWithToken, fetchArrayBuffer } from '../api.js';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/build/pdf.mjs';
import workerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url';

GlobalWorkerOptions.workerSrc = workerSrc;

const statusTabs = ['pending', 'done', 'cancelled', 'rescheduled'];

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

function pickFieldValue(submittedData, candidates) {
  const source = normalizeSubmittedData(submittedData);
  const entries = Object.entries(source);
  for (const candidate of candidates) {
    const exact = source[candidate];
    if (exact !== undefined && exact !== null && String(exact).trim() !== '') {
      return String(exact);
    }
  }
  for (const [key, value] of entries) {
    const lowered = key.toLowerCase().replace(/\s+/g, '_');
    if (candidates.includes(lowered) && value !== undefined && value !== null && String(value).trim() !== '') {
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

export default function UserPanel({ token, user, onLogout }) {
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
  const [listFilters, setListFilters] = useState({
    keyword: '',
    date_from: '',
    date_to: ''
  });

  const canvasRef = useRef(null);

  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === selectedTemplateId),
    [templates, selectedTemplateId]
  );

  async function loadTemplates() {
    const data = await apiRequest('/templates', { token });
    setTemplates(data);
    if (!selectedTemplateId && data[0]?.id) {
      setSelectedTemplateId(data[0].id);
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
        next[key] = prev[key] ?? '';
      }
      return next;
    });
  }

  async function loadGenerated(status, templateId = selectedTemplateId) {
    const params = new URLSearchParams({ status });
    if (templateId) {
      params.set('template_id', templateId);
    }
    if (listFilters.keyword) params.set('keyword', listFilters.keyword);
    if (listFilters.date_from) params.set('date_from', listFilters.date_from);
    if (listFilters.date_to) params.set('date_to', listFilters.date_to);
    const data = await apiRequest(`/generated-pdfs?${params.toString()}`, { token });
    setGenerated(data);
    const nextDrafts = {};
    for (const row of data) {
      nextDrafts[row.id] = row.status;
    }
    setStatusDrafts(nextDrafts);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedTemplateId) return;
    loadFields(selectedTemplateId).catch((err) => setMessage(err.message));
    loadPdfPreview(selectedTemplateId).catch((err) => setMessage(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTemplateId]);

  useEffect(() => {
    if (!selectedTemplateId) {
      setGenerated([]);
      setStatusDrafts({});
      return;
    }
    loadGenerated(activeStatus, selectedTemplateId).catch((err) => setMessage(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStatus, selectedTemplateId, listFilters.keyword, listFilters.date_from, listFilters.date_to]);

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
        if (requiredNow && (value === undefined || value === null || String(value).trim() === '')) {
          throw new Error(`Required field missing: ${field.field_name}`);
        }
        if (value !== undefined && value !== null && String(value) !== '') {
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
      await loadGenerated('pending', selectedTemplateId);
      setActiveStatus('pending');
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
      setEditingValue(toDatetimeLocal(item.reschedule_date));
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
        <div>
          <h2>User Portal</h2>
          <p className="muted">{user.name} ({user.role})</p>
        </div>
        <button onClick={onLogout}>Logout</button>
      </header>

      {message && <div className="notice">{message}</div>}

      <section className="grid two">
        <div className="card">
          <h3>Choose Template</h3>
          <select value={selectedTemplateId} onChange={(e) => setSelectedTemplateId(e.target.value)}>
            <option value="">Select template</option>
            {templates.map((tpl) => (
              <option key={tpl.id} value={tpl.id}>{tpl.title}</option>
            ))}
          </select>
          {selectedTemplate && (
            <p className="muted">{selectedTemplate.description || 'No description.'}</p>
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
                <select
                  value={formValues[field.field_name] || ''}
                  onChange={(e) => setFormValues({ ...formValues, [field.field_name]: e.target.value })}
                  required={field.required || isRequiredIfTriggered(field, formValues)}
                >
                  <option value="">Select {field.field_name}</option>
                  {parseFieldOptions(field.field_options).map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              ) : field.field_type === 'date' ? (
                <input
                  type="date"
                  value={formValues[field.field_name] || todayIsoDate()}
                  readOnly
                  required={field.required || isRequiredIfTriggered(field, formValues)}
                />
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
        <h3>Template Preview Mapper</h3>
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

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Address</th>
                <th>Template</th>
                <th>Created</th>
                <th>Note</th>
                <th>Reschedule Date</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {generated.map((item) => (
                <tr key={item.id}>
                  <td>{pickFieldValue(item.submitted_data, ['name', 'full_name', 'customer_name'])}</td>
                  <td>{pickFieldValue(item.submitted_data, ['address', 'full_address', 'customer_address'])}</td>
                  <td>{item.template_title || item.template_id}</td>
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
              {generated.length === 0 && (
                <tr>
                  <td colSpan="7">No generated PDFs in this status.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
