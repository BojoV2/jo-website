import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest, downloadWithToken, openWithTokenInNewTab } from '../api.js';

// Field Eng: every Application Form / Job Order becomes a job the FE office
// assigns to a team and records visit results against. Visible to everyone.

const TYPE_LABEL = { INSTALL: 'Install', REPAIR: 'Repair', PULLOUT: 'Pull out', RELOC: 'Relocation' };
const DONE_LABEL = { INSTALL: 'Installed', REPAIR: 'Repaired', PULLOUT: 'Nakuha ang Modem' };
const CLOSED = ['Installed', 'Repaired', 'Nakuha ang Modem', 'Cancelled', 'Not Installed', 'Unresolved', 'Unverified'];
const GOOD = ['Installed', 'Repaired', 'Nakuha ang Modem'];
const BAD = ['Cancelled', 'Not Installed', 'Unresolved', 'Hindi Nakuha ang Modem'];
const MATERIALS = [['drop_core_m', 'Drop core (m)'], ['f_clamp', 'F-clamp'], ['house_clamp', 'House clamp'], ['sc_connector', 'SC connector'], ['onu', 'ONU']];
const EMPTY_FILTERS = { view: 'today', type: '', area: '', team: '', q: '' };

const effType = (job) => (job.job_type === 'RELOC' ? (job.reloc_kind === 'install' ? 'INSTALL' : 'REPAIR') : job.job_type);
const statusKind = (type) => (type === 'INSTALL' ? 'install' : type === 'PULLOUT' ? 'pullout' : 'repair');
const statusClass = (s) => (GOOD.includes(s) ? 'fe-pill fe-ok' : BAD.includes(s) ? 'fe-pill fe-bad' : s === 'Pending' || s === 'Unverified' ? 'fe-pill fe-muted' : 'fe-pill fe-warn');
const ageClass = (d) => (d >= 3 ? 'fe-pill fe-bad' : d >= 1 ? 'fe-pill fe-warn' : 'fe-pill fe-ok');
const manilaToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
const minutes = (a, b) => {
  if (!a || !b) return null;
  const [h1, m1] = a.split(':').map(Number);
  const [h2, m2] = b.split(':').map(Number);
  let d = h2 * 60 + m2 - (h1 * 60 + m1);
  if (d < 0) d += 1440;
  return d;
};
const fmtDuration = (m) => (m == null ? '—' : `${Math.floor(m / 60)}h ${m % 60}m`);
function slaFor(form, hours) {
  if (form.status !== 'Installed') return 'EXEMPTED';
  const m = minutes(form.start_time, form.end_time);
  if (m == null || !form.difficulty) return 'PENDING TIME';
  return m <= (hours[form.difficulty] || 999) * 60 ? 'PASS' : 'DELAY';
}
const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
// What the office did with the JO itself (Field Eng never changes it).
const joNote = (job) => (job.jo_status === 'cancelled' ? 'JO cancelled'
  : job.jo_status === 'rescheduled' ? `JO rescheduled${job.jo_reschedule_date ? ` to ${job.jo_reschedule_date}` : ''}`
    : job.jo_status === 'done' ? 'JO marked done' : null);
// A saved value that was later retired from its list still shows on old records.
const withCurrent = (list, value) => (value && !(list || []).includes(value) ? [...(list || []), value] : list || []);

function blankVisit(job) {
  return {
    id: null, visit_date: manilaToday(), team_id: job?.team_id ?? '', status: '', reason: '', problem: '',
    difficulty: '', start_time: '', end_time: '', drop_core_m: '', f_clamp: '', house_clamp: '', sc_connector: '', onu: '',
    modem_serial: '', remarks: ''
  };
}

function TeamSelect({ teams, value, onChange, id, className, includeBlank = true }) {
  const active = teams.filter((t) => t.active);
  const current = teams.find((t) => t.id === value);
  const list = current && !current.active ? [...active, current] : active;
  return (
    <select id={id} className={className} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}>
      {includeBlank && <option value="">Unassigned</option>}
      {list.map((t) => <option key={t.id} value={t.id}>{t.name}{t.active ? '' : ' (retired)'}</option>)}
    </select>
  );
}

export default function FieldEngineering({ token }) {
  const [tab, setTab] = useState('board');
  const [meta, setMeta] = useState({ teams: [], lists: {}, targets: {}, slaHours: {} });
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [board, setBoard] = useState({ jobs: [], counts: {} });
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState(null);
  const [openJobId, setOpenJobId] = useState(null);
  const [today, setToday] = useState(null);
  const [period, setPeriod] = useState({ period: 'week', from: '', to: '' });
  const [reports, setReports] = useState(null);
  const noticeTimer = useRef(null);

  const say = useCallback((text, tone = 'ok', action = null) => {
    setNotice({ text, tone, action });
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), action ? 10000 : 4000);
  }, []);

  const loadMeta = useCallback(async () => {
    try { setMeta(await apiRequest('/field-eng/meta', { token })); } catch (err) { say(err.message, 'error'); }
  }, [token, say]);

  const loadBoard = useCallback(async ({ quiet } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const p = new URLSearchParams();
      Object.entries(filters).forEach(([k, v]) => { if (v) p.set(k, v); });
      setBoard(await apiRequest(`/field-eng/jobs?${p.toString()}`, { token }));
    } catch (err) {
      say(err.message, 'error');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [filters, token, say]);

  const loadToday = useCallback(async () => {
    try { setToday(await apiRequest('/field-eng/today', { token })); } catch (err) { say(err.message, 'error'); }
  }, [token, say]);

  const reportQuery = useMemo(() => {
    const p = new URLSearchParams({ period: period.period });
    if (period.period === 'range') { p.set('from', period.from); p.set('to', period.to); }
    return p.toString();
  }, [period]);

  const loadReports = useCallback(async () => {
    if (period.period === 'range' && (!period.from || !period.to)) return;
    try { setReports(await apiRequest(`/field-eng/reports?${reportQuery}`, { token })); } catch (err) { say(err.message, 'error'); }
  }, [period, reportQuery, token, say]);

  useEffect(() => { loadMeta(); }, [loadMeta]);
  useEffect(() => {
    const t = window.setTimeout(() => loadBoard(), filters.q ? 300 : 0);
    return () => window.clearTimeout(t);
  }, [loadBoard, filters.q]);
  useEffect(() => { if (tab === 'today') loadToday(); }, [tab, loadToday]);
  useEffect(() => { if (tab === 'reports') loadReports(); }, [tab, loadReports]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden || openJobId) return;
      if (tab === 'board') loadBoard({ quiet: true });
      if (tab === 'today') loadToday();
    }, 30000);
    return () => window.clearInterval(timer);
  }, [tab, openJobId, loadBoard, loadToday]);

  const assign = async (job, teamId) => {
    try {
      await apiRequest(`/field-eng/jobs/${job.id}`, { method: 'PATCH', token, body: { team_id: teamId } });
      const name = meta.teams.find((t) => t.id === teamId)?.name;
      say(name ? `${job.customer_name || 'Job'} assigned to ${name}` : `${job.customer_name || 'Job'} unassigned`);
      loadBoard({ quiet: true });
    } catch (err) {
      say(err.message, 'error');
    }
  };

  const quickAction = async (job, kind, extra = {}) => {
    try {
      const r = await apiRequest(`/field-eng/jobs/${job.id}/${kind}`, { method: 'POST', token, body: extra });
      loadBoard({ quiet: true });
      const what = kind === 'reschedule' ? `rescheduled to ${r.rescheduleDate}` : kind === 'cancel' ? 'cancelled' : `marked ${r.status}`;
      say(`${job.customer_name || 'Job'} ${what}`, 'ok', {
        label: 'Undo',
        run: async () => {
          try {
            await apiRequest(`/field-eng/visits/${r.visitId}`, { method: 'DELETE', token });
            say(`${job.customer_name || 'Job'} is open again`);
            loadBoard({ quiet: true });
          } catch (err) {
            say(err.message, 'error');
          }
        }
      });
      return true;
    } catch (err) {
      if (err.message.includes('relocation')) setOpenJobId(job.id);
      say(err.message, 'error');
      return false;
    }
  };

  const setFilter = (key, value) => setFilters((f) => ({ ...f, [key]: value }));
  const kpis = [
    { label: 'Generated today', value: board.counts.generated_today, apply: { ...EMPTY_FILTERS } },
    { label: 'Open jobs', value: board.counts.open, apply: { ...EMPTY_FILTERS, view: 'open' } },
    { label: 'Unassigned', value: board.counts.unassigned, tone: 'bad', apply: { ...EMPTY_FILTERS, view: 'open', team: 'none' } },
    { label: '3+ days old', value: board.counts.overdue, tone: 'warn', apply: { ...EMPTY_FILTERS, view: 'open', minAge: '3' } },
    { label: 'Closed today', value: board.counts.closed_today, tone: 'ok', apply: { ...EMPTY_FILTERS, view: 'closed_today' } }
  ];

  return (
    <div className="fe">
      <div className="fe-tabs" role="tablist" aria-label="Field Eng sections">
        {[['board', 'Board'], ['today', 'Today'], ['reports', 'Reports'], ['teams', 'Teams'], ['lists', 'Lists']].map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'fe-tab is-on' : 'fe-tab'} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {notice && (
        <div className={`fe-notice ${notice.tone === 'error' ? 'is-error' : ''}`} role="status">
          {notice.text}
          {notice.action && <button type="button" className="fe-link fe-notice-action" onClick={() => { setNotice(null); notice.action.run(); }}>{notice.action.label}</button>}
        </div>
      )}

      {tab === 'board' && (
        <section className="fe-section">
          <div className="fe-kpis">
            {kpis.map((k) => (
              <button key={k.label} type="button" className={`fe-card fe-kpi ${k.tone ? `fe-kpi--${k.tone}` : ''}`} onClick={() => setFilters(k.apply)}>
                <span className="fe-kpi-n">{k.value ?? '—'}</span>
                <span className="fe-kpi-l">{k.label}</span>
              </button>
            ))}
          </div>
          {board.counts.board_start && (
            <p className="fe-sub fe-board-start">
              Open, unassigned and 3+ days old count jobs generated since {board.counts.board_start}.
              {board.counts.backlog > 0 && (
                <> {' '}<button type="button" className="fe-link" onClick={() => setFilters({ ...EMPTY_FILTERS, view: 'backlog' })}>
                  {board.counts.backlog.toLocaleString()} older open jobs
                </button> are kept under Old backlog.</>
              )}
            </p>
          )}

          <div className="fe-card">
            <div className="fe-filters">
              <select aria-label="Which jobs" value={filters.view} onChange={(e) => setFilter('view', e.target.value)}>
                <option value="today">Generated today</option>
                <option value="open">Open jobs</option>
                <option value="closed_today">Closed today</option>
                <option value="closed">Closed / unverified</option>
                <option value="backlog">Old backlog (before the fresh start)</option>
                <option value="all">Everything</option>
              </select>
              <select aria-label="Type" value={filters.type} onChange={(e) => setFilter('type', e.target.value)}>
                <option value="">All types</option>
                {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <select aria-label="Area" value={filters.area} onChange={(e) => setFilter('area', e.target.value)}>
                <option value="">All areas</option>
                {(meta.lists.area || []).map((a) => <option key={a}>{a}</option>)}
              </select>
              <select aria-label="Team" value={filters.team} onChange={(e) => setFilter('team', e.target.value)}>
                <option value="">All teams</option>
                <option value="none">Unassigned</option>
                {meta.teams.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <input className="fe-search" type="search" placeholder="Search name, account #, order #, address" value={filters.q} onChange={(e) => setFilter('q', e.target.value)} aria-label="Search" />
              {filters.minAge && <button type="button" className="fe-chipbtn" onClick={() => setFilter('minAge', '')}>3+ days old ×</button>}
            </div>
            <div className="fe-table-wrap">
              <table className="fe-table">
                <thead>
                  <tr><th>Age</th><th>Type</th><th>Order #</th><th>Customer</th><th>Area</th><th>Team</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {board.jobs.map((job) => (
                    <tr key={job.id} className="fe-row" onClick={() => setOpenJobId(job.id)}>
                      <td><span className={ageClass(job.age_days)}>{job.age_days}d</span></td>
                      <td>
                        <span className={`fe-pill fe-type-${job.job_type}`}>{TYPE_LABEL[job.job_type]}{job.job_type === 'RELOC' && job.reloc_kind ? ` · ${job.reloc_kind}` : ''}</span>
                      </td>
                      <td className="fe-mono">{job.order_number || '—'}</td>
                      <td>
                        <div className="fe-name">{job.customer_name || '—'}</div>
                        <div className="fe-sub">{[job.account_number && `Acct ${job.account_number}`, job.jo_reason || job.plan, job.template_title].filter(Boolean).join(' · ')}</div>
                      </td>
                      <td>{job.area || '—'}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <TeamSelect teams={meta.teams} value={job.team_id} className={job.team_id ? 'fe-inline' : 'fe-inline is-empty'} onChange={(id) => assign(job, id)} />
                      </td>
                      <td>
                        <span className={statusClass(job.status)}>{job.status}</span>
                        {!CLOSED.includes(job.status) && !job.history_only && <RowActions job={job} meta={meta} onQuick={quickAction} />}
                        {job.status === 'Reschedule' && job.reschedule_to && <div className="fe-sub fe-jo-note">to {job.reschedule_to}</div>}
                        {job.visit_count > 0 && <div className="fe-sub">{job.visit_count} visit{job.visit_count > 1 ? 's' : ''} · last {job.last_visit_date}</div>}
                        {joNote(job) && <div className={job.jo_status === 'cancelled' ? 'fe-sub fe-jo-note is-bad' : 'fe-sub fe-jo-note'}>{joNote(job)}</div>}
                      </td>
                    </tr>
                  ))}
                  {!board.jobs.length && (
                    <tr><td colSpan={7} className="fe-empty">{loading ? 'Loading…' : filters.view === 'today' && !filters.q ? 'No Application Form or Job Order generated today yet.' : filters.view === 'open' && !filters.q ? 'No open job. Every new Application Form and Job Order lands here.' : 'No jobs match these filters.'}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {tab === 'today' && <TodayView data={today} />}

      {tab === 'reports' && (
        <ReportsView
          data={reports} period={period} setPeriod={setPeriod}
          onExport={async () => {
            try { await downloadWithToken(`/field-eng/export?${reportQuery}`, token); } catch (err) { say(err.message, 'error'); }
          }}
        />
      )}

      {tab === 'lists' && <ListsView token={token} setMeta={setMeta} say={say} onChanged={() => loadBoard({ quiet: true })} />}
      {tab === 'teams' && <TeamsView token={token} meta={meta} setMeta={setMeta} say={say} onChanged={() => loadBoard({ quiet: true })} />}

      {openJobId && (
        <JobPanel
          jobId={openJobId} token={token} meta={meta} say={say}
          onClose={() => { setOpenJobId(null); loadBoard({ quiet: true }); }}
        />
      )}
    </div>
  );
}

// Small form behind Cancel / Reschedule: an optional reason from the job's
// reason list, and for a reschedule the new date (today or later).
function QuickForm({ job, meta, mode, busy, onSubmit, onClose }) {
  const [reason, setReason] = useState('');
  const [date, setDate] = useState('');
  const reasons = meta.lists[`${statusKind(effType(job))}_reason`] || [];
  const today = manilaToday();
  return (
    <form
      className="fe-quick" onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => { e.preventDefault(); onSubmit({ reason: reason || null, reschedule_date: mode === 'reschedule' ? date : undefined }); }}
    >
      <span className="fe-label">{mode === 'cancel' ? 'Cancel this job' : 'Reschedule this job'}</span>
      {mode === 'reschedule' && (
        <label className="fe-field"><span>New date</span>
          <input type="date" required min={today} value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      )}
      <label className="fe-field"><span>Reason</span>
        <select value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="">—</option>
          {reasons.map((r) => <option key={r}>{r}</option>)}
        </select>
      </label>
      <div className="fe-quick-actions">
        <button type="submit" className={mode === 'cancel' ? 'fe-btn fe-btn--danger' : 'fe-btn fe-btn--primary'} disabled={busy || (mode === 'reschedule' && !date)}>
          {mode === 'cancel' ? 'Cancel job' : 'Reschedule'}
        </button>
        <button type="button" className="fe-link" onClick={onClose}>Back</button>
      </div>
    </form>
  );
}

// Done / Cancel / Reschedule for a board row: Done is one click, the other
// two open the QuickForm in a small popover.
function RowActions({ job, meta, onQuick }) {
  const [mode, setMode] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pos, setPos] = useState(null);
  const moreRef = useRef(null);
  // The table scrolls inside its own box, so the popover is placed against the
  // viewport (fixed) from the ⋯ button, opening upward when there is no room.
  const place = useCallback(() => {
    const r = moreRef.current?.getBoundingClientRect();
    if (!r) return;
    const right = Math.max(8, window.innerWidth - r.right);
    setPos(window.innerHeight - r.bottom < 300 ? { right, bottom: window.innerHeight - r.top + 6 } : { right, top: r.bottom + 6 });
  }, []);
  useEffect(() => {
    if (!mode) return undefined;
    place();
    const close = () => setMode(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [mode, place]);
  const run = async (kind, extra) => {
    setBusy(true);
    const ok = await onQuick(job, kind, extra);
    setBusy(false);
    if (ok) setMode(null);
  };
  return (
    <span className="fe-row-actions" onClick={(e) => e.stopPropagation()}>
      <button type="button" className="fe-done-btn" disabled={busy} aria-label={`Mark ${job.customer_name || 'job'} done`}
        title={`Record a visit today as ${DONE_LABEL[effType(job)] || 'done'}`} onClick={() => run('done', {})}>✓ Done</button>
      <button ref={moreRef} type="button" className="fe-more-btn" aria-label={`More actions for ${job.customer_name || 'job'}`} aria-expanded={Boolean(mode)}
        onClick={() => setMode((m) => (m ? null : 'menu'))}>⋯</button>
      {mode === 'menu' && (
        <span className="fe-popover fe-menu" role="menu" style={pos || undefined}>
          <button type="button" role="menuitem" onClick={() => setMode('reschedule')}>Reschedule…</button>
          <button type="button" role="menuitem" className="is-bad" onClick={() => setMode('cancel')}>Cancel…</button>
        </span>
      )}
      {(mode === 'cancel' || mode === 'reschedule') && (
        <span className="fe-popover" style={pos || undefined}>
          <QuickForm job={job} meta={meta} mode={mode} busy={busy} onClose={() => setMode(null)} onSubmit={(extra) => run(mode, extra)} />
        </span>
      )}
    </span>
  );
}

function JobPanel({ jobId, token, meta, say, onClose }) {
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [quickMode, setQuickMode] = useState(null);
  const closeRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const d = await apiRequest(`/field-eng/jobs/${jobId}`, { token });
      setDetail(d);
      setForm(blankVisit(d.job));
    } catch (err) {
      setError(err.message);
    }
  }, [jobId, token]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const job = detail?.job;
  const type = job ? effType(job) : null;
  const kind = type ? statusKind(type) : 'repair';
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const quick = async (kind, extra = {}) => {
    setSaving(true);
    setError('');
    try {
      const r = await apiRequest(`/field-eng/jobs/${job.id}/${kind}`, { method: 'POST', token, body: extra });
      setDetail(r);
      setForm(blankVisit(r.job));
      setQuickMode(null);
      say(`${job.customer_name || 'Job'} ${kind === 'reschedule' ? `rescheduled to ${r.rescheduleDate}` : kind === 'cancel' ? 'cancelled' : `marked ${r.status}`}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };
  const removeVisit = async (visit) => {
    setError('');
    try {
      const d = await apiRequest(`/field-eng/visits/${visit.id}`, { method: 'DELETE', token });
      setDetail(d);
      say(`Visit on ${visit.visit_date} removed`);
    } catch (err) {
      setError(err.message);
    }
  };

  const setRelocKind = async (value) => {
    try {
      const d = await apiRequest(`/field-eng/jobs/${job.id}`, { method: 'PATCH', token, body: { reloc_kind: value } });
      setDetail(d);
      setForm((f) => ({ ...f, status: '', reason: '' }));
    } catch (err) { setError(err.message); }
  };
  const setArea = async (value) => {
    try {
      setDetail(await apiRequest(`/field-eng/jobs/${job.id}`, { method: 'PATCH', token, body: { area: value } }));
    } catch (err) { setError(err.message); }
  };

  const editVisit = (v) => {
    setError('');
    setForm({
      ...blankVisit(job), ...Object.fromEntries(Object.entries(v).map(([k, val]) => [k, val ?? ''])),
      team_id: v.team_id ?? ''
    });
  };

  const save = async (e) => {
    e.preventDefault();
    setError('');
    if (job.job_type === 'RELOC' && !job.reloc_kind) { setError('Choose whether this relocation is install-type or repair-type first.'); return; }
    if (!form.status) { setError('Pick a status.'); return; }
    setSaving(true);
    const body = { ...form, team_id: form.team_id === '' ? null : Number(form.team_id) };
    delete body.id; delete body.team_name; delete body.sla; delete body.source;
    try {
      const d = form.id
        ? await apiRequest(`/field-eng/visits/${form.id}`, { method: 'PATCH', token, body })
        : await apiRequest(`/field-eng/jobs/${job.id}/visits`, { method: 'POST', token, body });
      setDetail(d);
      setForm(blankVisit(d.job));
      say(form.id ? 'Visit updated' : `Saved: ${d.job.customer_name || 'job'} is now ${d.job.status}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const rows = job ? [
    ['Template', job.template_title],
    [job.job_type === 'INSTALL' ? 'Application #' : 'Order #', job.order_number],
    ['Account', job.account_number],
    ['Name', job.customer_name],
    ['Address', job.customer_address],
    ['Contact', job.customer_contact],
    ['Plan', job.plan],
    ['JO reason', job.jo_reason],
    ['JO date', job.jo_date],
    ['JO status', job.jo_status ? `${job.jo_status}${job.jo_reschedule_date ? ` (to ${job.jo_reschedule_date})` : ''}${job.jo_cancelled ? ' · closed here because the JO was cancelled' : ''}` : null]
  ].filter(([, v]) => v) : [];
  const duration = form ? minutes(form.start_time, form.end_time) : null;

  return (
    <div className="fe-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="fe-drawer" role="dialog" aria-modal="true" aria-label="Field job">
        <div className="fe-drawer-head">
          {job && <span className={`fe-pill fe-type-${job.job_type}`}>{TYPE_LABEL[job.job_type]}</span>}
          <h3>{job?.customer_name || 'Loading…'} {job?.order_number && <span className="fe-mono fe-sub">{job.order_number}</span>}</h3>
          {job && <span className={statusClass(job.status)}>{job.status}</span>}
          {job && !CLOSED.includes(job.status) && !job.history_only && (job.job_type !== 'RELOC' || job.reloc_kind) && (
            <>
              <button type="button" className="fe-btn fe-btn--primary" disabled={saving} onClick={() => quick('done')}>Mark done · {DONE_LABEL[type]}</button>
              <button type="button" className="fe-btn fe-btn--ghost" disabled={saving} aria-expanded={quickMode === 'reschedule'} onClick={() => setQuickMode((m) => (m === 'reschedule' ? null : 'reschedule'))}>Reschedule</button>
              <button type="button" className="fe-btn fe-btn--ghost fe-btn--bad" disabled={saving} aria-expanded={quickMode === 'cancel'} onClick={() => setQuickMode((m) => (m === 'cancel' ? null : 'cancel'))}>Cancel job</button>
            </>
          )}
          <button ref={closeRef} type="button" className="fe-btn fe-btn--ghost" onClick={onClose}>Close</button>
        </div>
        {job && quickMode && (
          <div className="fe-quick-panel">
            <QuickForm key={quickMode} job={job} meta={meta} mode={quickMode} busy={saving} onClose={() => setQuickMode(null)} onSubmit={(extra) => quick(quickMode, extra)} />
            {error && <div className="fe-notice is-error" role="alert">{error}</div>}
          </div>
        )}
        {!detail && <div className="fe-drawer-body"><p className="fe-sub">{error || 'Loading…'}</p></div>}
        {detail && form && (
          <div className="fe-drawer-body">
            <div className="fe-col">
              <div className="fe-card fe-pad">
                <span className="fe-label">From the form, filled by CSR</span>
                <dl className="fe-dl">{rows.map(([k, v]) => (<React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>))}</dl>
                {job.generated_pdf_id && (
                  <button type="button" className="fe-btn fe-btn--ghost" onClick={() => openWithTokenInNewTab(`/generated-pdfs/${job.generated_pdf_id}/download`, token).catch((err) => setError(err.message))}>Open PDF</button>
                )}
              </div>
              <div className="fe-card fe-pad">
                <span className="fe-label">Visits</span>
                {!detail.visits.length && <p className="fe-sub">No visits recorded yet.</p>}
                <ul className="fe-visits">
                  {detail.visits.map((v) => (
                    <li key={v.id}>
                      <button type="button" className={form.id === v.id ? 'fe-visit is-on' : 'fe-visit'} onClick={() => editVisit(v)}>
                        <span className="fe-mono">{v.visit_date || 'no date'}</span>
                        <span className={statusClass(v.status)}>{v.status}{v.reschedule_date ? ` → ${v.reschedule_date}` : ''}</span>
                        <span className="fe-sub">{[v.team_name, v.reason, v.sla && v.sla !== 'EXEMPTED' ? `SLA ${v.sla}` : null, v.source === 'excel' ? 'from Excel' : null].filter(Boolean).join(' · ')}</span>
                      </button>
                      {v.source === 'app' && (
                        <button
                          type="button" className={confirmRemove === v.id ? 'fe-link fe-visit-remove is-armed' : 'fe-link fe-visit-remove'}
                          onClick={() => { if (confirmRemove === v.id) { setConfirmRemove(null); removeVisit(v); } else setConfirmRemove(v.id); }}
                          onBlur={() => setConfirmRemove((c) => (c === v.id ? null : c))}
                        >
                          {confirmRemove === v.id ? 'Click again to remove' : 'Remove'}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="fe-card fe-pad">
                <span className="fe-label">History</span>
                <ul className="fe-log">
                  {detail.log.map((l, i) => <li key={i}><b>{l.action.replace(/_/g, ' ')}</b> · {l.user_name || 'system'} · {l.at}</li>)}
                  {!detail.log.length && <li>No changes yet.</li>}
                </ul>
              </div>
            </div>

            <form className="fe-card fe-pad fe-form" onSubmit={save}>
              <span className="fe-label">{form.id ? `Editing visit of ${form.visit_date}` : 'Record a visit result'}</span>
              {job.job_type === 'RELOC' && (
                <div className="fe-field">
                  <label htmlFor="fe-reloc">Relocation kind</label>
                  <select id="fe-reloc" value={job.reloc_kind || ''} onChange={(e) => setRelocKind(e.target.value)}>
                    <option value="" disabled>Choose…</option>
                    <option value="repair">Repair-type · move modem or fiber</option>
                    <option value="install">Install-type · new drop to a new house</option>
                  </select>
                </div>
              )}
              <div className="fe-grid2">
                <div className="fe-field"><label htmlFor="fe-date">Visit date</label><input id="fe-date" type="date" value={form.visit_date} onChange={set('visit_date')} required /></div>
                <div className="fe-field">
                  <label htmlFor="fe-team">Team</label>
                  <TeamSelect id="fe-team" teams={meta.teams} value={form.team_id === '' ? null : Number(form.team_id)} onChange={(id) => setForm((f) => ({ ...f, team_id: id ?? '' }))} />
                </div>
                <div className="fe-field">
                  <label htmlFor="fe-area">Area</label>
                  <select id="fe-area" value={job.area || ''} onChange={(e) => setArea(e.target.value)}>
                    <option value="">—</option>
                    {withCurrent(meta.lists.area, job.area).map((a) => <option key={a}>{a}</option>)}
                  </select>
                </div>
                <div className="fe-field">
                  <label htmlFor="fe-status">{type === 'PULLOUT' ? 'Modem result' : 'Status'}</label>
                  <select id="fe-status" value={form.status} onChange={set('status')} required>
                    <option value="">Choose…</option>
                    {withCurrent(meta.lists[`${kind}_status`], form.status).map((s) => <option key={s}>{s}</option>)}
                  </select>
                </div>
                <div className="fe-field">
                  <label htmlFor="fe-reason">Reason</label>
                  <select id="fe-reason" value={form.reason} onChange={set('reason')}>
                    <option value="">—</option>
                    {withCurrent(meta.lists[`${kind}_reason`], form.reason).map((s) => <option key={s}>{s}</option>)}
                  </select>
                </div>
                {type === 'INSTALL' && (
                  <div className="fe-field">
                    <label htmlFor="fe-diff">Difficulty</label>
                    <select id="fe-diff" value={form.difficulty} onChange={set('difficulty')}>
                      <option value="">—</option>
                      {['Easy', 'Medium', 'Hard'].map((d) => <option key={d} value={d}>{d} (≤{meta.slaHours?.[d] ?? '?'}h)</option>)}
                    </select>
                  </div>
                )}
                {type === 'REPAIR' && (
                  <div className="fe-field">
                    <label htmlFor="fe-problem">Problem found</label>
                    <select id="fe-problem" value={form.problem} onChange={set('problem')}>
                      <option value="">—</option>
                      {withCurrent(meta.lists.problem, form.problem).map((s) => <option key={s}>{s}</option>)}
                    </select>
                  </div>
                )}
              </div>

              {type !== 'PULLOUT' && (
                <>
                  <div className="fe-grid3">
                    <div className="fe-field"><label htmlFor="fe-start">Start</label><input id="fe-start" type="time" value={form.start_time} onChange={set('start_time')} /></div>
                    <div className="fe-field"><label htmlFor="fe-end">End</label><input id="fe-end" type="time" value={form.end_time} onChange={set('end_time')} /></div>
                    <div className="fe-calc">
                      <span>Duration <b>{fmtDuration(duration)}</b></span>
                      {type === 'INSTALL' && <span>SLA <b>{slaFor(form, meta.slaHours || {})}</b></span>}
                    </div>
                  </div>
                  <div className="fe-grid5">
                    {MATERIALS.map(([k, l]) => (
                      <div className="fe-field" key={k}>
                        <label htmlFor={`fe-${k}`}>{l}</label>
                        <input id={`fe-${k}`} type="number" min="0" step={k === 'drop_core_m' ? '0.1' : '1'} inputMode="decimal" value={form[k]} onChange={set(k)} />
                      </div>
                    ))}
                  </div>
                </>
              )}
              {type === 'PULLOUT' && (
                <div className="fe-field"><label htmlFor="fe-serial">Modem serial no.</label><input id="fe-serial" value={form.modem_serial} onChange={set('modem_serial')} placeholder="e.g. GPON00A1B2C3" /></div>
              )}
              <div className="fe-field"><label htmlFor="fe-remarks">Remarks</label><textarea id="fe-remarks" rows={3} value={form.remarks} onChange={set('remarks')} /></div>

              {error && <div className="fe-notice is-error" role="alert">{error}</div>}
              <p className="fe-sub">Saved to Field Eng only. The JO record and its status are not changed.</p>
              <div className="fe-actions">
                {form.id && <button type="button" className="fe-btn fe-btn--ghost" onClick={() => setForm(blankVisit(job))}>New visit instead</button>}
                <button type="submit" className="fe-btn fe-btn--primary" disabled={saving}>{saving ? 'Saving…' : form.id ? 'Save changes' : 'Save visit'}</button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

function TodayView({ data }) {
  if (!data) return <p className="fe-sub">Loading…</p>;
  const { teams, materials, sla, pullout, counts, targets } = data;
  const po = pullout?.retrieved || 0;
  const goal = targets?.pulloutPerWeek || 70;
  return (
    <section className="fe-section">
      <div className="fe-kpis">
        <div className="fe-card fe-kpi"><span className="fe-kpi-n">{counts.visits}</span><span className="fe-kpi-l">Visits recorded today</span></div>
        <div className="fe-card fe-kpi fe-kpi--ok"><span className="fe-kpi-n">{counts.done}</span><span className="fe-kpi-l">Completed today</span></div>
        <div className="fe-card fe-kpi"><span className="fe-kpi-n">{sla.pass} / {sla.pass + sla.delay}</span><span className="fe-kpi-l">Install SLA pass</span></div>
        <div className="fe-card fe-kpi"><span className="fe-kpi-n">{po} / {goal}</span><span className="fe-kpi-l">Modems retrieved this week</span></div>
      </div>
      <div className="fe-split">
        <div className="fe-card">
          <h4 className="fe-h">Teams today</h4>
          <div className="fe-table-wrap">
            <table className="fe-table">
              <thead><tr><th>Team</th><th>Area</th><th>Open jobs</th><th>Visits today</th><th>Done today</th><th>Install SLA</th><th>Report card</th></tr></thead>
              <tbody>
                {teams.map((t) => (
                  <tr key={t.id}>
                    <td className="fe-name">{t.name}</td><td>{t.area || '—'}</td><td>{t.open}</td><td>{t.visits}</td><td>{t.done}</td>
                    <td>{t.pass + t.delay ? `${t.pass} pass · ${t.delay} delay` : '—'}</td>
                    <td>{t.card_in ? <span className="fe-pill fe-ok">In</span> : <span className="fe-pill fe-muted">Not yet</span>}</td>
                  </tr>
                ))}
                {!teams.length && <tr><td colSpan={7} className="fe-empty">No active team yet. Add one under Teams.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <div className="fe-card fe-pad">
          <h4 className="fe-h fe-h--flush">Materials used today</h4>
          <p className="fe-sub">From {materials.cards} team report {materials.cards === 1 ? 'card' : 'cards'} entered for today.</p>
          <table className="fe-table fe-table--kv"><tbody>
            {MATERIALS.map(([k, l]) => <tr key={k}><td>{l}</td><td className="fe-num">{materials[k]}</td></tr>)}
          </tbody></table>
          <span className="fe-label">Pull out this week · target {goal}</span>
          <div className="fe-bar"><i style={{ width: `${Math.min(100, (po / goal) * 100)}%` }} /></div>
          <p className="fe-sub">{po} retrieved of {pullout?.visited || 0} visits · {Math.max(0, goal - po)} to go</p>
        </div>
      </div>
    </section>
  );
}

function HitPill({ done, closed, ratio }) {
  const p = pct(done, closed);
  if (p === null) return <span className="fe-pill fe-muted">no closed job</span>;
  return <span className={p / 100 >= ratio ? 'fe-pill fe-ok' : 'fe-pill fe-bad'}>{p}% {p / 100 >= ratio ? 'HIT' : 'BELOW'}</span>;
}

function ReportsView({ data, period, setPeriod, onExport }) {
  const ratio = data?.targets?.hitRatio ?? 0.8;
  return (
    <section className="fe-section">
      <div className="fe-card fe-filters">
        <select aria-label="Period" value={period.period} onChange={(e) => setPeriod((p) => ({ ...p, period: e.target.value }))}>
          <option value="week">This week</option>
          <option value="month">This month</option>
          <option value="range">Date range</option>
        </select>
        {period.period === 'range' && (
          <>
            <input type="date" aria-label="From" value={period.from} onChange={(e) => setPeriod((p) => ({ ...p, from: e.target.value }))} />
            <input type="date" aria-label="To" value={period.to} onChange={(e) => setPeriod((p) => ({ ...p, to: e.target.value }))} />
          </>
        )}
        {data?.range && <span className="fe-sub">{data.range.from} to {data.range.to}</span>}
        <button type="button" className="fe-btn fe-btn--ghost fe-push" onClick={onExport}>Export CSV (FEOMS columns)</button>
      </div>
      {!data && <p className="fe-sub">Loading…</p>}
      {data && (
        <>
          <div className="fe-card">
            <h4 className="fe-h">Team performance</h4>
            <div className="fe-table-wrap">
              <table className="fe-table">
                <thead><tr><th>Team</th><th>Installed</th><th>Install %</th><th>Repaired</th><th>Repair %</th><th>Modems retrieved</th><th>Install SLA</th></tr></thead>
                <tbody>
                  {data.teams.map((t) => (
                    <tr key={t.team}>
                      <td className="fe-name">{t.team}{t.area && <span className="fe-sub"> · {t.area}</span>}</td>
                      <td>{t.installed}</td><td><HitPill done={t.installed} closed={t.install_closed} ratio={ratio} /></td>
                      <td>{t.repaired}</td><td><HitPill done={t.repaired} closed={t.repair_closed} ratio={ratio} /></td>
                      <td>{t.retrieved}{t.pullout_visits ? ` / ${t.pullout_visits}` : ''}</td>
                      <td>{t.sla_pass + t.sla_delay ? `${t.sla_pass} pass · ${t.sla_delay} delay` : '—'}</td>
                    </tr>
                  ))}
                  {!data.teams.length && <tr><td colSpan={7} className="fe-empty">No active team yet. Add one under Teams.</td></tr>}
                </tbody>
              </table>
            </div>
            <p className="fe-sub fe-pad-x">Counts the current teams only; the old Excel crews are kept as history on each job. HIT means at least {Math.round(ratio * 100)}% of closed jobs were completed. Targets: install {data.targets.installPerDay}/day, repair {data.targets.repairPerDay}/day.</p>
          </div>
          <div className="fe-split fe-split--even">
            <div className="fe-card">
              <h4 className="fe-h">Areas</h4>
              <div className="fe-table-wrap">
                <table className="fe-table">
                  <thead><tr><th>Area</th><th>Installed</th><th>Repaired</th><th>Retrieved</th><th>Drop core (m)</th></tr></thead>
                  <tbody>{data.areas.map((a) => <tr key={a.area}><td className="fe-name">{a.area}</td><td>{a.installed}</td><td>{a.repaired}</td><td>{a.retrieved}</td><td>{Math.round(a.drop_core_m).toLocaleString()}</td></tr>)}</tbody>
                </table>
              </div>
            </div>
            <div className="fe-card">
              <h4 className="fe-h">Materials by team</h4>
              <div className="fe-table-wrap">
                <table className="fe-table">
                  <thead><tr><th>Team</th><th>Cards</th>{MATERIALS.map(([k, l]) => <th key={k}>{l}</th>)}</tr></thead>
                  <tbody>
                    {data.materials.map((m) => <tr key={m.team}><td className="fe-name">{m.team}</td><td>{m.cards}</td>{MATERIALS.map(([k]) => <td key={k}>{k === 'drop_core_m' ? Math.round(m[k]).toLocaleString() : m[k]}</td>)}</tr>)}
                    {!data.materials.length && <tr><td colSpan={MATERIALS.length + 2} className="fe-empty">No active team yet.</td></tr>}
                  </tbody>
                </table>
              </div>
              <p className="fe-sub fe-pad-x">From the teams' end-of-day report cards (Teams tab).</p>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

// Suggests people from the old Excel crews and current teams. People who
// mostly worked the team's area come first; typing a new name is fine too.
function PersonInput({ people, area, team, onSave }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = `fe-people-${team.id}`;
  const taken = new Set(team.members.map((m) => m.name.toUpperCase()));

  const matches = useMemo(() => {
    const q = text.trim().toUpperCase();
    return people
      .filter((p) => !taken.has(p.name.toUpperCase()) && (!q || p.name.toUpperCase().includes(q)))
      .map((p) => ({ ...p, here: area ? p.areas[area] || 0 : 0, starts: q && p.name.toUpperCase().startsWith(q) ? 1 : 0 }))
      .sort((a, b) => b.starts - a.starts || b.here - a.here || b.jobs - a.jobs || a.name.localeCompare(b.name))
      .slice(0, 8);
  }, [people, text, area, team.members]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (name) => {
    const value = (name ?? text).trim();
    if (!value) return;
    if (await onSave(value)) { setText(''); setActive(0); setOpen(false); }
  };
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      if (matches.length) setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      save(open && matches[active] ? matches[active].name : undefined);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };
  const exact = matches.some((p) => p.name.toUpperCase() === text.trim().toUpperCase());

  return (
    <div className="fe-inline-form fe-person">
      <div className="fe-person-box">
        <input
          role="combobox" aria-expanded={open && matches.length > 0} aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
          placeholder="Type or pick a name" aria-label={`New member for ${team.name}`} value={text} maxLength={120}
          onChange={(e) => { setText(e.target.value); setActive(0); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKeyDown}
        />
        {open && matches.length > 0 && (
          <ul id={listId} role="listbox" className="fe-person-list">
            {matches.map((p, i) => (
              <li
                key={p.name} id={`${listId}-${i}`} role="option" aria-selected={i === active}
                className={i === active ? 'is-on' : ''}
                onMouseDown={(e) => { e.preventDefault(); save(p.name); }}
                onMouseEnter={() => setActive(i)}
              >
                <span className="fe-person-name">{p.name}</span>
                <span className="fe-sub">
                  {p.jobs ? `${p.topArea || '—'} · ${p.jobs.toLocaleString()} jobs` : 'new'}
                  {area && p.here > 0 && p.topArea !== area ? ` · ${p.here} in ${area}` : ''}
                  {p.teams.length > 0 ? ` · in ${p.teams.join(', ')}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <button type="button" className="fe-btn fe-btn--ghost" disabled={!text.trim()} onMouseDown={(e) => e.preventDefault()} onClick={() => save()}>
        {text.trim() && !exact ? 'Add new' : 'Add'}
      </button>
    </div>
  );
}

const BLANK_CARD = { drop_core_m: '', f_clamp: '', house_clamp: '', sc_connector: '', onu: '', remarks: '' };

// End-of-day materials from the team's report card. One card per day; picking
// a day that already has one loads it for correction.
function MaterialsCard({ team, token, say }) {
  const [open, setOpen] = useState(false);
  const [cards, setCards] = useState([]);
  const [date, setDate] = useState(manilaToday());
  const [form, setForm] = useState(BLANK_CARD);
  const [busy, setBusy] = useState(false);
  const today = manilaToday();

  const fill = (list, day) => {
    const card = list.find((c) => c.work_date === day);
    setForm(card ? Object.fromEntries(Object.keys(BLANK_CARD).map((k) => [k, card[k] ?? ''])) : BLANK_CARD);
  };
  const load = useCallback(async (day) => {
    try {
      const r = await apiRequest(`/field-eng/teams/${team.id}/materials`, { token });
      setCards(r.cards);
      fill(r.cards, day);
    } catch (err) {
      say(err.message, 'error');
    }
  }, [team.id, token, say]);
  useEffect(() => { if (open) load(date); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (day) => { setDate(day); fill(cards, day); };
  const existing = cards.some((c) => c.work_date === date);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await apiRequest(`/field-eng/teams/${team.id}/materials/${date}`, { method: 'PUT', token, body: form });
      say(`${team.name}: materials for ${date} ${existing ? 'corrected' : 'saved'}`);
      await load(date);
    } catch (err) {
      say(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  if (!open) {
    return (
      <button type="button" className="fe-btn fe-btn--ghost fe-card-toggle" onClick={() => setOpen(true)}>
        Materials report card
      </button>
    );
  }
  return (
    <form className="fe-mats" onSubmit={save}>
      <div className="fe-mats-head">
        <span className="fe-label">Materials report card</span>
        <button type="button" className="fe-link" onClick={() => setOpen(false)}>Close</button>
      </div>
      <label className="fe-field">
        <span>Day</span>
        <input type="date" value={date} max={today} required onChange={(e) => pick(e.target.value)} />
      </label>
      <div className="fe-mats-grid">
        {MATERIALS.map(([k, l]) => (
          <label key={k} className="fe-field">
            <span>{l}</span>
            <input type="number" inputMode={k === 'drop_core_m' ? 'decimal' : 'numeric'} min="0" step={k === 'drop_core_m' ? '0.01' : '1'} value={form[k]} onChange={set(k)} placeholder="0" />
          </label>
        ))}
      </div>
      <label className="fe-field">
        <span>Remarks</span>
        <input value={form.remarks} maxLength={500} onChange={set('remarks')} placeholder="Optional" />
      </label>
      <button type="submit" className="fe-btn fe-btn--primary" disabled={busy}>{existing ? 'Save correction' : 'Save'}</button>
      {cards.length > 0 && (
        <div className="fe-mats-recent">
          <span className="fe-label">Recent cards</span>
          {cards.slice(0, 7).map((c) => (
            <button key={c.work_date} type="button" className={c.work_date === date ? 'fe-mats-day is-on' : 'fe-mats-day'} onClick={() => pick(c.work_date)}>
              <b>{c.work_date === today ? 'Today' : c.work_date}</b>
              <span className="fe-sub">{Math.round(c.drop_core_m)} m · {c.f_clamp} F · {c.house_clamp} H · {c.sc_connector} SC · {c.onu} ONU</span>
            </button>
          ))}
        </div>
      )}
    </form>
  );
}

function TeamsView({ token, meta, setMeta, say, onChanged }) {
  const [newTeam, setNewTeam] = useState('');
  const [newArea, setNewArea] = useState('');
  const [people, setPeople] = useState([]);
  const [showLegacy, setShowLegacy] = useState(false);

  const loadPeople = useCallback(async () => {
    try { setPeople((await apiRequest('/field-eng/people', { token })).people); } catch (err) { say(err.message, 'error'); }
  }, [token, say]);
  useEffect(() => { loadPeople(); }, [loadPeople]);

  const call = async (path, method, body, message) => {
    try {
      setMeta(await apiRequest(path, { method, token, body }));
      say(message);
      onChanged();
      return true;
    } catch (err) {
      say(err.message, 'error');
      return false;
    }
  };
  const areas = meta.lists.area || [];
  const current = meta.teams.filter((t) => !t.legacy);
  const legacy = meta.teams.filter((t) => t.legacy);
  // Area order follows the Lists tab; teams without an area go last.
  const groups = [...areas, ...new Set(current.map((t) => t.area).filter((a) => a && !areas.includes(a))), null]
    .map((area) => ({ area, teams: current.filter((t) => (t.area || null) === area) }))
    .filter((g) => g.teams.length || g.area);

  const addMember = async (team, name) => {
    const ok = await call(`/field-eng/teams/${team.id}/members`, 'POST', { name }, `${name} added to ${team.name}`);
    if (ok) loadPeople();
    return ok;
  };
  const rename = (team, value) => {
    const name = value.trim();
    if (!name || name === team.name) return;
    call(`/field-eng/teams/${team.id}`, 'PATCH', { name }, `Renamed ${team.name} to ${name}. Its jobs moved with it.`);
  };

  const card = (team) => (
    <div key={team.id} className={`fe-card fe-team ${team.active ? '' : 'is-off'}`}>
      <div className="fe-team-head">
        <input
          key={team.name} defaultValue={team.name} aria-label="Team name" className="fe-team-name"
          onBlur={(e) => rename(team, e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        />
        <span className={team.active ? 'fe-pill fe-ok' : 'fe-pill fe-muted'}>{team.active ? 'Active' : 'Retired'}</span>
      </div>
      {!team.legacy && (
        <label className="fe-team-area">
          <span className="fe-label">Area</span>
          <select
            value={team.area || ''} aria-label={`Area for ${team.name}`}
            onChange={(e) => call(`/field-eng/teams/${team.id}`, 'PATCH', { area: e.target.value || null }, `${team.name} moved to ${e.target.value || 'no area'}`)}
          >
            <option value="">No area</option>
            {withCurrent(areas, team.area).map((a) => <option key={a}>{a}</option>)}
          </select>
        </label>
      )}
      <span className="fe-label">Members · {team.members.length}</span>
      <div className="fe-chips">
        {team.members.map((m) => (
          <span key={m.id} className="fe-member">{m.name}
            <button type="button" aria-label={`Remove ${m.name}`} onClick={async () => {
              if (await call(`/field-eng/teams/${team.id}/members/${m.id}`, 'DELETE', undefined, `${m.name} removed from ${team.name}`)) loadPeople();
            }}>×</button>
          </span>
        ))}
        {!team.members.length && <span className="fe-sub">No members yet</span>}
      </div>
      {!team.legacy && <PersonInput people={people} area={team.area} team={team} onSave={(name) => addMember(team, name)} />}
      {!team.legacy && <MaterialsCard team={team} token={token} say={say} />}
      <div className="fe-team-foot">
        <button type="button" className="fe-link" onClick={() => call(`/field-eng/teams/${team.id}`, 'PATCH', { active: !team.active }, `${team.name} ${team.active ? 'retired' : 'reactivated'}`)}>
          {team.active ? 'Retire team' : 'Reactivate'}
        </button>
      </div>
    </div>
  );

  return (
    <section className="fe-section">
      <form className="fe-card fe-pad fe-inline-form fe-addteam" onSubmit={async (e) => {
        e.preventDefault();
        const name = newTeam.trim();
        if (name && await call('/field-eng/teams', 'POST', { name, area: newArea || null }, `${name} added. Add its members below.`)) { setNewTeam(''); setNewArea(''); }
      }}>
        <div className="fe-field fe-grow"><label htmlFor="fe-newteam">New team name</label><input id="fe-newteam" value={newTeam} onChange={(e) => {
          const name = e.target.value;
          setNewTeam(name);
          // Teams are named after their area, so "Team Naic" picks NAIC.
          const words = ` ${name.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
          const hit = areas.find((a) => words.includes(` ${a.toLowerCase()} `));
          if (hit) setNewArea(hit);
        }} placeholder="e.g. Team Naic" /></div>
        <div className="fe-field">
          <label htmlFor="fe-newteam-area">Area</label>
          <select id="fe-newteam-area" value={newArea} onChange={(e) => setNewArea(e.target.value)}>
            <option value="">No area</option>
            {areas.map((a) => <option key={a}>{a}</option>)}
          </select>
        </div>
        <button type="submit" className="fe-btn fe-btn--primary">Add team</button>
        <p className="fe-sub fe-full">Teams are named after the area they are deployed to; naming one "Team Naic" sets its area to NAIC. Anyone can add or rename a team and add or remove members: type a name to get suggestions from the old Excel crews, people who worked that area first. Enter each team's materials from its end-of-day report card under Materials report card. Retired teams keep their past jobs and reports but leave the assign lists.</p>
      </form>
      {groups.map((g) => (
        <div key={g.area || 'none'} className="fe-area-group">
          <h4 className="fe-h fe-area-title">{g.area || 'No area'} <span className="fe-sub">{g.teams.length} {g.teams.length === 1 ? 'team' : 'teams'}</span></h4>
          {g.teams.length
            ? <div className="fe-teams">{g.teams.map(card)}</div>
            : <p className="fe-sub">No team for this area yet.</p>}
        </div>
      ))}
      {legacy.length > 0 && (
        <div className="fe-card fe-pad">
          <button type="button" className="fe-link" onClick={() => setShowLegacy((s) => !s)}>
            {showLegacy ? 'Hide' : 'Show'} {legacy.length} old crews from the Excel (history only), by area
          </button>
          {showLegacy && [...areas, null].map((area) => {
            const list = legacy.filter((t) => (t.area || null) === area);
            return list.length > 0 && (
              <div key={area || 'none'} className="fe-area-group">
                <h4 className="fe-h fe-area-title">{area || 'No area'} <span className="fe-sub">{list.length}</span></h4>
                <div className="fe-teams fe-teams--legacy">{list.map(card)}</div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

const LIST_LABELS = {
  area: ['Areas', 'Where a job is. Renaming an area moves its jobs with it.'],
  install_status: ['Install results', 'Status choices for install visits.'],
  repair_status: ['Repair results', 'Status choices for repair visits.'],
  pullout_status: ['Pull-out results', 'Modem result choices for pull-out visits.'],
  install_reason: ['Install reasons', 'Why an install was not finished.'],
  repair_reason: ['Repair reasons', 'Why a repair was not finished.'],
  pullout_reason: ['Pull-out reasons', 'Why a modem was not collected.'],
  problem: ['Problems found', 'What the team found on a repair.']
};

function ListsView({ token, setMeta, say, onChanged }) {
  const [data, setData] = useState(null);
  const [kind, setKind] = useState('area');
  const [draft, setDraft] = useState('');
  const [showRetired, setShowRetired] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setData(await apiRequest('/field-eng/options', { token })); } catch (err) { say(err.message, 'error'); }
  }, [token, say]);
  useEffect(() => { load(); }, [load]);

  const call = async (path, method, body, message) => {
    setBusy(true);
    try {
      const result = await apiRequest(path, { method, token, body });
      setData({ kinds: result.kinds, options: result.options });
      setMeta(result.meta);
      say(message);
      onChanged();
      return true;
    } catch (err) {
      say(err.message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <section className="fe-section"><div className="fe-card fe-pad fe-sub">Loading lists…</div></section>;

  const all = data.options.filter((o) => o.kind === kind);
  const active = all.filter((o) => o.active);
  const retired = all.filter((o) => !o.active);
  const [title, hint] = LIST_LABELS[kind] || [kind, ''];

  const move = (opt, step) => {
    const order = active.map((o) => o.id);
    const i = order.indexOf(opt.id);
    const j = i + step;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    call('/field-eng/options/reorder', 'POST', { kind, ids: [...order, ...retired.map((o) => o.id)] }, `Moved ${opt.value}`);
  };
  const rename = (opt, value) => {
    const next = value.trim();
    if (!next || next === opt.value) return;
    call(`/field-eng/options/${opt.id}`, 'PATCH', { value: next },
      kind === 'area' ? `Renamed ${opt.value} to ${next}. Its jobs moved with it.` : `Renamed ${opt.value} to ${next}. Past visits keep the old wording.`);
  };
  const add = async (e) => {
    e.preventDefault();
    const value = draft.trim();
    if (value && await call('/field-eng/options', 'POST', { kind, value }, `${value} added to ${title}`)) setDraft('');
  };

  const row = (opt, i) => (
    <li key={opt.id} className={`fe-opt ${opt.active ? '' : 'is-off'}`}>
      {opt.active && (
        <span className="fe-opt-move">
          <button type="button" aria-label={`Move ${opt.value} up`} disabled={busy || i === 0} onClick={() => move(opt, -1)}>↑</button>
          <button type="button" aria-label={`Move ${opt.value} down`} disabled={busy || i === active.length - 1} onClick={() => move(opt, 1)}>↓</button>
        </span>
      )}
      {opt.locked || !opt.active
        ? <span className="fe-opt-value">{opt.value}</span>
        : (
          <input
            key={opt.value} defaultValue={opt.value} aria-label={`Rename ${opt.value}`} className="fe-opt-value fe-opt-input" maxLength={120}
            onBlur={(e) => rename(opt, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') { e.currentTarget.value = opt.value; e.currentTarget.blur(); }
            }}
          />
        )}
      <span className="fe-sub fe-opt-uses">{opt.uses ? `used ${opt.uses.toLocaleString()}×` : 'unused'}</span>
      {opt.locked
        ? <span className="fe-pill fe-muted" title="The board's own rules use this value (closing jobs, SLA, reports or area auto-detect)">Built in</span>
        : (
          <button type="button" className="fe-link" disabled={busy}
            onClick={() => call(`/field-eng/options/${opt.id}`, 'PATCH', { active: !opt.active }, `${opt.value} ${opt.active ? 'retired' : 'restored'}`)}>
            {opt.active ? 'Retire' : 'Restore'}
          </button>
        )}
    </li>
  );

  return (
    <section className="fe-section fe-lists">
      <nav className="fe-card fe-pad fe-list-kinds" aria-label="Lists">
        {data.kinds.map((k) => {
          const n = data.options.filter((o) => o.kind === k && o.active).length;
          return (
            <button key={k} type="button" className={k === kind ? 'fe-list-kind is-on' : 'fe-list-kind'} aria-current={k === kind}
              onClick={() => { setKind(k); setDraft(''); setShowRetired(false); }}>
              <span>{LIST_LABELS[k]?.[0] || k}</span><span className="fe-sub">{n}</span>
            </button>
          );
        })}
      </nav>
      <div className="fe-card fe-pad">
        <h4 className="fe-h">{title}</h4>
        <p className="fe-sub">{hint} Click a value to rename it. Retired values leave the dropdowns but stay on past records. Built-in values drive closing, SLA and reports, so they can only be moved.</p>
        <form className="fe-inline-form" onSubmit={add}>
          <input aria-label={`New value for ${title}`} placeholder="Add a value" value={draft} maxLength={120} onChange={(e) => setDraft(e.target.value)} />
          <button type="submit" className="fe-btn fe-btn--primary" disabled={busy || !draft.trim()}>Add</button>
        </form>
        <ol className="fe-opts">{active.map(row)}</ol>
        {!active.length && <p className="fe-sub">Nothing on this list yet.</p>}
        {retired.length > 0 && (
          <>
            <button type="button" className="fe-link" onClick={() => setShowRetired((s) => !s)}>
              {showRetired ? 'Hide' : 'Show'} {retired.length} retired
            </button>
            {showRetired && <ul className="fe-opts">{retired.map(row)}</ul>}
          </>
        )}
      </div>
    </section>
  );
}
