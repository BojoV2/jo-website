import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import QRCode from 'qrcode';
import { apiRequest, downloadWithToken, fetchArrayBuffer, openWithTokenInNewTab, getApiBase } from '../api.js';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/build/pdf.mjs';
import workerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url';
import ProfileSidebar from './ProfileSidebar.jsx';
import { resolveAvatar } from '../utils/avatar.js';
import StatusStackedBarChart from './StatusStackedBarChart.jsx';
import StatusDonutChart from './StatusDonutChart.jsx';

GlobalWorkerOptions.workerSrc = workerSrc;

const statusTabs = ['pending', 'done', 'cancelled', 'rescheduled'];
const adminTabs = [
  { id: 'home',       label: 'Home'        },
  { id: 'templates',  label: 'Templates'   },
  { id: 'mapping',    label: 'Field Mapping'},
  { id: 'workflow',   label: 'Workflow'    },
  { id: 'users',      label: 'Users'       },
  { id: 'auto-reply', label: 'Auto Reply'  },
  { id: 'qr-link',    label: 'QR Link'    },
  { id: 'tracking',   label: 'Tracking'   },
];
const DEFAULT_MONTHLY_RANGE = '3';

function clampRect(rect) {
  if (!rect) return null;
  const width = Math.max(6, rect.width);
  const height = Math.max(6, rect.height);
  return { ...rect, width, height };
}

function messageTone(message) {
  const text = String(message || '').toLowerCase();
  if (!text) return 'is-info';
  if (text.includes('error') || text.includes('failed') || text.includes('invalid') || text.includes('not found') || text.includes('required') || text.includes('forbidden')) {
    return 'is-error';
  }
  if (text.includes('deleted') || text.includes('cancel')) {
    return 'is-warning';
  }
  return 'is-success';
}

// ── QR admin card (one saved QR entry with delete) ────────────────
function QrAdminCard({ link, token, onDelete, onError }) {
  const [dataUrl, setDataUrl] = useState('');
  const [lightbox, setLightbox] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    QRCode.toDataURL(link.url, { width: 200, margin: 2, color: { dark: '#112b47', light: '#ffffff' } })
      .then(setDataUrl)
      .catch(() => setDataUrl(''));
  }, [link.url]);

  useEffect(() => {
    if (!lightbox) return;
    function onKey(e) { if (e.key === 'Escape') setLightbox(false); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  return (
    <div className="qr-admin-card">
      {lightbox && (
        <div className="ar-lightbox" onClick={() => setLightbox(false)}>
          <img src={dataUrl} alt="QR Code (enlarged)" onClick={(e) => e.stopPropagation()} />
          <button className="ar-lightbox-close" onClick={() => setLightbox(false)}>✕</button>
        </div>
      )}
      {dataUrl ? (
        <img
          src={dataUrl}
          alt="QR Code"
          className="qr-image qr-image--admin"
          title="Click to enlarge"
          onClick={() => setLightbox(true)}
        />
      ) : (
        <div className="qr-placeholder">Generating…</div>
      )}
      {link.label && <p className="qr-label">{link.label}</p>}
      <p className="qr-url">{link.url}</p>
      <button
        type="button"
        className="btn-sm btn-danger"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await apiRequest(`/qr-link/${link.id}`, { method: 'DELETE', token });
            onDelete(link.id);
          } catch (err) {
            onError(err.message || 'Failed to delete');
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Deleting…' : 'Delete'}
      </button>
    </div>
  );
}

export default function AdminPanel({
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
  const [items, setItems] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [monthlyReport, setMonthlyReport] = useState([]);
  const [monthlyByStatus, setMonthlyByStatus] = useState([]);
  const [monthlyReportRange, setMonthlyReportRange] = useState(DEFAULT_MONTHLY_RANGE);
  const [activeAdminTab, setActiveAdminTab] = useState('home');
  const [activeStatus, setActiveStatus] = useState('pending');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [openingPdfId, setOpeningPdfId] = useState(null);
  const [users, setUsers] = useState([]);
  const [presets, setPresets] = useState([]);
  const [editingFieldId, setEditingFieldId] = useState('');

  const [uploadForm, setUploadForm] = useState({ title: '', description: '', file: null });
  const [templateEditForm, setTemplateEditForm] = useState({ title: '', description: '' });
  const [templateReplaceFile, setTemplateReplaceFile] = useState(null);
  const [replaceFileInputKey, setReplaceFileInputKey] = useState(0);
  const [predefinedPdfs, setPredefinedPdfs] = useState([]);
  const [predefinedPdfForm, setPredefinedPdfForm] = useState({ name: '', file: null });
  const [predefinedPdfInputKey, setPredefinedPdfInputKey] = useState(0);
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
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // QR Link state
  const [qrLinks, setQrLinks]           = useState([]);      // all saved QR links
  const [qrDraftUrl, setQrDraftUrl]     = useState('');      // URL input
  const [qrDraftLabel, setQrDraftLabel] = useState('');      // label input
  const [qrDraftDataUrl, setQrDraftDataUrl] = useState('');  // generated QR image
  const [qrBusy, setQrBusy]            = useState(false);
  const [qrLoaded, setQrLoaded]        = useState(false);
  const [qrLightbox, setQrLightbox]    = useState(false);

  // Auto Reply state
  const [arMessages, setArMessages]     = useState([]);
  const [arBusy, setArBusy]             = useState(false);
  const [arLoaded, setArLoaded]         = useState(false);
  const [arEditId, setArEditId]         = useState('');
  const [arEditForm, setArEditForm]     = useState({ title: '', message_text: '' });
  const [arNewForms, setArNewForms]     = useState([{ title: '', message_text: '', images: [] }]);
  const [arNewInputKeys, setArNewInputKeys] = useState([0]);
  const [arAddImgInputKey, setArAddImgInputKey] = useState(0);
  const [arLightbox, setArLightbox]     = useState(null);

  const [listFilters, setListFilters] = useState({
    keyword: '',
    user_id: '',
    date_from: '',
    date_to: ''
  });

  // Document requirements state
  const [docRequirements, setDocRequirements] = useState([]);
  const [docReqEditId, setDocReqEditId] = useState('');
  const [docReqForm, setDocReqForm] = useState({ document_name: '', required: true, allowed_types: 'image_or_pdf', sort_order: 0 });

  // Workflow attachments viewer
  const [workflowAttachmentRowId, setWorkflowAttachmentRowId] = useState('');
  const [workflowAttachments, setWorkflowAttachments] = useState([]);

  // Tracker settings state
  const [trackers, setTrackers] = useState([]);
  const [trackerLoaded, setTrackerLoaded] = useState(false);
  const [trackerEditId, setTrackerEditId] = useState('');
  const [trackerBusy, setTrackerBusy] = useState(false);
  const [trackerSyncingId, setTrackerSyncingId] = useState('');
  const [trackerForm, setTrackerForm] = useState({
    name: '', base_url: '', username: '', password: '', enabled: true, notes: '', refresh_interval_seconds: 60
  });

  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const stageRef = useRef(null);
  const renderTaskRef = useRef(null);
  const renderRequestRef = useRef(0);

  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === selectedTemplateId),
    [templates, selectedTemplateId]
  );

  const pageFields = useMemo(
    () => fields.filter((field) => Number(field.page_number) === Number(fieldForm.page_number)),
    [fields, fieldForm.page_number]
  );

  const adminAnalyticsItems = useMemo(() => {
    if (!analytics) return [];
    return [
      {
        label: 'Total Generated',
        value: analytics.total_generated ?? 0,
        meta: 'This month',
        tone: 'primary'
      },
      {
        label: 'Pending Backlog',
        value: analytics.pending_backlog ?? 0,
        meta: 'Awaiting admin action',
        tone: 'warning'
      },
      {
        label: 'Generated Today',
        value: analytics.today_generated ?? 0,
        meta: 'Since midnight',
        tone: 'accent'
      },
      {
        label: 'Done',
        value: analytics.done_count ?? 0,
        meta: 'Completed',
        tone: 'success'
      },
      {
        label: 'Cancelled',
        value: analytics.cancelled_count ?? 0,
        meta: `${Number(analytics.cancellation_rate || 0).toFixed(2)}% rate`,
        tone: 'danger'
      },
        {
          label: 'Rescheduled',
          value: analytics.rescheduled_count ?? 0,
          meta: 'Moved forward',
          tone: 'muted'
        }
      ];
    }, [analytics]);

  const adminOverviewStats = useMemo(() => ([
    { label: 'Templates', value: templates.length, meta: 'Configured PDFs' },
    { label: 'Users', value: users.length, meta: 'Portal accounts' },
    { label: 'Mapped Fields', value: fields.length, meta: selectedTemplate?.title || 'Current template' },
    { label: 'Workflow Rows', value: items.length, meta: `${activeStatus} records` }
  ]), [activeStatus, fields.length, items.length, selectedTemplate?.title, templates.length, users.length]);

  const visibleMonthlyReport = useMemo(() => {
    const ownedTemplateIds = new Set(
      templates
        .filter((template) => template.created_by === user.id)
        .map((template) => template.id)
    );

    if (ownedTemplateIds.size === 0) {
      return monthlyReport;
    }

    return monthlyReport.filter((template) => ownedTemplateIds.has(template.template_id));
  }, [monthlyReport, templates, user.id]);

  async function loadTemplates() {
    const data = await apiRequest('/templates', { token });
    setTemplates(data);
    if (!selectedTemplateId && data[0]?.id) {
      setSelectedTemplateId(data[0].id);
    }
    return data;
  }

  async function loadFields(templateId) {
    if (!templateId) return;
    const data = await apiRequest(`/templates/${templateId}/fields`, { token });
    setFields(data);
  }

  async function loadDocRequirements(templateId) {
    if (!templateId) return;
    const data = await apiRequest(`/templates/${templateId}/document-requirements`, { token });
    setDocRequirements(data);
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

  async function loadArMessages() {
    const data = await apiRequest('/auto-reply', { token });
    setArMessages(data);
    setArLoaded(true);
  }

  async function loadAnalytics(templateId) {
    if (!templateId) {
      setAnalytics(null);
      return;
    }
    const data = await apiRequest(`/generated-pdfs/analytics/template/${templateId}`, { token });
    setAnalytics(data);
  }

  async function loadPredefinedPdfs(templateId) {
    if (!templateId) {
      setPredefinedPdfs([]);
      return;
    }
    const data = await apiRequest(`/templates/${templateId}/predefined-pdfs`, { token });
    setPredefinedPdfs(data);
  }

  async function loadMonthlyReport(months = Number(monthlyReportRange) || Number(DEFAULT_MONTHLY_RANGE)) {
    const data = await apiRequest(`/generated-pdfs/analytics/templates/monthly?months=${months}`, { token });
    setMonthlyReport(data.templates || []);
  }

  async function loadMonthlyByStatus(months = Number(monthlyReportRange) || Number(DEFAULT_MONTHLY_RANGE)) {
    const data = await apiRequest(`/generated-pdfs/analytics/templates/monthly-by-status?months=${months}`, { token });
    setMonthlyByStatus(data.months || []);
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
    setFieldForm((prev) => ({ ...prev, page_number: Math.min(prev.page_number || 1, doc.numPages) }));
  }

  async function renderPage() {
    if (!pdfDoc || !canvasRef.current) return;
    const requestId = ++renderRequestRef.current;

    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
      try {
        await renderTaskRef.current.promise;
      } catch (err) {
        if (err?.name !== 'RenderingCancelledException') {
          throw err;
        }
      } finally {
        renderTaskRef.current = null;
      }
    }

    const pageNumber = Number(fieldForm.page_number) || 1;
    const page = await pdfDoc.getPage(pageNumber);
    if (requestId !== renderRequestRef.current || !canvasRef.current) {
      return;
    }
    const baseViewport = page.getViewport({ scale: 1 });
    const stageWidth = stageRef.current?.clientWidth || stageRef.current?.parentElement?.clientWidth || 0;
    const desiredWidth = Math.max(baseViewport.width, stageWidth || 0);
    const scale = desiredWidth / baseViewport.width;
    const viewport = page.getViewport({ scale });

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    const renderTask = page.render({ canvasContext: ctx, viewport });
    renderTaskRef.current = renderTask;

    try {
      await renderTask.promise;
    } catch (err) {
      if (renderTaskRef.current === renderTask) {
        renderTaskRef.current = null;
      }
      if (err?.name === 'RenderingCancelledException') {
        return;
      }
      throw err;
    }

    if (renderTaskRef.current === renderTask) {
      renderTaskRef.current = null;
    }
    if (requestId !== renderRequestRef.current) {
      return;
    }

    const bounds = canvas.getBoundingClientRect();
    setRenderMeta({ width: bounds.width, height: bounds.height });
    setSelectedRect(null);
  }

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(''), 5000);
    return () => clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    loadTemplates().catch((err) => setMessage(err.message));
    loadUsers().catch((err) => setMessage(err.message));
    loadPresets().catch((err) => setMessage(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const months = Number(monthlyReportRange) || Number(DEFAULT_MONTHLY_RANGE);
    loadMonthlyReport(months).catch((err) => setMessage(err.message));
    loadMonthlyByStatus(months).catch((err) => setMessage(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthlyReportRange]);

  useEffect(() => {
    if (activeAdminTab === 'auto-reply' && !arLoaded) {
      loadArMessages().catch((err) => setMessage(err.message));
    }
    if (activeAdminTab === 'qr-link' && !qrLoaded) {
      apiRequest('/qr-link/all', { token })
        .then((data) => { setQrLinks(data); setQrLoaded(true); })
        .catch((err) => setMessage(err.message));
    }
    if (activeAdminTab === 'tracking' && !trackerLoaded) {
      apiRequest('/tracking/admin', { token })
        .then((data) => { setTrackers(data); setTrackerLoaded(true); })
        .catch((err) => setMessage(err.message));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAdminTab]);

  useEffect(() => {
    if (!selectedTemplateId) return;
    loadFields(selectedTemplateId).catch((err) => setMessage(err.message));
    loadDocRequirements(selectedTemplateId).catch((err) => setMessage(err.message));
    loadGenerated(selectedTemplateId, activeStatus).catch((err) => setMessage(err.message));
    loadAnalytics(selectedTemplateId).catch((err) => setMessage(err.message));
    loadPredefinedPdfs(selectedTemplateId).catch((err) => setMessage(err.message));
    loadPdfPreview(selectedTemplateId, selectedTemplate?.version).catch((err) => setMessage(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTemplateId, selectedTemplate?.version, activeStatus, listFilters.keyword, listFilters.user_id, listFilters.date_from, listFilters.date_to]);

  useEffect(() => {
    renderPage().catch((err) => setMessage(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfDoc, fieldForm.page_number]);

  useEffect(() => {
    if (activeAdminTab !== 'mapping' || !pdfDoc) return undefined;

    let frameA = 0;
    let frameB = 0;
    frameA = requestAnimationFrame(() => {
      frameB = requestAnimationFrame(() => {
        renderPage().catch((err) => setMessage(err.message));
      });
    });

    return () => {
      if (frameA) cancelAnimationFrame(frameA);
      if (frameB) cancelAnimationFrame(frameB);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAdminTab, pdfDoc, fieldForm.page_number]);

  useEffect(() => {
    if (activeAdminTab !== 'mapping' || !pdfDoc || !stageRef.current || typeof ResizeObserver === 'undefined') {
      return undefined;
    }

    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        renderPage().catch((err) => setMessage(err.message));
      });
    });

    observer.observe(stageRef.current);

    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAdminTab, pdfDoc, fieldForm.page_number]);

  useEffect(() => {
    const onResize = () => {
      renderPage().catch((err) => setMessage(err.message));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfDoc, fieldForm.page_number]);

  useEffect(() => () => {
    renderRequestRef.current += 1;
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
      renderTaskRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!selectedTemplate) return;
    setTemplateEditForm({
      title: selectedTemplate.title || '',
      description: selectedTemplate.description || ''
    });
    setPredefinedPdfForm({ name: '', file: null });
    setPredefinedPdfInputKey((prev) => prev + 1);
  }, [selectedTemplate]);

  useEffect(() => {
    if (!qrLightbox) return;
    function onKey(e) { if (e.key === 'Escape') setQrLightbox(false); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [qrLightbox]);

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

  async function replaceTemplateFile() {
    if (!selectedTemplateId) {
      setMessage('Select a template first.');
      return;
    }
    if (!templateReplaceFile) {
      setMessage('Choose a replacement PDF file first.');
      return;
    }

    setBusy(true);
    setMessage('');
    try {
      const formData = new FormData();
      formData.append('template', templateReplaceFile);
      await apiRequest(`/templates/${selectedTemplateId}/file`, {
        method: 'PUT',
        token,
        formData
      });
      setTemplateReplaceFile(null);
      setReplaceFileInputKey((prev) => prev + 1);
      const nextTemplates = await loadTemplates();
      await loadFields(selectedTemplateId);
      const nextVersion = nextTemplates.find((template) => template.id === selectedTemplateId)?.version || Date.now();
      await loadPdfPreview(selectedTemplateId, nextVersion);
      setMessage('Template PDF replaced. Existing mapped fields were kept.');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitPredefinedPdf(e) {
    e.preventDefault();
    if (!selectedTemplateId) {
      setMessage('Select a template first.');
      return;
    }
    if (!predefinedPdfForm.name.trim() || !predefinedPdfForm.file) {
      setMessage('Predefined PDF name and file are required.');
      return;
    }

    setBusy(true);
    setMessage('');
    try {
      const formData = new FormData();
      formData.append('name', predefinedPdfForm.name.trim());
      formData.append('pdf', predefinedPdfForm.file);
      await apiRequest(`/templates/${selectedTemplateId}/predefined-pdfs`, {
        method: 'POST',
        token,
        formData
      });
      setPredefinedPdfForm({ name: '', file: null });
      setPredefinedPdfInputKey((prev) => prev + 1);
      await loadPredefinedPdfs(selectedTemplateId);
      setMessage('Predefined PDF saved.');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function openPredefinedPdf(item) {
    if (openingPdfId) return;
    setOpeningPdfId(item.id);
    try {
      await openWithTokenInNewTab(`/templates/predefined-pdfs/${item.id}/file`, token);
    } catch {
      setMessage('Could not open this PDF — the file may be missing on disk. Try re-uploading it.');
    } finally {
      setOpeningPdfId(null);
    }
  }

  async function deletePredefinedPdf(predefinedPdfId) {
    const ok = window.confirm('Delete this predefined PDF?');
    if (!ok) return;

    setBusy(true);
    setMessage('');
    try {
      await apiRequest(`/templates/predefined-pdfs/${predefinedPdfId}`, {
        method: 'DELETE',
        token
      });
      await loadPredefinedPdfs(selectedTemplateId);
      setMessage('Predefined PDF deleted.');
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

  async function saveDocRequirement(e) {
    e.preventDefault();
    if (!selectedTemplateId) return;
    try {
      if (docReqEditId) {
        await apiRequest(`/templates/${selectedTemplateId}/document-requirements/${docReqEditId}`, {
          method: 'PUT',
          token,
          body: docReqForm
        });
      } else {
        await apiRequest(`/templates/${selectedTemplateId}/document-requirements`, {
          method: 'POST',
          token,
          body: docReqForm
        });
      }
      await loadDocRequirements(selectedTemplateId);
      setDocReqForm({ document_name: '', required: true, allowed_types: 'image_or_pdf', sort_order: 0 });
      setDocReqEditId('');
      setMessage(docReqEditId ? 'Requirement updated.' : 'Requirement added.');
    } catch (err) {
      setMessage(err.message);
    }
  }

  async function deleteDocRequirement(reqId) {
    if (!window.confirm('Delete this document requirement?')) return;
    try {
      await apiRequest(`/templates/${selectedTemplateId}/document-requirements/${reqId}`, {
        method: 'DELETE',
        token
      });
      await loadDocRequirements(selectedTemplateId);
      setMessage('Requirement deleted.');
    } catch (err) {
      setMessage(err.message);
    }
  }

  async function toggleWorkflowAttachments(itemId) {
    if (workflowAttachmentRowId === itemId) {
      setWorkflowAttachmentRowId('');
      setWorkflowAttachments([]);
      return;
    }
    try {
      const data = await apiRequest(`/generated-pdfs/${itemId}/attachments`, { token });
      setWorkflowAttachments(data);
      setWorkflowAttachmentRowId(itemId);
    } catch (err) {
      setMessage(err.message);
    }
  }

  function startEditDocReq(req) {
    setDocReqEditId(req.id);
    setDocReqForm({
      document_name: req.document_name,
      required: req.required,
      allowed_types: req.allowed_types,
      sort_order: req.sort_order
    });
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
      await loadMonthlyReport();
      await loadMonthlyByStatus();
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
      await loadAnalytics(selectedTemplateId);
      await loadMonthlyReport();
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
      if (result.temp_password) {
        await navigator.clipboard.writeText(result.temp_password);
        setMessage(`User created. Temporary password copied to clipboard.`);
      } else {
        setMessage('User created successfully.');
      }
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
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
            <h2>Admin Console</h2>
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

      <section className="admin-hero">
        <div className="card admin-hero-card">
          <span className="admin-hero-kicker">Admin home</span>
          <h3>Template operations dashboard</h3>
          <p className="muted">Use this dashboard to monitor template activity, switch templates quickly, and open the tools for uploads, field mapping, workflow, and user management.</p>
          <div className="actions">
            <button type="button" onClick={() => setActiveAdminTab('templates')}>Manage Templates</button>
            <button type="button" onClick={() => setActiveAdminTab('mapping')}>Map Fields</button>
            <button type="button" onClick={() => setActiveAdminTab('workflow')}>Open Workflow</button>
          </div>
        </div>

        <div className="card admin-focus-card">
          <div className="section-heading">
            <div>
              <h3>Focus Template</h3>
              <p className="muted">Pick the template used by analytics, mapping, and workflow tabs.</p>
            </div>
          </div>
          <label htmlFor="admin-focus-template">Selected Template</label>
          <select id="admin-focus-template" name="selected_template_focus" value={selectedTemplateId} onChange={(e) => setSelectedTemplateId(e.target.value)}>
            <option value="">Select template</option>
            {templates.map((tpl) => (
              <option key={tpl.id} value={tpl.id}>{tpl.title}</option>
            ))}
          </select>
          {selectedTemplate ? (
            <div className="template-meta">
              <div><strong>Title:</strong> {selectedTemplate.title}</div>
              <div><strong>Description:</strong> {selectedTemplate.description || '-'}</div>
              <div><strong>Version:</strong> {selectedTemplate.version || 1}</div>
            </div>
          ) : (
            <p className="muted">Select a template to load analytics and workflow data.</p>
          )}
        </div>
      </section>

      <section className="admin-nav">
        {adminTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={activeAdminTab === tab.id ? 'admin-nav-btn active' : 'admin-nav-btn'}
            onClick={() => setActiveAdminTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </section>

      {activeAdminTab === 'templates' && (
      <>
      <section className="grid two">
        <form className="card" onSubmit={submitTemplate}>
          <h3>Upload Template</h3>
          <label htmlFor="upload-template-title">Title</label>
          <input
            id="upload-template-title"
            name="title"
            value={uploadForm.title}
            onChange={(e) => setUploadForm({ ...uploadForm, title: e.target.value })}
            required
          />
          <label htmlFor="upload-template-description">Description</label>
          <textarea
            id="upload-template-description"
            name="description"
            value={uploadForm.description}
            onChange={(e) => setUploadForm({ ...uploadForm, description: e.target.value })}
            rows={3}
          />
          <label htmlFor="upload-template-file">PDF File</label>
          <input
            id="upload-template-file"
            name="pdf_file"
            type="file"
            accept="application/pdf"
            onChange={(e) => setUploadForm({ ...uploadForm, file: e.target.files?.[0] || null })}
            required
          />
          <button disabled={busy}>{busy ? 'Saving...' : 'Save Template'}</button>
        </form>

        <div className="card">
          <h3>Template Selector</h3>
          <label htmlFor="admin-template-selector">Template</label>
          <select id="admin-template-selector" name="selected_template" value={selectedTemplateId} onChange={(e) => setSelectedTemplateId(e.target.value)}>
            <option value="">Select template</option>
            {templates.map((tpl) => (
              <option key={tpl.id} value={tpl.id}>{tpl.title}</option>
            ))}
          </select>
          {selectedTemplate && (
            <div className="template-meta">
              <div><strong>Title:</strong> {selectedTemplate.title}</div>
              <div><strong>Description:</strong> {selectedTemplate.description || '-'}</div>
              <div><strong>Version:</strong> {selectedTemplate.version || 1}</div>
            </div>
          )}
          {selectedTemplate && (
            <div className="template-ops">
              <label htmlFor="admin-template-rename">Rename Title</label>
              <input
                id="admin-template-rename"
                name="rename_title"
                value={templateEditForm.title}
                onChange={(e) => setTemplateEditForm({ ...templateEditForm, title: e.target.value })}
              />
              <label htmlFor="admin-template-description">Edit Description</label>
              <textarea
                id="admin-template-description"
                name="edit_description"
                rows={2}
                value={templateEditForm.description}
                onChange={(e) => setTemplateEditForm({ ...templateEditForm, description: e.target.value })}
              />
              <label htmlFor="admin-template-file-replace">Replace PDF File</label>
              <input
                id="admin-template-file-replace"
                name="replace_pdf_file"
                key={replaceFileInputKey}
                type="file"
                accept="application/pdf"
                onChange={(e) => setTemplateReplaceFile(e.target.files?.[0] || null)}
              />
              <div className="actions">
                <button type="button" onClick={updateTemplate} disabled={busy || !templateEditForm.title}>Save Template</button>
                <button type="button" onClick={replaceTemplateFile} disabled={busy || !templateReplaceFile}>Replace PDF</button>
                <button type="button" className="warn" onClick={deleteTemplate} disabled={busy}>Delete Template</button>
                <button type="button" onClick={() => exportTemplateData('csv')} disabled={busy}>Export Data CSV</button>
                <button type="button" onClick={() => exportTemplateData('json')} disabled={busy}>Export Data JSON</button>
              </div>
            </div>
          )}
        </div>
      </section>
      {selectedTemplate && (
      <section className="grid two">
        <form className="card" onSubmit={submitPredefinedPdf}>
          <h3>Predefined PDFs</h3>
          <p className="muted">Upload reusable PDFs for the selected template. Users can open them directly from the Template workspace.</p>
          <label htmlFor="admin-predefined-pdf-name">Display Name</label>
          <input
            id="admin-predefined-pdf-name"
            name="predefined_pdf_name"
            value={predefinedPdfForm.name}
            onChange={(e) => setPredefinedPdfForm({ ...predefinedPdfForm, name: e.target.value })}
            placeholder="Installation guide"
            required
          />
          <label htmlFor="admin-predefined-pdf-file">PDF File</label>
          <input
            id="admin-predefined-pdf-file"
            key={predefinedPdfInputKey}
            name="predefined_pdf_file"
            type="file"
            accept="application/pdf"
            onChange={(e) => setPredefinedPdfForm({ ...predefinedPdfForm, file: e.target.files?.[0] || null })}
            required
          />
          <button disabled={busy || !selectedTemplateId}>
            {busy ? 'Saving...' : 'Save Predefined PDF'}
          </button>
        </form>

        <div className="card">
          <h3>Available Predefined PDFs</h3>
          <p className="muted">These appear on the user Template workspace for {selectedTemplate.title}.</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Added By</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {predefinedPdfs.map((item) => (
                  <tr key={item.id}>
                    <td>{item.name}</td>
                    <td>{item.created_by_name || '-'}</td>
                    <td>{new Date(item.created_at).toLocaleString()}</td>
                    <td className="actions">
                      <button type="button" disabled={openingPdfId === item.id} onClick={() => openPredefinedPdf(item)}>{openingPdfId === item.id ? 'Opening…' : 'Open'}</button>
                      <button type="button" className="warn" onClick={() => deletePredefinedPdf(item.id)} disabled={busy}>Delete</button>
                    </td>
                  </tr>
                ))}
                {predefinedPdfs.length === 0 && (
                  <tr>
                    <td colSpan="4">No predefined PDFs uploaded for this template yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
      )}
      </>
      )}

      {activeAdminTab === 'users' && (
      <section className="grid two">
        <form className="card" onSubmit={submitUser}>
          <h3>Create User Account</h3>
          <p className="muted">User can login using name or email.</p>
          <label htmlFor="admin-user-name">Name</label>
          <input
            id="admin-user-name"
            name="name"
            value={userForm.name}
            onChange={(e) => setUserForm({ ...userForm, name: e.target.value })}
            autoComplete="name"
            required
          />
          <label htmlFor="admin-user-email">Email</label>
          <input
            id="admin-user-email"
            name="email"
            type="email"
            value={userForm.email}
            onChange={(e) => setUserForm({ ...userForm, email: e.target.value })}
            autoComplete="email"
            required
          />
          <label htmlFor="admin-user-password">Password</label>
          <input
            id="admin-user-password"
            name="password"
            type={showCreatePassword ? 'text' : 'password'}
            value={userForm.password}
            onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
            autoComplete="new-password"
            required
          />
          <label className="checkbox-line" htmlFor="admin-show-create-password">
            <input
              id="admin-show-create-password"
              name="show_create_password"
              type="checkbox"
              checked={showCreatePassword}
              onChange={(e) => setShowCreatePassword(e.target.checked)}
            />
            View typed password
          </label>
          <label htmlFor="admin-user-role">Role</label>
          <select
            id="admin-user-role"
            name="role"
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
                    <td>
                      <div className="user-cell">
                        <img className="avatar avatar-sm" src={resolveAvatar(u)} alt={u.name} />
                        <span>{u.name}</span>
                      </div>
                    </td>
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
      )}

      {activeAdminTab === 'mapping' && (
      <>
      <section className="card admin-context-card">
        <div>
          <h3>Field Mapping Workspace</h3>
          <p className="muted">{selectedTemplate ? `Currently editing ${selectedTemplate.title}.` : 'Select a template in the Templates tab before mapping fields.'}</p>
        </div>
        <div className="actions">
          <button type="button" onClick={() => setActiveAdminTab('templates')}>Open Templates Tab</button>
        </div>
      </section>

      <section className="grid two">
        <form className="card" onSubmit={createPreset}>
          <h3>Field Presets</h3>
          <label htmlFor="preset-name">Preset Name</label>
          <input
            id="preset-name"
            name="preset_name"
            value={presetForm.name}
            onChange={(e) => setPresetForm({ ...presetForm, name: e.target.value })}
            required
          />
          <label htmlFor="preset-type">Type</label>
          <select
            id="preset-type"
            name="preset_type"
            value={presetForm.field_type}
            onChange={(e) => setPresetForm({ ...presetForm, field_type: e.target.value })}
          >
            <option value="text">text</option>
            <option value="dropdown">dropdown</option>
            <option value="date">date</option>
            <option value="checkbox">checkbox</option>
            <option value="order_number">order_number</option>
          </select>
          {presetForm.field_type === 'dropdown' && (
            <>
              <label htmlFor="preset-options">Options (one per line)</label>
              <textarea
                id="preset-options"
                name="preset_options"
                rows={3}
                value={presetForm.field_options_text}
                onChange={(e) => setPresetForm({ ...presetForm, field_options_text: e.target.value })}
                required
              />
            </>
          )}
          <label htmlFor="preset-regex">Regex (optional)</label>
          <input
            id="preset-regex"
            name="preset_regex"
            value={presetForm.regex}
            onChange={(e) => setPresetForm({ ...presetForm, regex: e.target.value })}
          />
          <label htmlFor="preset-min-length">Min Length</label>
          <input
            id="preset-min-length"
            name="preset_min_length"
            type="number"
            min="0"
            value={presetForm.min_length}
            onChange={(e) => setPresetForm({ ...presetForm, min_length: e.target.value })}
          />
          <label htmlFor="preset-max-length">Max Length</label>
          <input
            id="preset-max-length"
            name="preset_max_length"
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
          <label htmlFor="field-name">Field Name</label>
          <input
            id="field-name"
            name="field_name"
            value={fieldForm.field_name}
            onChange={(e) => setFieldForm({ ...fieldForm, field_name: e.target.value })}
            required
          />
          <label htmlFor="field-type">Field Type</label>
          <select
            id="field-type"
            name="field_type"
            value={fieldForm.field_type}
            onChange={(e) => setFieldForm({ ...fieldForm, field_type: e.target.value })}
          >
            <option value="text">text</option>
            <option value="dropdown">dropdown</option>
            <option value="date">date (today default)</option>
            <option value="checkbox">checkbox</option>
            <option value="order_number">order number (auto)</option>
          </select>
          {fieldForm.field_type === 'dropdown' && (
            <>
              <label htmlFor="field-options">Dropdown Options (one per line)</label>
              <textarea
                id="field-options"
                name="field_options"
                rows={4}
                value={fieldForm.field_options_text}
                onChange={(e) => setFieldForm({ ...fieldForm, field_options_text: e.target.value })}
                placeholder={'Option 1\nOption 2\nOption 3'}
                required
              />
            </>
          )}
          <label htmlFor="field-regex">Regex Rule (optional)</label>
          <input
            id="field-regex"
            name="field_regex"
            value={fieldForm.regex}
            onChange={(e) => setFieldForm({ ...fieldForm, regex: e.target.value })}
            placeholder="e.g. ^[0-9]{11}$"
          />
          <label htmlFor="field-min-length">Min Length (optional)</label>
          <input
            id="field-min-length"
            name="field_min_length"
            type="number"
            min="0"
            value={fieldForm.min_length}
            onChange={(e) => setFieldForm({ ...fieldForm, min_length: e.target.value })}
          />
          <label htmlFor="field-max-length">Max Length (optional)</label>
          <input
            id="field-max-length"
            name="field_max_length"
            type="number"
            min="0"
            value={fieldForm.max_length}
            onChange={(e) => setFieldForm({ ...fieldForm, max_length: e.target.value })}
          />
          <label htmlFor="field-required-if">Required If Field (optional)</label>
          <input
            id="field-required-if"
            name="required_if_field"
            value={fieldForm.required_if_field}
            onChange={(e) => setFieldForm({ ...fieldForm, required_if_field: e.target.value })}
            placeholder="other_field_name"
          />
          <label htmlFor="field-required-if-value">Required If Equals (optional)</label>
          <input
            id="field-required-if-value"
            name="required_if_value"
            value={fieldForm.required_if_value}
            onChange={(e) => setFieldForm({ ...fieldForm, required_if_value: e.target.value })}
            placeholder="trigger value"
          />
          <label htmlFor="field-page-number">Page Number</label>
          <input
            id="field-page-number"
            name="page_number"
            type="number"
            min="1"
            max={pdfMeta.pages || 1}
            value={fieldForm.page_number}
            onChange={(e) => setFieldForm({ ...fieldForm, page_number: Number(e.target.value || 1) })}
            required
          />
          <label htmlFor="field-mapped-x">Mapped X</label>
          <input id="field-mapped-x" name="x_position" type="number" value={fieldForm.x_position} readOnly />
          <label htmlFor="field-mapped-y">Mapped Y</label>
          <input id="field-mapped-y" name="y_position" type="number" value={fieldForm.y_position} readOnly />
          <label htmlFor="field-box-width">Box Width</label>
          <input id="field-box-width" name="box_width" type="number" value={fieldForm.box_width} readOnly />
          <label htmlFor="field-box-height">Box Height</label>
          <input id="field-box-height" name="box_height" type="number" value={fieldForm.box_height} readOnly />
          <label htmlFor="field-auto-font-size">Auto Font Size</label>
          <input id="field-auto-font-size" name="auto_font_size" type="number" value={Math.max(6, Math.round(Number(fieldForm.box_height || 0) * 0.75))} readOnly />
          <label className="checkbox-line" htmlFor="field-required">
            <input
              id="field-required"
              name="required"
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
          <div ref={stageRef} className="pdf-stage">
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
        <div className="section-heading">
          <div>
            <h3>Document Checklist Requirements</h3>
            <p className="muted">Define which supporting documents CSR users must upload when submitting this template.</p>
          </div>
        </div>

        {!selectedTemplateId ? (
          <p className="muted">Select a template to manage its document requirements.</p>
        ) : (
          <>
            <form className="doc-req-form" onSubmit={saveDocRequirement}>
              <div className="doc-req-form-row">
                <div>
                  <label htmlFor="doc-req-name">Document Name</label>
                  <input
                    id="doc-req-name"
                    value={docReqForm.document_name}
                    onChange={(e) => setDocReqForm((p) => ({ ...p, document_name: e.target.value }))}
                    placeholder="e.g. Valid ID, Proof of Billing"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="doc-req-types">Allowed File Types</label>
                  <select
                    id="doc-req-types"
                    value={docReqForm.allowed_types}
                    onChange={(e) => setDocReqForm((p) => ({ ...p, allowed_types: e.target.value }))}
                  >
                    <option value="image_or_pdf">Image or PDF</option>
                    <option value="image">Image only</option>
                    <option value="pdf">PDF only</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="doc-req-order">Order</label>
                  <input
                    id="doc-req-order"
                    type="number"
                    min="0"
                    value={docReqForm.sort_order}
                    onChange={(e) => setDocReqForm((p) => ({ ...p, sort_order: Number(e.target.value) }))}
                    style={{ width: '70px' }}
                  />
                </div>
                <div className="doc-req-required-toggle">
                  <label className="checkbox-line" htmlFor="doc-req-required">
                    <input
                      id="doc-req-required"
                      type="checkbox"
                      checked={docReqForm.required}
                      onChange={(e) => setDocReqForm((p) => ({ ...p, required: e.target.checked }))}
                    />
                    Required
                  </label>
                </div>
              </div>
              <div className="actions" style={{ marginTop: '8px' }}>
                <button type="submit">{docReqEditId ? 'Update Requirement' : 'Add Requirement'}</button>
                {docReqEditId && (
                  <button type="button" onClick={() => { setDocReqEditId(''); setDocReqForm({ document_name: '', required: true, allowed_types: 'image_or_pdf', sort_order: 0 }); }}>
                    Cancel
                  </button>
                )}
              </div>
            </form>

            {docRequirements.length > 0 ? (
              <div className="table-wrap" style={{ marginTop: '16px' }}>
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Document Name</th>
                      <th>Required</th>
                      <th>Allowed Types</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {docRequirements.map((req, idx) => (
                      <tr key={req.id}>
                        <td>{idx + 1}</td>
                        <td>{req.document_name}</td>
                        <td>{req.required ? 'Yes' : 'Optional'}</td>
                        <td>{req.allowed_types === 'image_or_pdf' ? 'Image or PDF' : req.allowed_types === 'image' ? 'Image' : 'PDF'}</td>
                        <td className="actions">
                          <button type="button" onClick={() => startEditDocReq(req)}>Edit</button>
                          <button type="button" onClick={() => deleteDocRequirement(req.id)}>Delete</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted" style={{ marginTop: '12px' }}>No document requirements configured yet.</p>
            )}
          </>
        )}
      </section>
      </>
      )}

      {activeAdminTab === 'home' && (
      <>
      <section className="admin-stats-grid">
        {adminOverviewStats.map((stat) => (
          <div key={stat.label} className="card admin-stat-card">
            <span className="admin-stat-label">{stat.label}</span>
            <strong className="admin-stat-value">{stat.value}</strong>
            <span className="admin-stat-meta">{stat.meta}</span>
          </div>
        ))}
      </section>

      <section className="card">
        <div className="section-heading">
          <div>
            <h3>Template Analytics</h3>
            <p className="muted">Current month metrics for the selected template.</p>
          </div>
          <span className="section-chip">{selectedTemplate?.title || 'No template selected'}</span>
        </div>
        {analytics ? (
          <div className="analytics-strip">
            {adminAnalyticsItems.map((item, index) => (
              <div
                key={item.label}
                className={`analytics-strip-item analytics-tone-${item.tone || 'primary'}${index === 0 ? ' analytics-strip-item-featured' : ''}`}
              >
                <span className="analytics-strip-kicker">{selectedTemplate?.title || 'Template'}</span>
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
        <div className="chart-combo">
          <StatusStackedBarChart
            monthlyData={monthlyByStatus}
            timeRange={monthlyReportRange}
            onTimeRangeChange={setMonthlyReportRange}
            description="Monthly PDF outcomes by status across all templates."
            emptyText="No monthly data available yet."
          />
          <StatusDonutChart analytics={analytics} />
        </div>
      </section>
      </>
      )}

      {activeAdminTab === 'workflow' && (
      <>
      <section className="card admin-context-card">
        <div>
          <h3>Workflow Workspace</h3>
          <p className="muted">{selectedTemplate ? `Managing ${selectedTemplate.title}.` : 'Select a template in the Templates tab before managing workflow.'}</p>
        </div>
        <div className="actions">
          <button type="button" onClick={() => setActiveAdminTab('templates')}>Open Templates Tab</button>
        </div>
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
            <label htmlFor="admin-filter-keyword">Keyword</label>
            <input
              id="admin-filter-keyword"
              name="keyword"
              value={listFilters.keyword}
              onChange={(e) => setListFilters({ ...listFilters, keyword: e.target.value })}
              placeholder="Search submitted data / id / user"
            />
            <label htmlFor="admin-filter-user">User</label>
            <select
              id="admin-filter-user"
              name="user_id"
              value={listFilters.user_id}
              onChange={(e) => setListFilters({ ...listFilters, user_id: e.target.value })}
            >
              <option value="">All users</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.name} ({u.email})</option>
              ))}
            </select>
            <label htmlFor="admin-filter-date-from">Date From</label>
            <input
              id="admin-filter-date-from"
              name="date_from"
              type="date"
              value={listFilters.date_from}
              onChange={(e) => setListFilters({ ...listFilters, date_from: e.target.value })}
            />
            <label htmlFor="admin-filter-date-to">Date To</label>
            <input
              id="admin-filter-date-to"
              name="date_to"
              type="date"
              value={listFilters.date_to}
              onChange={(e) => setListFilters({ ...listFilters, date_to: e.target.value })}
            />
          </div>

          <div className="card">
            <h4>Bulk Actions</h4>
            <label htmlFor="admin-bulk-status">Status</label>
            <select id="admin-bulk-status" name="bulk_status" value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)}>
              {statusTabs.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            {bulkStatus === 'rescheduled' && (
              <>
                <label htmlFor="admin-bulk-reschedule-date">Reschedule Date</label>
                <input
                  id="admin-bulk-reschedule-date"
                  name="bulk_reschedule_date"
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
                    name="select_all_rows"
                    aria-label="Select all workflow rows"
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
                <>
                <tr key={item.id}>
                  <td>
                    <input
                      name={`selected_row_${item.id}`}
                      aria-label={`Select row ${item.id}`}
                      type="checkbox"
                      checked={Boolean(selectedRows[item.id])}
                      onChange={(e) => setSelectedRows({ ...selectedRows, [item.id]: e.target.checked })}
                    />
                  </td>
                  <td className="mono">{item.id.slice(0, 8)}...</td>
                  <td>
                    <div className="user-cell">
                      <img className="avatar avatar-sm" src={resolveAvatar({ name: item.user_name || item.user_id || 'User', avatar_url: item.user_avatar_url })} alt={item.user_name || 'User'} />
                      <span>{item.user_name || item.user_id || '-'}</span>
                    </div>
                  </td>
                  <td>{new Date(item.created_at).toLocaleString()}</td>
                  <td>{item.status_note || '-'}</td>
                  <td className="actions">
                    <button type="button" onClick={() => downloadWithToken(`/generated-pdfs/${item.id}/download`, token)}>Download</button>
                    <button type="button" onClick={() => toggleWorkflowAttachments(item.id)}>
                      {workflowAttachmentRowId === item.id ? 'Hide Files' : 'Files'}
                    </button>
                    <button type="button" onClick={() => viewHistory(item.id)}>History</button>
                    <button type="button" onClick={() => updateStatus(item.id, 'done')}>Done</button>
                    <button type="button" onClick={() => updateStatus(item.id, 'cancelled')}>Cancel</button>
                    <button type="button" onClick={() => updateStatus(item.id, 'rescheduled')}>Reschedule</button>
                  </td>
                </tr>
                {workflowAttachmentRowId === item.id && (
                  <tr key={`${item.id}-attachments`}>
                    <td colSpan="6">
                      <div className="attachment-inline-panel">
                        {workflowAttachments.length === 0 ? (
                          <span className="muted">No attachments for this record.</span>
                        ) : (
                          <ul className="attachment-list">
                            {workflowAttachments.map((att) => (
                              <li key={att.id} className="attachment-item">
                                <span className="attachment-name">{att.original_name}</span>
                                {att.document_name && <span className="attachment-doc-label">{att.document_name}</span>}
                                <button
                                  type="button"
                                  className="btn-sm"
                                  onClick={() => openWithTokenInNewTab(`/attachments/${att.id}/file`, token)}
                                >
                                  Open
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
                </>
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
      </>
      )}

      {activeAdminTab === 'auto-reply' && (
      <>
      {/* ── Lightbox ── */}
      {arLightbox && (
        <div className="ar-lightbox" onClick={() => setArLightbox(null)}>
          <img src={arLightbox.src} alt={arLightbox.alt} onClick={(e) => e.stopPropagation()} />
          <button className="ar-lightbox-close" onClick={() => setArLightbox(null)}>✕</button>
        </div>
      )}

      {/* ── Create new messages ── */}
      <section className="card">
        <h3>Create Auto Reply Messages</h3>
        {arNewForms.map((form, idx) => (
          <div key={arNewInputKeys[idx]} className="ar-new-form">
            <div className="ar-new-form-header">
              <strong>Message {idx + 1}</strong>
              {arNewForms.length > 1 && (
                <button
                  type="button"
                  className="btn-sm btn-danger"
                  onClick={() => {
                    setArNewForms((prev) => prev.filter((_, i) => i !== idx));
                    setArNewInputKeys((prev) => prev.filter((_, i) => i !== idx));
                  }}
                >
                  Remove
                </button>
              )}
            </div>
            <label>Title</label>
            <input
              type="text"
              placeholder="Message title"
              value={form.title}
              onChange={(e) => {
                const next = [...arNewForms];
                next[idx] = { ...next[idx], title: e.target.value };
                setArNewForms(next);
              }}
            />
            <label>Message Text</label>
            <textarea
              rows={5}
              placeholder="Enter the reply message text…"
              value={form.message_text}
              onChange={(e) => {
                const next = [...arNewForms];
                next[idx] = { ...next[idx], message_text: e.target.value };
                setArNewForms(next);
              }}
            />
            <label>Images (optional)</label>
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                const next = [...arNewForms];
                next[idx] = { ...next[idx], images: files };
                setArNewForms(next);
              }}
            />
            {form.images && form.images.length > 0 && (
              <p className="muted">{form.images.length} image(s) selected</p>
            )}
          </div>
        ))}

        <div className="ar-create-actions">
          <button
            type="button"
            onClick={() => {
              setArNewForms((prev) => [...prev, { title: '', message_text: '', images: [] }]);
              setArNewInputKeys((prev) => [...prev, Date.now()]);
            }}
          >
            + Add Another Message
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={arBusy}
            onClick={async () => {
              for (const form of arNewForms) {
                if (!form.title.trim() || !form.message_text.trim()) {
                  setMessage('Each message must have a title and text.');
                  return;
                }
              }
              setArBusy(true);
              try {
                for (const form of arNewForms) {
                  const fd = new FormData();
                  fd.append('title', form.title.trim());
                  fd.append('message_text', form.message_text.trim());
                  for (const img of (form.images || [])) fd.append('images', img);
                  await apiRequest('/auto-reply', { method: 'POST', token, formData: fd });
                }
                setArNewForms([{ title: '', message_text: '', images: [] }]);
                setArNewInputKeys([Date.now()]);
                await loadArMessages();
                setMessage('Messages created successfully.');
              } catch (e) {
                setMessage(e.message || 'Failed to create messages');
              } finally {
                setArBusy(false);
              }
            }}
          >
            {arBusy ? 'Saving…' : 'Save Messages'}
          </button>
        </div>
      </section>

      {/* ── Existing messages ── */}
      <section className="card">
        <h3>Existing Messages</h3>
        {!arLoaded && <p className="muted">Loading…</p>}
        {arLoaded && arMessages.length === 0 && <p className="muted">No messages yet.</p>}
        {arMessages.map((msg) => (
          <div key={msg.id} className="ar-admin-card">
            {arEditId === msg.id ? (
              /* ── Edit mode ── */
              <div className="ar-edit-form">
                <label>Title</label>
                <input
                  type="text"
                  value={arEditForm.title}
                  onChange={(e) => setArEditForm({ ...arEditForm, title: e.target.value })}
                />
                <label>Message Text</label>
                <textarea
                  rows={5}
                  value={arEditForm.message_text}
                  onChange={(e) => setArEditForm({ ...arEditForm, message_text: e.target.value })}
                />
                <div className="ar-edit-actions">
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={arBusy}
                    onClick={async () => {
                      if (!arEditForm.title.trim() || !arEditForm.message_text.trim()) {
                        setMessage('Title and text are required.');
                        return;
                      }
                      setArBusy(true);
                      try {
                        await apiRequest(`/auto-reply/${msg.id}`, {
                          method: 'PUT', token,
                          body: { title: arEditForm.title.trim(), message_text: arEditForm.message_text.trim() }
                        });
                        await loadArMessages();
                        setArEditId('');
                        setMessage('Message updated.');
                      } catch (e) {
                        setMessage(e.message || 'Failed to update');
                      } finally {
                        setArBusy(false);
                      }
                    }}
                  >
                    {arBusy ? 'Saving…' : 'Save'}
                  </button>
                  <button type="button" onClick={() => setArEditId('')}>Cancel</button>
                </div>
              </div>
            ) : (
              /* ── View mode ── */
              <div>
                <div className="ar-admin-card-header">
                  <strong className="ar-card-title">{msg.title}</strong>
                  <div className="ar-card-actions">
                    <button
                      type="button"
                      className="btn-sm"
                      onClick={() => {
                        setArEditId(msg.id);
                        setArEditForm({ title: msg.title, message_text: msg.message_text });
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn-sm btn-danger"
                      disabled={arBusy}
                      onClick={async () => {
                        if (!window.confirm('Delete this message and all its images?')) return;
                        setArBusy(true);
                        try {
                          await apiRequest(`/auto-reply/${msg.id}`, { method: 'DELETE', token });
                          await loadArMessages();
                          setMessage('Message deleted.');
                        } catch (e) {
                          setMessage(e.message || 'Failed to delete');
                        } finally {
                          setArBusy(false);
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                <pre className="ar-message-text">{msg.message_text}</pre>
              </div>
            )}

            {/* ── Images for this message ── */}
            <div className="ar-admin-images">
              <strong>Images</strong>
              {msg.images && msg.images.length > 0 ? (
                <div className="ar-images">
                  {msg.images.map((img) => (
                    <div key={img.id} className="ar-thumb-wrap">
                      <img
                        src={`${getApiBase()}/auto-reply/images/${img.id}`}
                        alt={img.original_name || 'image'}
                        className="ar-thumb"
                        onClick={() => setArLightbox({ src: `${getApiBase()}/auto-reply/images/${img.id}`, alt: img.original_name || 'image' })}
                        title="Click to enlarge"
                      />
                      <button
                        type="button"
                        className="ar-img-delete"
                        title="Remove image"
                        disabled={arBusy}
                        onClick={async () => {
                          if (!window.confirm('Remove this image?')) return;
                          setArBusy(true);
                          try {
                            await apiRequest(`/auto-reply/${msg.id}/images/${img.id}`, { method: 'DELETE', token });
                            await loadArMessages();
                          } catch (e) {
                            setMessage(e.message || 'Failed to delete image');
                          } finally {
                            setArBusy(false);
                          }
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">No images.</p>
              )}
              <label className="ar-add-img-label">Add Images</label>
              <input
                key={arAddImgInputKey}
                type="file"
                accept="image/*"
                multiple
                onChange={async (e) => {
                  const files = Array.from(e.target.files || []);
                  if (files.length === 0) return;
                  setArBusy(true);
                  try {
                    const fd = new FormData();
                    for (const f of files) fd.append('images', f);
                    await apiRequest(`/auto-reply/${msg.id}/images`, { method: 'POST', token, formData: fd });
                    await loadArMessages();
                    setArAddImgInputKey((k) => k + 1);
                  } catch (err) {
                    setMessage(err.message || 'Failed to upload images');
                  } finally {
                    setArBusy(false);
                  }
                }}
              />
            </div>
          </div>
        ))}
      </section>
      </>
      )}

      {/* ── QR Link tab ── */}
      {activeAdminTab === 'qr-link' && (
        <section className="card">
          <h3>QR Link</h3>
          <p className="muted" style={{ marginBottom: 16 }}>
            Add as many QR codes as you like. Each saved entry is immediately visible to users.
          </p>

          {/* ── Add new QR form ── */}
          <div className="qr-add-form">
            <div className="bt-field" style={{ marginBottom: 12 }}>
              <label htmlFor="qr-url-input">Link URL</label>
              <input
                id="qr-url-input"
                type="url"
                placeholder="https://example.com"
                value={qrDraftUrl}
                onChange={(e) => { setQrDraftUrl(e.target.value); setQrDraftDataUrl(''); }}
              />
            </div>
            <div className="bt-field" style={{ marginBottom: 16 }}>
              <label htmlFor="qr-label-input">Label (optional)</label>
              <input
                id="qr-label-input"
                type="text"
                placeholder="e.g. Customer Portal"
                value={qrDraftLabel}
                onChange={(e) => setQrDraftLabel(e.target.value)}
              />
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
              <button
                type="button"
                className="btn-primary"
                disabled={!qrDraftUrl.trim()}
                onClick={async () => {
                  try {
                    const dataUrl = await QRCode.toDataURL(qrDraftUrl.trim(), {
                      width: 260, margin: 2,
                      color: { dark: '#112b47', light: '#ffffff' },
                    });
                    setQrDraftDataUrl(dataUrl);
                  } catch {
                    setMessage('Failed to generate QR code. Check the URL.');
                  }
                }}
              >
                Generate QR
              </button>
              {qrDraftDataUrl && (
                <>
                  <button
                    type="button"
                    onClick={() => window.open(qrDraftUrl.trim(), '_blank', 'noopener,noreferrer')}
                  >
                    Test Link
                  </button>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={qrBusy}
                    onClick={async () => {
                      setQrBusy(true);
                      try {
                        const saved = await apiRequest('/qr-link', {
                          method: 'POST', token,
                          body: { url: qrDraftUrl.trim(), label: qrDraftLabel.trim() || null },
                        });
                        setQrLinks((prev) => [...prev, saved]);
                        setQrDraftUrl('');
                        setQrDraftLabel('');
                        setQrDraftDataUrl('');
                        setMessage('QR code saved and published.');
                      } catch (err) {
                        setMessage(err.message || 'Failed to save QR link');
                      } finally {
                        setQrBusy(false);
                      }
                    }}
                  >
                    {qrBusy ? 'Saving…' : 'Save & Publish'}
                  </button>
                  <button
                    type="button"
                    className="btn-danger"
                    onClick={() => { setQrDraftDataUrl(''); setQrDraftUrl(''); setQrDraftLabel(''); }}
                  >
                    Redo
                  </button>
                </>
              )}
            </div>

            {/* Draft preview */}
            {qrDraftDataUrl && (
              <div className="qr-admin-preview">
                {qrDraftLabel && <p className="qr-label">{qrDraftLabel}</p>}
                <img
                  src={qrDraftDataUrl}
                  alt="Generated QR Code"
                  className="qr-image qr-image--admin"
                  title="Click to enlarge"
                  onClick={() => setQrLightbox(true)}
                />
                <p className="qr-url">{qrDraftUrl}</p>
                {qrLightbox && (
                  <div className="ar-lightbox" onClick={() => setQrLightbox(false)}>
                    <img src={qrDraftDataUrl} alt="QR Code (enlarged)" onClick={(e) => e.stopPropagation()} />
                    <button className="ar-lightbox-close" onClick={() => setQrLightbox(false)}>✕</button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Saved QR codes list ── */}
          {qrLinks.length > 0 && (
            <>
              <h4 style={{ marginTop: 28, marginBottom: 14 }}>Published QR Codes ({qrLinks.length})</h4>
              <div className="qr-admin-grid">
                {qrLinks.map((link) => (
                  <QrAdminCard
                    key={link.id}
                    link={link}
                    token={token}
                    onDelete={(id) => setQrLinks((prev) => prev.filter((l) => l.id !== id))}
                    onError={(msg) => setMessage(msg)}
                  />
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {/* ── Tracking tab ── */}
      {activeAdminTab === 'tracking' && (
        <section className="card">
          <h3>Tracker Configuration</h3>
          <p className="muted" style={{ marginBottom: 16 }}>
            Configure GPS tracking integrations. The backend authenticates to the provider and serves vehicle data to users — credentials are never exposed to the browser.
          </p>

          {/* Form */}
          <div className="tracker-form">
            <h4 style={{ marginBottom: 12 }}>{trackerEditId ? 'Edit Tracker' : 'Add Tracker'}</h4>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
              <div className="bt-field">
                <label>Tracker Name</label>
                <input
                  type="text"
                  placeholder="e.g. Imperial Tracking"
                  value={trackerForm.name}
                  onChange={(e) => setTrackerForm((f) => ({ ...f, name: e.target.value }))}
                />
              </div>
              <div className="bt-field">
                <label>Provider Base URL</label>
                <input
                  type="url"
                  placeholder="https://en.aika168.com/"
                  value={trackerForm.base_url}
                  onChange={(e) => setTrackerForm((f) => ({ ...f, base_url: e.target.value }))}
                />
              </div>
              <div className="bt-field">
                <label>Account Username</label>
                <input
                  type="text"
                  placeholder="Portal account username"
                  value={trackerForm.username}
                  onChange={(e) => setTrackerForm((f) => ({ ...f, username: e.target.value }))}
                />
              </div>
              <div className="bt-field">
                <label>
                  Account Password
                  {trackerEditId && <span className="muted" style={{ marginLeft: 8, fontWeight: 400 }}>— leave blank to keep</span>}
                </label>
                <input
                  type="password"
                  placeholder={trackerEditId ? '(unchanged)' : 'Portal account password'}
                  value={trackerForm.password}
                  onChange={(e) => setTrackerForm((f) => ({ ...f, password: e.target.value }))}
                  autoComplete="new-password"
                />
              </div>
              <div className="bt-field">
                <label>Refresh Interval (seconds)</label>
                <input
                  type="number"
                  min="10"
                  max="3600"
                  value={trackerForm.refresh_interval_seconds}
                  onChange={(e) => setTrackerForm((f) => ({ ...f, refresh_interval_seconds: e.target.value }))}
                />
              </div>
              <div className="bt-field">
                <label>Notes (optional)</label>
                <input
                  type="text"
                  placeholder="e.g. Fleet vehicles — Aika168 account"
                  value={trackerForm.notes}
                  onChange={(e) => setTrackerForm((f) => ({ ...f, notes: e.target.value }))}
                />
              </div>
            </div>
            <div className="bt-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 }}>
              <input
                id="tracker-enabled"
                type="checkbox"
                checked={trackerForm.enabled}
                onChange={(e) => setTrackerForm((f) => ({ ...f, enabled: e.target.checked }))}
                style={{ width: 'auto' }}
              />
              <label htmlFor="tracker-enabled" style={{ margin: 0 }}>Enabled (visible to users)</label>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn-primary"
                disabled={trackerBusy || !trackerForm.name.trim() || !trackerForm.base_url.trim()}
                onClick={async () => {
                  setTrackerBusy(true);
                  try {
                    if (trackerEditId) {
                      const updated = await apiRequest(`/tracking/${trackerEditId}`, {
                        method: 'PUT', token, body: trackerForm
                      });
                      setTrackers((prev) => prev.map((t) => t.id === trackerEditId ? updated : t));
                      setMessage('Tracker updated.');
                    } else {
                      const created = await apiRequest('/tracking', {
                        method: 'POST', token, body: trackerForm
                      });
                      setTrackers((prev) => [...prev, created]);
                      setMessage('Tracker added.');
                    }
                    setTrackerEditId('');
                    setTrackerForm({ name: '', base_url: '', username: '', password: '', enabled: true, notes: '', refresh_interval_seconds: 60 });
                  } catch (err) {
                    setMessage(err.message || 'Failed to save tracker');
                  } finally {
                    setTrackerBusy(false);
                  }
                }}
              >
                {trackerBusy ? 'Saving…' : trackerEditId ? 'Update Tracker' : 'Add Tracker'}
              </button>
              {trackerEditId && (
                <button
                  type="button"
                  onClick={() => {
                    setTrackerEditId('');
                    setTrackerForm({ name: '', base_url: '', username: '', password: '', enabled: true, notes: '', refresh_interval_seconds: 60 });
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          </div>

          {/* Tracker list */}
          {trackers.length > 0 && (
            <div style={{ marginTop: 28 }}>
              <h4 style={{ marginBottom: 14 }}>Configured Trackers ({trackers.length})</h4>
              <div className="tracker-list">
                {trackers.map((t) => (
                  <div key={t.id} className={`tracker-card${!t.enabled ? ' tracker-card--disabled' : ''}`}>
                    <div className="tracker-card-header">
                      <span className="tracker-card-name">{t.name}</span>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        {t.sync_status && (
                          <span className={`tracker-badge ${t.sync_status === 'success' ? 'tracker-badge--sync-ok' : 'tracker-badge--sync-err'}`}>
                            {t.sync_status === 'success' ? 'Synced' : 'Sync Error'}
                          </span>
                        )}
                        <span className={`tracker-badge ${t.enabled ? 'tracker-badge--on' : 'tracker-badge--off'}`}>
                          {t.enabled ? 'Enabled' : 'Disabled'}
                        </span>
                      </div>
                    </div>
                    <p className="tracker-card-url">{t.base_url}</p>
                    {t.username && <p className="tracker-card-meta">Username: {t.username}</p>}
                    {t.has_password && <p className="tracker-card-meta">Password: ••••••••</p>}
                    <p className="tracker-card-meta">Refresh: every {t.refresh_interval_seconds || 60}s</p>
                    {t.last_sync_at && (
                      <p className="tracker-card-meta">
                        Last sync: {new Date(t.last_sync_at).toLocaleString()}
                      </p>
                    )}
                    {t.sync_error && (
                      <p className="tracker-card-notes" style={{ color: 'var(--danger)', fontStyle: 'normal' }}>
                        Error: {t.sync_error}
                      </p>
                    )}
                    {t.notes && <p className="tracker-card-notes">{t.notes}</p>}
                    <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="btn-sm"
                        onClick={() => {
                          setTrackerEditId(t.id);
                          setTrackerForm({
                            name: t.name,
                            base_url: t.base_url,
                            username: t.username || '',
                            password: '',
                            enabled: t.enabled,
                            notes: t.notes || '',
                            refresh_interval_seconds: t.refresh_interval_seconds || 60,
                          });
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn-sm btn-primary"
                        disabled={trackerSyncingId === t.id}
                        onClick={async () => {
                          setTrackerSyncingId(t.id);
                          try {
                            await apiRequest(`/tracking/${t.id}/sync`, { method: 'POST', token });
                            // Reload tracker list to get updated sync status
                            const data = await apiRequest('/tracking/admin', { token });
                            setTrackers(data);
                            setMessage('Sync triggered successfully.');
                          } catch (err) {
                            setMessage(err.message || 'Sync failed');
                            const data = await apiRequest('/tracking/admin', { token }).catch(() => null);
                            if (data) setTrackers(data);
                          } finally {
                            setTrackerSyncingId('');
                          }
                        }}
                      >
                        {trackerSyncingId === t.id ? 'Syncing…' : 'Sync Now'}
                      </button>
                      <button
                        type="button"
                        className="btn-sm btn-danger"
                        onClick={async () => {
                          if (!window.confirm(`Delete tracker "${t.name}"?`)) return;
                          try {
                            await apiRequest(`/tracking/${t.id}`, { method: 'DELETE', token });
                            setTrackers((prev) => prev.filter((x) => x.id !== t.id));
                            setMessage('Tracker deleted.');
                          } catch (err) {
                            setMessage(err.message || 'Failed to delete tracker');
                          }
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {trackers.length === 0 && trackerLoaded && (
            <p className="muted" style={{ marginTop: 20 }}>No trackers configured yet.</p>
          )}
        </section>
      )}
    </div>
  );
}
