import React, { useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest, downloadWithToken, fetchArrayBuffer, openWithTokenInNewTab } from '../api.js';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/build/pdf.mjs';
import workerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url';
import ProfileSidebar from './ProfileSidebar.jsx';
import StatusStackedBarChart from './StatusStackedBarChart.jsx';
import StatusDonutChart from './StatusDonutChart.jsx';
import BillingTools from './BillingTools.jsx';
import Profiling from './Profiling.jsx';
import { resolveAvatar } from '../utils/avatar.js';

GlobalWorkerOptions.workerSrc = workerSrc;

const statusTabs = ['pending', 'done', 'cancelled', 'rescheduled'];
const userViews = [
  {
    id: 'create',
    label: 'PDF Creation',
    chip: 'PC',
    title: 'Generate a new document',
    description: 'Pick a template, fill the mapped fields, and track everything you generated.'
  },
  {
    id: 'tools',
    label: 'Tools',
    chip: 'TL',
    title: 'Support tools',
    description: 'Billing helpers, auto reply, QR links, tracking, and ticketing.'
  },
  {
    id: 'analytics',
    label: 'Analytics',
    chip: 'AN',
    title: 'Template analytics',
    description: 'Month-to-date metrics, monthly outcomes, and the field position mapper.'
  },
  {
    id: 'profiling',
    label: 'Profiling',
    chip: 'PR',
    title: 'Document archive',
    description: 'Every generated PDF filed by year and month, plus the older paperwork you upload yourself.'
  }
];
const userSections = [
  {
    id: 'create',
    label: 'Create PDF',
    chip: 'CP',
    title: 'Generate a new document',
    description: 'Select a template, fill the mapped fields, and open the PDF instantly.'
  },
  {
    id: 'analytics',
    label: 'Analytics',
    chip: 'AN',
    title: 'Track template activity',
    description: 'Review the selected template metrics and the monthly chart across your templates.'
  },
  {
    id: 'preview',
    label: 'Preview',
    chip: 'PV',
    title: 'Check mapped positions',
    description: 'Preview where the template fields land on the PDF before you generate.'
  },
  {
    id: 'history',
    label: 'My PDFs',
    chip: 'MY',
    title: 'Manage generated PDFs',
    description: 'Search, update status, and reopen any file you already generated.'
  }
];
const emptyListFilters = {
  keyword: '',
  date_from: '',
  date_to: ''
};
const DEFAULT_MONTHLY_RANGE = '3';

function getUserTemplateStorageKey(userId) {
  return `user-panel:selected-template:${userId || 'anonymous'}`;
}

function getDraftKey(userId, templateId) {
  return `user-panel:form-draft:${userId || 'anon'}:${templateId}`;
}

function humanFieldHint(field) {
  const rules = field.validation_rules || {};
  const parts = [];
  if (rules.min_length) parts.push(`Min ${rules.min_length} chars`);
  if (rules.max_length) parts.push(`Max ${rules.max_length} chars`);
  if (rules.regex) {
    const p = String(rules.regex);
    if (p.includes('@')) parts.push('Must be a valid email');
    else if (/^\^?\\d/.test(p)) parts.push('Numbers only');
    else parts.push('Must match required format');
  }
  return parts.join(' · ');
}

function validateFieldValue(field, value, formValues) {
  const rules = field.validation_rules || {};
  const requiredNow = field.required || isRequiredIfTriggered(field, formValues);
  if (requiredNow && isMissingRequiredValue(field, value)) {
    return `${field.field_name} is required`;
  }
  if (field.field_type !== 'checkbox' && value !== undefined && value !== null && String(value) !== '') {
    const str = String(value);
    if (rules.min_length && str.length < Number(rules.min_length)) return `Min ${rules.min_length} characters`;
    if (rules.max_length && str.length > Number(rules.max_length)) return `Max ${rules.max_length} characters`;
    if (rules.regex) {
      try {
        if (!new RegExp(String(rules.regex)).test(str)) return humanFieldHint(field) || 'Invalid format';
      } catch { /* ignore bad regex */ }
    }
  }
  return '';
}

function readStoredTemplateId(userId) {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(getUserTemplateStorageKey(userId)) || '';
}

function writeStoredTemplateId(userId, templateId) {
  if (typeof window === 'undefined') return;
  const key = getUserTemplateStorageKey(userId);
  if (templateId) {
    window.localStorage.setItem(key, templateId);
    return;
  }
  window.localStorage.removeItem(key);
}

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

function buildFieldValues(fieldList, previousValues = {}) {
  const next = {};
  for (const field of fieldList) {
    const key = field.field_name;
    if (field.field_type === 'date') {
      next[key] = previousValues[key] || todayIsoDate();
      continue;
    }
    if (field.field_type === 'checkbox') {
      next[key] = previousValues[key] === undefined ? false : isCheckedCheckboxValue(previousValues[key]);
      continue;
    }
    next[key] = previousValues[key] ?? '';
  }
  return next;
}

function DocFilePreview({ file }) {
  const [src, setSrc] = React.useState('');
  React.useEffect(() => {
    if (!file || !file.type.startsWith('image/')) { setSrc(''); return; }
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  if (!file || !src) return null;
  return <img src={src} alt={file.name} className="doc-preview-thumb" />;
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
  const [rowEdit, setRowEdit] = useState(null); // { id, note, reschedule_date }
  const [showPreviewMapper, setShowPreviewMapper] = useState(false);
  const [analytics, setAnalytics] = useState(null);
  const [monthlyReport, setMonthlyReport] = useState([]);
  const [monthlyByStatus, setMonthlyByStatus] = useState([]);
  const [predefinedPdfs, setPredefinedPdfs] = useState([]);
  const [monthlyReportRange, setMonthlyReportRange] = useState(DEFAULT_MONTHLY_RANGE);
  const [pendingPageSize, setPendingPageSize] = useState('20');
  const [pendingPage, setPendingPage] = useState(1);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [activeUserSection, setActiveUserSection] = useState('create');
  const [activeView, setActiveView] = useState('create');
  const [listFilters, setListFilters] = useState(emptyListFilters);   // committed/applied
  const [draftFilters, setDraftFilters] = useState(emptyListFilters); // in-progress input
  const [keepValues, setKeepValues] = useState(() => window.localStorage.getItem('user-panel:keep-values') === 'true');
  const [fieldTouched, setFieldTouched] = useState({});
  const [fieldErrors, setFieldErrors] = useState({});
  const [docRequirements, setDocRequirements] = useState([]);
  const [docFiles, setDocFiles] = useState({}); // { requirementId: File }
  const [docFileErrors, setDocFileErrors] = useState({}); // { requirementId: errorMsg }
  const [attachmentRowId, setAttachmentRowId] = useState('');
  const [rowAttachments, setRowAttachments] = useState([]);
  const [showManualAddModal, setShowManualAddModal] = useState(false);
  const [manualAddValues, setManualAddValues] = useState({});
  const [openingPdfId, setOpeningPdfId] = useState(null);
  const [exportOnlyMine, setExportOnlyMine] = useState(false);
  const [showBackTop, setShowBackTop] = useState(false);
  const canvasRef = useRef(null);
  const renderTaskRef = useRef(null);
  const renderRequestRef = useRef(0);
  const manualAddTriggerRef = useRef(null);
  const modalRef = useRef(null);
  const filterDebounceRef = useRef(null);
  const docFilesRef = useRef(docFiles);
  const docRequirementsRef = useRef(docRequirements);
  useEffect(() => { docFilesRef.current = docFiles; }, [docFiles]);
  useEffect(() => { docRequirementsRef.current = docRequirements; }, [docRequirements]);

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
    if (pendingPageSize === 'all') {
      return 1;
    }
    const pageSize = Number(pendingPageSize) || 20;
    return Math.max(1, Math.ceil(generated.length / pageSize));
  }, [pendingPageSize, generated.length]);
  const visibleGenerated = useMemo(() => {
    if (pendingPageSize === 'all') {
      return generated;
    }
    const pageSize = Number(pendingPageSize) || 20;
    const start = (pendingPage - 1) * pageSize;
    return generated.slice(start, start + pageSize);
  }, [generated, pendingPage, pendingPageSize]);
  const rowRangeLabel = useMemo(() => {
    const total = generated.length;
    if (total === 0) return 'No records';
    if (pendingPageSize === 'all') return `Showing all ${total}`;
    const size = Number(pendingPageSize) || 20;
    const start = (pendingPage - 1) * size + 1;
    const end = Math.min(total, pendingPage * size);
    return `Showing ${start}-${end} of ${total}`;
  }, [generated.length, pendingPage, pendingPageSize]);
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
        meta: 'This month',
        tone: 'primary'
      },
      {
        label: 'Pending Backlog',
        value: analytics.pending_backlog ?? 0,
        meta: 'Awaiting action',
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
  const visibleMonthlyReport = useMemo(() => {
    const templateIds = new Set(templates.map((template) => template.id));
    return monthlyReport.filter((template) => templateIds.has(template.template_id));
  }, [monthlyReport, templates]);
  const activeViewMeta = useMemo(
    () => userViews.find((item) => item.id === activeView) || userViews[0],
    [activeView]
  );
  const activeSectionMeta = useMemo(
    () => userSections.find((section) => section.id === activeUserSection) || userSections[0],
    [activeUserSection]
  );
  const compactAnalyticsItems = useMemo(() => analyticsItems.slice(0, 3), [analyticsItems]);

  async function loadTemplates() {
    const data = await apiRequest('/templates', { token });
    setTemplates(data);
    const storedTemplateId = readStoredTemplateId(user?.id);
    const favoriteTemplateId = user?.favorite_template_id;
    const defaultTemplateId =
      storedTemplateId && data.some((tpl) => tpl.id === storedTemplateId)
        ? storedTemplateId
        : favoriteTemplateId && data.some((tpl) => tpl.id === favoriteTemplateId)
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

  async function exportMyTemplateData(format = 'csv', onlyMine = false) {
    if (!selectedTemplateId) {
      setMessage('Please select a template first.');
      return;
    }
    try {
      const params = new URLSearchParams({
        template_id: selectedTemplateId,
        format
      });
      if (onlyMine) params.set('mine', '1');
      await downloadWithToken(`/generated-pdfs/export?${params.toString()}`, token);
    } catch (err) {
      setMessage(err.message);
    }
  }

  async function loadDocRequirements(templateId) {
    if (!templateId) return;
    const data = await apiRequest(`/templates/${templateId}/document-requirements`, { token });
    setDocRequirements(data);
    setDocFiles({});
    setDocFileErrors({});
  }

  async function loadFields(templateId) {
    if (!templateId) return;
    const data = await apiRequest(`/templates/${templateId}/fields`, { token });
    setFields(data);
    // Restore draft values from localStorage for this template
    let savedDraft = {};
    try {
      const raw = window.localStorage.getItem(getDraftKey(user?.id, templateId));
      if (raw) savedDraft = JSON.parse(raw);
    } catch { /* ignore */ }
    setFormValues(buildFieldValues(data, savedDraft));
    setManualAddValues((prev) => buildFieldValues(data, prev));
    setFieldTouched({});
    setFieldErrors({});
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

  async function loadMonthlyReport(months = Number(monthlyReportRange) || Number(DEFAULT_MONTHLY_RANGE)) {
    const data = await apiRequest(`/generated-pdfs/analytics/templates/monthly?months=${months}`, { token });
    setMonthlyReport(data.templates || []);
  }

  async function loadMonthlyByStatus(months = Number(monthlyReportRange) || Number(DEFAULT_MONTHLY_RANGE), templateId = selectedTemplateId) {
    const params = new URLSearchParams({ months });
    if (templateId) params.set('template_id', templateId);
    const data = await apiRequest(`/generated-pdfs/analytics/templates/monthly-by-status?${params}`, { token });
    setMonthlyByStatus(data.months || []);
  }

  async function loadPredefinedPdfs() {
    const data = await apiRequest('/templates/predefined-pdfs', { token });
    setPredefinedPdfs(data);
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

    const pageNumber = Number(previewPage) || 1;
    const page = await pdfDoc.getPage(pageNumber);
    if (requestId !== renderRequestRef.current || !canvasRef.current) {
      return;
    }
    const desiredWidth = Math.min(900, window.innerWidth - 120);
    const scale = desiredWidth / page.getViewport({ scale: 1 }).width;
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
  }

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(''), 5000);
    return () => clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    function onScroll() { setShowBackTop(window.scrollY > 300); }
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  async function openPredefinedPdf(item) {
    if (openingPdfId) return;
    setOpeningPdfId(item.id);
    try {
      await openWithTokenInNewTab(`/templates/predefined-pdfs/${item.id}/file`, token);
    } catch {
      setMessage('Could not open this PDF — the file may be missing. Please contact your admin.');
    } finally {
      setOpeningPdfId(null);
    }
  }

  useEffect(() => {
    loadTemplates().catch((err) => setMessage(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const months = Number(monthlyReportRange) || Number(DEFAULT_MONTHLY_RANGE);
    loadMonthlyReport(months).catch((err) => setMessage(err.message));
    loadMonthlyByStatus(months, selectedTemplateId).catch((err) => setMessage(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthlyReportRange, selectedTemplateId]);

  useEffect(() => {
    const favoriteTemplateId = user?.favorite_template_id;
    const storedTemplateId = readStoredTemplateId(user?.id);
    const hasCurrent = selectedTemplateId && templates.some((template) => template.id === selectedTemplateId);
    if (hasCurrent) return;
    if (storedTemplateId && templates.some((template) => template.id === storedTemplateId)) {
      setSelectedTemplateId(storedTemplateId);
      return;
    }
    if (favoriteTemplateId && templates.some((template) => template.id === favoriteTemplateId)) {
      setSelectedTemplateId(favoriteTemplateId);
      return;
    }
    if (!selectedTemplateId && templates[0]?.id) {
      setSelectedTemplateId(templates[0].id);
    }
  }, [templates, user?.favorite_template_id, user?.id, selectedTemplateId]);

  useEffect(() => {
    writeStoredTemplateId(user?.id, selectedTemplateId);
  }, [selectedTemplateId, user?.id]);

  useEffect(() => {
    loadPredefinedPdfs().catch((err) => setMessage(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedTemplateId) return;
    loadFields(selectedTemplateId).catch((err) => setMessage(err.message));
    loadDocRequirements(selectedTemplateId).catch((err) => setMessage(err.message));
    loadAnalytics(selectedTemplateId).catch((err) => setMessage(err.message));
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

  // item 2: debounce keyword auto-apply (600ms after last keystroke)
  useEffect(() => {
    if (filterDebounceRef.current) clearTimeout(filterDebounceRef.current);
    filterDebounceRef.current = setTimeout(() => {
      setListFilters((prev) => ({ ...prev, keyword: draftFilters.keyword }));
      setPendingPage(1);
    }, 600);
    return () => clearTimeout(filterDebounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftFilters.keyword]);

  // item 3: persist form draft to localStorage on every change
  useEffect(() => {
    if (!selectedTemplateId) return;
    window.localStorage.setItem(getDraftKey(user?.id, selectedTemplateId), JSON.stringify(formValues));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formValues, selectedTemplateId]);

  // item 5: Escape + focus management for manual-add modal
  useEffect(() => {
    if (!showManualAddModal) {
      manualAddTriggerRef.current?.focus();
      return;
    }
    function onKey(e) { if (e.key === 'Escape') setShowManualAddModal(false); }
    window.addEventListener('keydown', onKey);
    const timer = setTimeout(() => modalRef.current?.querySelector('input,button,select,textarea')?.focus(), 40);
    return () => { window.removeEventListener('keydown', onKey); clearTimeout(timer); };
  }, [showManualAddModal]);

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

  useEffect(() => () => {
    renderRequestRef.current += 1;
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
      renderTaskRef.current = null;
    }
  }, []);

  function validateSubmissionValues(values) {
    for (const field of fields) {
      const value = values[field.field_name];
      const rules = field.validation_rules || {};
      const requiredNow = field.required || isRequiredIfTriggered(field, values);
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
  }

  async function createGeneratedPdf(values, { autoDownload = true, successMessage } = {}) {
    validateSubmissionValues(values);

    const created = await apiRequest('/generated-pdfs/generate', {
      method: 'POST',
      token,
      body: {
        template_id: selectedTemplateId,
        submitted_data: values
      }
    });

    let autoDownloadFailed = false;
    if (autoDownload) {
      try {
        await openWithTokenInNewTab(`/generated-pdfs/${created.id}/download`, token);
      } catch (_downloadErr) {
        autoDownloadFailed = true;
      }
    }

    setMessage(
      successMessage || (
        autoDownload
          ? (autoDownloadFailed
            ? 'PDF generated. It could not be opened automatically, use Open PDF in Pending.'
            : 'PDF generated, opened in a new tab, and queued as pending.')
          : 'PDF added to My Generated PDFs. Download it anytime from the list.'
      )
    );

    setActiveStatus('pending');
    setPendingPage(1);
    setListFilters(emptyListFilters);
    await loadGenerated('pending', selectedTemplateId, emptyListFilters);
    await loadAnalytics(selectedTemplateId);
    await loadMonthlyReport();
    return created;
  }

  function renderFormField(field, values, setValues, fieldSetKey = 'main') {
    const requiredNow = field.required || isRequiredIfTriggered(field, values);
    const setFieldValue = (nextValue) => setValues((prev) => ({ ...prev, [field.field_name]: nextValue }));
    const optionsListId = `${fieldSetKey}-dropdown-options-${field.id}`;
    const inputId = `${fieldSetKey}-field-${field.id}`;
    const inputName = `field_${normalizeFieldKey(field.field_name) || field.id}`;
    const isMain = fieldSetKey === 'main';
    const hint = isMain ? humanFieldHint(field) : '';
    const touched = isMain && fieldTouched[field.field_name];
    const errorMsg = isMain && touched ? fieldErrors[field.field_name] : '';

    function handleBlur() {
      if (!isMain) return;
      setFieldTouched((prev) => ({ ...prev, [field.field_name]: true }));
      const err = validateFieldValue(field, values[field.field_name], values);
      setFieldErrors((prev) => ({ ...prev, [field.field_name]: err }));
    }

    const sharedBlur = { onBlur: handleBlur };

    return (
      <div key={field.id} className={`field-wrap${errorMsg ? ' field-wrap--error' : ''}`}>
        <label htmlFor={inputId}>{field.field_name}{requiredNow ? ' *' : ''}</label>
        {field.field_type === 'dropdown' ? (
          <>
            <input
              id={inputId}
              name={inputName}
              list={optionsListId}
              value={values[field.field_name] || ''}
              onChange={(e) => setFieldValue(e.target.value)}
              placeholder={`Type to search or pick ${field.field_name}`}
              required={requiredNow}
              {...sharedBlur}
            />
            <datalist id={optionsListId}>
              {parseFieldOptions(field.field_options).map((option) => (
                <option key={option} value={option} />
              ))}
            </datalist>
          </>
        ) : field.field_type === 'date' ? (
          <input
            id={inputId}
            name={inputName}
            type="date"
            value={values[field.field_name] || ''}
            onChange={(e) => setFieldValue(e.target.value)}
            required={requiredNow}
            {...sharedBlur}
          />
        ) : field.field_type === 'checkbox' ? (
          <label className="checkbox-line" htmlFor={inputId}>
            <input
              id={inputId}
              name={inputName}
              type="checkbox"
              checked={Boolean(values[field.field_name])}
              onChange={(e) => setFieldValue(e.target.checked)}
            />
            Check on generated PDF
          </label>
        ) : field.field_type === 'order_number' ? (
          <input
            id={inputId}
            name={inputName}
            value="Auto-generated on submit"
            readOnly
          />
        ) : (
          <input
            id={inputId}
            name={inputName}
            value={values[field.field_name] || ''}
            onChange={(e) => setFieldValue(e.target.value)}
            minLength={field.validation_rules?.min_length ?? undefined}
            maxLength={field.validation_rules?.max_length ?? undefined}
            required={requiredNow}
            {...sharedBlur}
          />
        )}
        {isMain && errorMsg && <span className="field-error">{errorMsg}</span>}
        {isMain && !errorMsg && hint && <span className="field-hint">{hint}</span>}
        {isMain && requiredNow && !hint && !errorMsg && (
          <span className="field-hint">
            {isRequiredIfTriggered(field, values)
              ? `Required when ${field.validation_rules?.required_if?.field} is "${field.validation_rules?.required_if?.equals}"`
              : 'Required'}
          </span>
        )}
      </div>
    );
  }

  async function submitGeneration(e) {
    e.preventDefault();
    if (!selectedTemplateId) {
      setMessage('Please select a template.');
      return;
    }
    if (!validateDocFiles()) return;

    setLoading(true);
    setMessage('');
    try {
      const hasDocs = Object.keys(docFiles).some((k) => docFiles[k]);
      // Upload the supporting documents FIRST when there are any: the generated
      // PDF is assembled at download time, so opening it before the upload would
      // show page 1 only.
      const created = await createGeneratedPdf(formValues, { autoDownload: !hasDocs });
      if (created?.id && hasDocs) {
        try {
          await uploadDocFiles(created.id);
        } catch (uploadErr) {
          setMessage(`PDF generated but file upload failed: ${uploadErr.message}`);
          return;
        }
        try {
          await openWithTokenInNewTab(`/generated-pdfs/${created.id}/download`, token);
          setMessage('PDF generated with supporting documents attached, opened in a new tab, and queued as pending.');
        } catch (_openErr) {
          setMessage('PDF generated with supporting documents. It could not be opened automatically, use Open PDF in the list.');
        }
      }
      setDocFiles({});
      setDocFileErrors({});
      if (!keepValues) {
        window.localStorage.removeItem(getDraftKey(user?.id, selectedTemplateId));
        setFormValues(buildFieldValues(fields));
        setFieldTouched({});
        setFieldErrors({});
      }
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function submitManualAdd(e) {
    e.preventDefault();
    if (!selectedTemplateId) {
      setMessage('Please select a template.');
      return;
    }

    setLoading(true);
    setMessage('');
    try {
      await createGeneratedPdf(manualAddValues, { autoDownload: false });
      setShowManualAddModal(false);
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

  function startRowEdit(item) {
    setRowEdit({
      id: item.id,
      note: item.status_note || '',
      reschedule_date: toDatetimeLocal(item.reschedule_date) || ''
    });
  }

  function cancelRowEdit() { setRowEdit(null); }

  async function saveRowEdit(item) {
    if (!rowEdit || rowEdit.id !== item.id) return;
    const note = rowEdit.note.trim() || null;
    let status = item.status;
    let rescheduleDate = rowEdit.reschedule_date ? new Date(rowEdit.reschedule_date).toISOString() : null;
    if (rescheduleDate) status = 'rescheduled';
    setLoading(true);
    setMessage('');
    try {
      await apiRequest(`/generated-pdfs/${item.id}/status`, {
        method: 'PATCH',
        token,
        body: { status, note, reschedule_date: status === 'rescheduled' ? rescheduleDate : null }
      });
      setRowEdit(null);
      await loadGenerated(activeStatus, selectedTemplateId);
      await loadAnalytics(selectedTemplateId);
      setMessage('Saved.');
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  }

  // item 2: filter apply/clear
  function applyFilters() {
    setListFilters({ ...draftFilters });
    setPendingPage(1);
  }

  function clearFilters() {
    setDraftFilters(emptyListFilters);
    setListFilters(emptyListFilters);
    setPendingPage(1);
  }

  function getAcceptAttr(allowedTypes) {
    if (allowedTypes === 'image') return 'image/jpeg,image/png,image/gif,image/webp,image/bmp';
    if (allowedTypes === 'pdf') return 'application/pdf';
    return 'image/jpeg,image/png,image/gif,image/webp,image/bmp,application/pdf';
  }

  function clipboardImageToFile(clipboardData) {
    const items = Array.from(clipboardData?.items || []);
    const imageItem = items.find((i) => i.type.startsWith('image/'));
    if (!imageItem) return null;
    const blob = imageItem.getAsFile();
    if (!blob) return null;
    const ext = imageItem.type.includes('png') ? 'png'
      : imageItem.type.includes('gif') ? 'gif'
      : imageItem.type.includes('webp') ? 'webp'
      : 'jpg';
    return new File([blob], `pasted-image-${Date.now()}.${ext}`, { type: imageItem.type });
  }

  function handleDocPaste(e, reqId, allowedTypes) {
    if (allowedTypes === 'pdf') return; // PDFs can't be pasted from clipboard
    const file = clipboardImageToFile(e.clipboardData);
    if (!file) return;
    e.preventDefault();
    setDocFiles((prev) => ({ ...prev, [reqId]: file }));
    setDocFileErrors((prev) => ({ ...prev, [reqId]: '' }));
  }

  // Global paste: routes clipboard image to the first image-accepting requirement
  // that doesn't have a file yet. Lets users press Ctrl+V anywhere on the page.
  useEffect(() => {
    function onGlobalPaste(e) {
      const reqs = docRequirementsRef.current;
      if (reqs.length === 0) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const file = clipboardImageToFile(e.clipboardData);
      if (!file) return;
      const files = docFilesRef.current;
      const target =
        reqs.find((r) => r.allowed_types !== 'pdf' && !files[r.id]) ||
        reqs.find((r) => r.allowed_types !== 'pdf');
      if (!target) return;
      e.preventDefault();
      setDocFiles((prev) => ({ ...prev, [target.id]: file }));
      setDocFileErrors((prev) => ({ ...prev, [target.id]: '' }));
    }
    document.addEventListener('paste', onGlobalPaste);
    return () => document.removeEventListener('paste', onGlobalPaste);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function validateDocFiles() {
    const errors = {};
    for (const req of docRequirements) {
      if (req.required && !docFiles[req.id]) {
        errors[req.id] = `${req.document_name} is required`;
      }
    }
    setDocFileErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function uploadDocFiles(generatedPdfId) {
    const entries = Object.entries(docFiles).filter(([, file]) => file);
    if (entries.length === 0) return;
    const formData = new FormData();
    const reqIds = [];
    for (const [reqId, file] of entries) {
      formData.append('files', file);
      reqIds.push(reqId);
    }
    for (const id of reqIds) {
      formData.append('requirement_ids', id);
    }
    await apiRequest(`/generated-pdfs/${generatedPdfId}/attachments`, {
      method: 'POST',
      token,
      formData
    });
  }

  async function toggleRowAttachments(itemId) {
    if (attachmentRowId === itemId) {
      setAttachmentRowId('');
      setRowAttachments([]);
      return;
    }
    try {
      const data = await apiRequest(`/generated-pdfs/${itemId}/attachments`, { token });
      setRowAttachments(data);
      setAttachmentRowId(itemId);
    } catch (err) {
      setMessage(err.message);
    }
  }

  // item 7: fill from last generated
  function fillFromLast() {
    const last = generated[0];
    if (!last) { setMessage('No previous PDF to duplicate from.'); return; }
    setFormValues(buildFieldValues(fields, normalizeSubmittedData(last.submitted_data)));
    setMessage('Form filled from your last PDF. Review and generate.');
  }

  function focusUserSection(sectionId) {
    setActiveView(sectionId === 'analytics' || sectionId === 'preview' ? 'analytics' : 'create');
    setActiveUserSection(sectionId);
    const node = document.getElementById(`user-section-${sectionId}`);
    if (node) {
      node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  return (
    <div className="layout user-shell">
      <ProfileSidebar
        open={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
        token={token}
        user={user}
        onUserUpdated={onSessionUserUpdate}
        theme={theme}
        onToggleTheme={onToggleTheme}
        onLogout={onLogout}
      />

      <aside className="user-sidebar">
        <div className="user-sidebar-brand">
          <img
            className="user-brand-logo"
            src="/imperial-network-logo.svg"
            alt="Imperial Network Incorporated"
          />
          <span className="user-brand-caption">User portal</span>
        </div>

        <nav className="user-nav user-nav--main">
          {userViews.map((item) => (
            <button
              key={item.id}
              type="button"
              className={activeView === item.id ? 'user-nav-btn active' : 'user-nav-btn'}
              aria-current={activeView === item.id ? 'page' : undefined}
              onClick={() => setActiveView(item.id)}
            >
              <span className={`user-nav-chip user-nav-chip--${item.id}`}>{item.chip}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="user-sidebar-spacer" />
      </aside>

      <main className="user-main">
        <header className={`topbar user-main-topbar${activeView === 'tools' ? ' user-main-topbar--compact' : ''}`}>
          <div>
            <div className="user-breadcrumb">
              <span>User portal</span>
              <span>/</span>
              <strong>{activeViewMeta.label}</strong>
              {!['tools', 'profiling'].includes(activeView) && selectedTemplate && (
                <>
                  <span>/</span>
                  <span>{selectedTemplate.title}</span>
                </>
              )}
            </div>
            {activeView !== 'tools' && (
              <>
                <h2>{activeViewMeta.title}</h2>
                <p className="muted user-main-subtitle">{activeViewMeta.description}</p>
              </>
            )}
          </div>
          <button
            type="button"
            className="avatar-trigger user-main-settings"
            onClick={() => setIsSidebarOpen(true)}
            title="Open settings"
          >
            <img className="avatar avatar-md" src={resolveAvatar(user)} alt={user.name} />
          </button>
        </header>

      {message && (
        <div className={`notice ${messageTone(message)}`} role="status" aria-live="polite">
          <div className="notice-title">{messageTone(message) === 'is-error' ? 'Attention needed' : 'Update'}</div>
          <div>{message}</div>
        </div>
      )}

      {activeView === 'tools' && (
        <section className="tools-page">
          <BillingTools token={token} />
        </section>
      )}

      {activeView === 'profiling' && (
        <section className="tools-page">
          <Profiling token={token} user={user} mode="user" />
        </section>
      )}

      {activeView === 'create' && (<>
      <section className="tpl-row-card ui-plain">
        <div className="tpl-row-head">
          <h3>Templates</h3>
          <span className="tpl-row-count">{orderedTemplates.length}</span>
        </div>
        <div className="tpl-row" role="list" aria-label="Templates">
          {orderedTemplates.map((tpl) => (
            <article
              key={tpl.id}
              role="listitem"
              className={tpl.id === selectedTemplateId ? 'tpl-card active' : 'tpl-card'}
            >
              <button
                type="button"
                className="tpl-card-select"
                onClick={() => setSelectedTemplateId(tpl.id)}
                title={`${tpl.title}${tpl.description ? ` - ${tpl.description}` : ''}`}
              >
                <span className="tpl-card-title">{tpl.title}</span>
                <span className="tpl-card-desc">{tpl.description || 'No description.'}</span>
              </button>
              <button
                type="button"
                className={user?.favorite_template_id === tpl.id ? 'tpl-card-pin active' : 'tpl-card-pin'}
                onClick={() => setFavoriteTemplate(tpl.id)}
                disabled={user?.favorite_template_id === tpl.id}
              >
                {user?.favorite_template_id === tpl.id ? 'Pinned' : 'Pin'}
              </button>
            </article>
          ))}
          {templates.length === 0 && <div className="tpl-empty">No templates available.</div>}
        </div>
      </section>

      <details className="tpl-extras ui-plain">
        <summary>
          <span className="tpl-extras-title">Template extras</span>
          <small>
            {selectedTemplate ? selectedTemplate.title : 'No template selected'}
            {' · '}
            {predefinedPdfs.length} predefined PDF{predefinedPdfs.length === 1 ? '' : 's'}
            {' · export CSV / JSON'}
          </small>
        </summary>
        <div className="tpl-extras-body">
          <div className="tpl-extras-group">
            <span className="tpl-extras-label">Predefined PDFs</span>
            {predefinedPdfs.length > 0 ? (
              <div className="tpl-extras-chips">
                {predefinedPdfs.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="tpl-extras-chip"
                    disabled={openingPdfId === item.id}
                    onClick={() => openPredefinedPdf(item)}
                  >
                    {openingPdfId === item.id ? 'Opening…' : item.name}
                  </button>
                ))}
              </div>
            ) : (
              <p className="muted tpl-extras-empty">None available.</p>
            )}
          </div>
          <div className="tpl-extras-group">
            <span className="tpl-extras-label">Export this template</span>
            <div className="tpl-extras-chips">
              <button type="button" className="tpl-extras-chip" onClick={() => exportMyTemplateData('csv', exportOnlyMine)} disabled={!selectedTemplateId}>CSV</button>
              <button type="button" className="tpl-extras-chip" onClick={() => exportMyTemplateData('json', exportOnlyMine)} disabled={!selectedTemplateId}>JSON</button>
            </div>
            <label className="tpl-extras-toggle">
              <input
                type="checkbox"
                checked={exportOnlyMine}
                onChange={(e) => setExportOnlyMine(e.target.checked)}
              />
              Only records I created
            </label>
          </div>
        </div>
      </details>

      <div className="user-work-grid">
        <form className="card user-form-card" onSubmit={submitGeneration}>
          <div className="section-heading">
            <div>
              <h3>Fill Form Fields</h3>
              <p className="muted">Complete the mapped fields and generate the PDF in one step.</p>
            </div>
            {fields.length > 0 && (
              <div className="actions">
                <button
                  type="button"
                  disabled={generated.length === 0}
                  title="Prefill form with your most recent PDF values"
                  onClick={fillFromLast}
                >
                  Fill from Last
                </button>
              </div>
            )}
          </div>

          {fields.map((field) => renderFormField(field, formValues, setFormValues, 'main'))}
          {fields.length === 0 && <p className="muted">No mapped fields for this template yet.</p>}

          {docRequirements.length > 0 && (
            <div className="doc-checklist">
              <h4 className="doc-checklist-title">Supporting Documents</h4>
              <p className="muted doc-checklist-desc">
                Upload a PDF or image for each item — or <strong>paste a copied screenshot</strong> directly (Ctrl+V / ⌘V).
              </p>
              {docRequirements.map((req) => {
                const file = docFiles[req.id];
                const canPaste = req.allowed_types !== 'pdf';
                const typeLabel = req.allowed_types === 'image_or_pdf' ? 'image or PDF'
                  : req.allowed_types === 'image' ? 'image' : 'PDF';
                return (
                  <div key={req.id} className={`doc-checklist-item${docFileErrors[req.id] ? ' doc-checklist-item--error' : ''}`}>
                    <div className="doc-checklist-label">
                      <span>{req.document_name}</span>
                      <span className={`doc-checklist-badge${req.required ? '' : ' doc-checklist-badge--optional'}`}>
                        {req.required ? 'Required' : 'Optional'}
                      </span>
                      <span className="doc-checklist-type-hint">
                        {req.allowed_types === 'image_or_pdf' ? 'Image or PDF' : req.allowed_types === 'image' ? 'Image' : 'PDF'}
                      </span>
                    </div>

                    {file ? (
                      <div className="doc-preview-row">
                        <DocFilePreview file={file} />
                        <div className="doc-preview-meta">
                          <span className="doc-checklist-selected">{file.name}</span>
                          <button
                            type="button"
                            className="doc-remove-btn"
                            onClick={() => {
                              setDocFiles((prev) => { const n = { ...prev }; delete n[req.id]; return n; });
                              setDocFileErrors((prev) => ({ ...prev, [req.id]: '' }));
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ) : (
                      <label
                        className={`doc-dropzone${canPaste ? ' doc-dropzone--pasteable' : ''}`}
                        onPaste={(e) => handleDocPaste(e, req.id, req.allowed_types)}
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') e.currentTarget.querySelector('input')?.click();
                        }}
                      >
                        <input
                          type="file"
                          accept={getAcceptAttr(req.allowed_types)}
                          style={{ display: 'none' }}
                          onChange={(e) => {
                            const f = e.target.files?.[0] || null;
                            if (f) {
                              setDocFiles((prev) => ({ ...prev, [req.id]: f }));
                              setDocFileErrors((prev) => ({ ...prev, [req.id]: '' }));
                            }
                            e.target.value = '';
                          }}
                        />
                        <span className="doc-dropzone-icon">📎</span>
                        <span className="doc-dropzone-text">
                          Click to upload {typeLabel}
                          {canPaste && <> &middot; or <strong>paste</strong> a copied image</>}
                        </span>
                      </label>
                    )}

                    {docFileErrors[req.id] && (
                      <span className="field-error">{docFileErrors[req.id]}</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="actions" style={{ alignItems: 'center' }}>
            <button disabled={loading || fields.length === 0}>
              {loading ? 'Generating...' : 'Generate PDF'}
            </button>
            <label className="checkbox-line" style={{ marginTop: 0 }}>
              <input
                type="checkbox"
                checked={keepValues}
                onChange={(e) => {
                  setKeepValues(e.target.checked);
                  window.localStorage.setItem('user-panel:keep-values', String(e.target.checked));
                }}
              />
              Keep values after generate
            </label>
          </div>
        </form>

      <section id="user-section-history" className="card">
        <div className="actions" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h3>My Generated PDFs</h3>
          <button
            ref={manualAddTriggerRef}
            type="button"
            onClick={() => {
              setManualAddValues(buildFieldValues(fields, formValues));
              setShowManualAddModal(true);
            }}
            disabled={!selectedTemplateId || fields.length === 0}
          >
            Manual Add PDF
          </button>
        </div>

        <div className="filter-bar">
          <div className="filter-bar-inputs">
            <div>
              <label htmlFor="user-filter-keyword">Search</label>
              <input
                id="user-filter-keyword"
                name="keyword"
                value={draftFilters.keyword}
                onChange={(e) => setDraftFilters((prev) => ({ ...prev, keyword: e.target.value }))}
                placeholder="Search data/notes…"
              />
            </div>
            <div>
              <label htmlFor="user-filter-date-from">From</label>
              <input
                id="user-filter-date-from"
                name="date_from"
                type="date"
                value={draftFilters.date_from}
                onChange={(e) => setDraftFilters((prev) => ({ ...prev, date_from: e.target.value }))}
              />
            </div>
            <div>
              <label htmlFor="user-filter-date-to">To</label>
              <input
                id="user-filter-date-to"
                name="date_to"
                type="date"
                value={draftFilters.date_to}
                onChange={(e) => setDraftFilters((prev) => ({ ...prev, date_to: e.target.value }))}
              />
            </div>
          </div>
          <div className="filter-bar-actions">
            <button type="button" className="btn-primary" onClick={applyFilters}>Apply</button>
            <button type="button" onClick={clearFilters}>Clear</button>
          </div>
        </div>
        <div className="tabs">
          {statusTabs.map((tab) => (
            <button
              key={tab}
              type="button"
              className={tab === activeStatus ? 'tab active' : 'tab'}
              aria-pressed={tab === activeStatus}
              onClick={() => setActiveStatus(tab)}
            >
              {tab}
            </button>
          ))}
        </div>
        {(
          <div className="pagination-stack">
            <div className="actions" style={{ alignItems: 'center', marginBottom: '8px' }}>
              <label htmlFor="user-list-rows" style={{ marginTop: 0 }}>Rows</label>
              <select
                id="user-list-rows"
                name="list_page_size"
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
              <span className="pager-range">{rowRangeLabel}</span>
            </div>
            {pendingPageSize !== 'all' && (
              <div className="pager-shell">
                <button type="button" className="pager-nav" aria-label="Previous page" onClick={() => setPendingPage((p) => Math.max(1, p - 1))} disabled={pendingPage <= 1}>
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
                          aria-label={`Page ${item}`}
                          aria-current={Number(item) === pendingPage ? 'page' : undefined}
                          onClick={() => setPendingPage(Number(item))}
                        >
                          {item}
                        </button>
                      )
                  ))}
                </div>
                <button type="button" className="pager-nav" aria-label="Next page" onClick={() => setPendingPage((p) => Math.min(pendingTotalPages, p + 1))} disabled={pendingPage >= pendingTotalPages}>
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
                  <th scope="col" key={`head-${index}-${column}`}>{column}</th>
                ))}
                <th scope="col">Created</th>
                <th scope="col">Note</th>
                <th scope="col">Reschedule Date</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {visibleGenerated.map((item) => {
                const isEditing = rowEdit?.id === item.id;
                return (
                  <React.Fragment key={item.id}>
                  <tr className={isEditing ? 'row-editing' : ''}>
                    {listColumns.map((column, index) => (
                      <td key={`${item.id}-${index}-${column}`}>{pickFieldValue(item.submitted_data, column)}</td>
                    ))}
                    <td>{new Date(item.created_at).toLocaleString()}</td>
                    <td>
                      {isEditing ? (
                        <input
                          autoFocus
                          id={`user-note-${item.id}`}
                          name={`status_note_${item.id}`}
                          aria-label={`Note for record ${item.id.slice(0, 8)}`}
                          value={rowEdit.note}
                          onChange={(e) => setRowEdit((prev) => ({ ...prev, note: e.target.value }))}
                          onKeyDown={(e) => { if (e.key === 'Enter') saveRowEdit(item); if (e.key === 'Escape') cancelRowEdit(); }}
                          placeholder="Add note…"
                        />
                      ) : (item.status_note || <span className="muted">—</span>)}
                    </td>
                    <td>
                      {isEditing ? (
                        <input
                          id={`user-reschedule-${item.id}`}
                          name={`reschedule_date_${item.id}`}
                          aria-label={`Reschedule date for record ${item.id.slice(0, 8)}`}
                          type="datetime-local"
                          value={rowEdit.reschedule_date}
                          onChange={(e) => setRowEdit((prev) => ({ ...prev, reschedule_date: e.target.value }))}
                          onKeyDown={(e) => { if (e.key === 'Escape') cancelRowEdit(); }}
                        />
                      ) : (item.reschedule_date ? new Date(item.reschedule_date).toLocaleString() : <span className="muted">—</span>)}
                    </td>
                    <td className="actions">
                      {isEditing ? (
                        <>
                          <button type="button" className="btn-primary" onClick={() => saveRowEdit(item)}>Save</button>
                          <button type="button" onClick={cancelRowEdit}>Cancel</button>
                        </>
                      ) : (
                        <>
                          <select
                            id={`user-status-${item.id}`}
                            name={`status_${item.id}`}
                            aria-label={`Status for record ${item.id.slice(0, 8)}`}
                            value={statusDrafts[item.id] || item.status}
                            onChange={(e) => setStatusDrafts({ ...statusDrafts, [item.id]: e.target.value })}
                          >
                            {statusTabs.map((status) => (
                              <option key={status} value={status}>{status}</option>
                            ))}
                          </select>
                          <button type="button" onClick={() => applyStatusChange(item)}>Move</button>
                          <button type="button" onClick={() => startRowEdit(item)}>Edit</button>
                          <button type="button" onClick={() => openWithTokenInNewTab(`/generated-pdfs/${item.id}/download`, token)}>Open PDF</button>
                          <button type="button" onClick={() => toggleRowAttachments(item.id)}>
                            {attachmentRowId === item.id ? 'Hide Files' : 'Files'}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                  {attachmentRowId === item.id && (
                    <tr>
                      <td colSpan={listColumns.length + 4}>
                        <div className="attachment-inline-panel">
                          {rowAttachments.length === 0 ? (
                            <span className="muted">No attachments for this record.</span>
                          ) : (
                            <ul className="attachment-list">
                              {rowAttachments.map((att) => (
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
                  </React.Fragment>
                );
              })}
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
      </>)}

      {activeView === 'analytics' && (<>
      <section id="user-section-analytics" className="card">
        <h3>Template Analytics</h3>
        <p className="muted">Current month metrics for the selected template.</p>
        {analytics ? (
          <>
            <div className="analytics-strip">
              {analyticsItems.map((item, index) => (
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
            <div className="analytics-chart-block">
              <div className="chart-combo">
                <StatusStackedBarChart
                  monthlyData={monthlyByStatus}
                  timeRange={monthlyReportRange}
                  onTimeRangeChange={setMonthlyReportRange}
                  description="Monthly PDF outcomes by status for the selected template."
                  emptyText="No monthly data available for this template yet."
                />
                <StatusDonutChart analytics={analytics} />
              </div>
            </div>
          </>
        ) : (
          <p className="muted">Select a template to view analytics.</p>
        )}
      </section>

      <section id="user-section-preview" className="card">
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
            <label htmlFor="user-preview-page">Preview Page</label>
            <input
              id="user-preview-page"
              name="preview_page"
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

      </>)}

      </main>

      {showManualAddModal && (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowManualAddModal(false)}>
          <div
            className="modal-card"
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="manual-add-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="manual-add-modal-title">Manual Add To My Generated PDFs</h3>
            <p className="muted">This creates the PDF record without opening it immediately. Use Open PDF later from the list.</p>
            <form className="sidebar-form" onSubmit={submitManualAdd}>
              {fields.map((field) => renderFormField(field, manualAddValues, setManualAddValues, 'manual'))}
              {fields.length === 0 && <p className="muted">No mapped fields for this template yet.</p>}
              <div className="actions">
                <button type="submit" disabled={loading || fields.length === 0}>
                  {loading ? 'Adding...' : 'Add To List'}
                </button>
                <button type="button" className="sidebar-close" onClick={() => setShowManualAddModal(false)}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {showBackTop && (
        <button
          type="button"
          className="back-to-top"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          aria-label="Back to top"
        >
          ↑
        </button>
      )}
    </div>
  );
}
