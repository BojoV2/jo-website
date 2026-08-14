import { useState, useEffect, useCallback, useRef } from 'react';
import { apiRequest, getApiBase } from '../api.js';

const chatImageUrl = (messageId) => `${getApiBase()}/tickets/messages/${messageId}/image`;

// Group a flat checklist [{category, group, item}] by category for display.
function groupChecklist(list) {
  const map = new Map();
  for (const e of list || []) {
    if (!map.has(e.category)) map.set(e.category, []);
    map.get(e.category).push(e.item);
  }
  return Array.from(map.entries());
}

const POLL_MS = 4000;
const EMPTY_FORM = { customer_name: '', customer_address: '', customer_contact: '', concern: '' };

// ── TSR troubleshooting checklist (updated 2026-08-13, flat per category) ──
const TSR_CHECKLIST = [
  {
    title: 'No Internet / No Session',
    groups: [{ label: '', items: [
      'Check Account / PPPoE',
      'Check if VSOL modem or not',
      'Check SN',
      'Check VLAN',
      'Locate SN on the designated OLT',
      'Check if ONU is Online/Offline',
      'Check WAN configuration',
      'Check PPPoE/Session status',
      'Check ONU optical reading',
      'Check Wi-Fi SSID is visible',
      'If client reset modem, escalate to NOC',
      'Refresh/reconnect client',
      'Test internet',
      'If still no internet → ESCALATE TO NOC',
      'Include: Account / SN / OLT / PON / WAN Status / Optical Reading / Troubleshooting Done',
    ] }],
  },
  {
    title: 'VPN User / Poor Speed Test',
    groups: [{ label: '', items: [
      'Check PPPoE Account',
      'Check assigned Framed-IP',
      'Test existing Framed-IP with client FIRST',
      'If not working → configure IP on Address List',
      'Test available IPs under correct NAT / Standalone AC (Millawave / Larus / Imperial IPs)',
      'Change/test ONE IP AT A TIME',
      'Refresh/reconnect client after every change',
      'Test VPN / Internet / Speed (VPN requires 25 Mbps)',
      'If needed → change Framed-IP, verify if Double IP',
      'Make sure Framed-IP belongs to the correct AC',
      'Maximum 2 Framed-IP changes',
      'Still not working → ESCALATE TO NOC',
      'Include: Account / Framed-IP / AC / IPs Tested / Speed Test / Changes Made',
    ] }],
  },
  {
    title: 'Blinking PON',
    groups: [{ label: '', items: [
      'Check SN',
      'Check VLAN',
      'Locate SN on the OLT',
      'Check ONU Status',
      'If Offline → perform Delete Offline',
      'Check if ONU returns Online',
      'Repeat up to 2 times if still Offline',
      'Check ONU Optical Reading',
      '≤ 22 dBm → GOOD',
      '≥ 25 dBm → TECH VISIT',
      '≤ 22 dBm but PON still blinking → check configuration',
      'Configuration normal and PON still blinking → ESCALATE TO NOC',
      'Include: Account / SN / OLT / PON / Optical Reading / ONU Status / Troubleshooting Done',
    ] }],
  },
  {
    title: 'General TSR Checkpoint',
    groups: [{ label: '', items: [
      'VERIFY → CHECK → TEST → REFRESH → RETEST',
      'Change configuration one at a time',
      'Always verify the result before proceeding',
      'Document all IP / WAN / OLT / ONU changes',
      'Do not escalate without completing the required checkpoints',
      'Provide complete troubleshooting details when endorsing to NOC',
    ] }],
  },
];

const keyOf = (category, group, item) => `${category}||${group}||${item}`;

function fmtTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

export default function Ticketing({ token }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [createMsg, setCreateMsg] = useState('');
  const [createErr, setCreateErr] = useState('');

  const [statusFilter, setStatusFilter] = useState('open');
  const [tickets, setTickets] = useState([]);
  const [listErr, setListErr] = useState('');

  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null); // { ticket, messages }
  const [messageBody, setMessageBody] = useState('');
  const [chatImage, setChatImage] = useState(null);
  const [sending, setSending] = useState(false);
  const fileInputRef = useRef(null);
  const [openCats, setOpenCats] = useState({}); // accordion state per category title
  const [formChecklist, setFormChecklist] = useState([]); // TSR draft for a NEW ticket

  const [integrations, setIntegrations] = useState({ sheets: false, email: false });

  const selectedIdRef = useRef(selectedId); selectedIdRef.current = selectedId;
  const statusRef = useRef(statusFilter); statusRef.current = statusFilter;

  const loadList = useCallback(async () => {
    try {
      const data = await apiRequest(`/tickets?status=${statusRef.current}`, { token });
      setTickets(Array.isArray(data) ? data : []);
      setListErr('');
    } catch (err) { setListErr(err.message); }
  }, [token]);

  const loadDetail = useCallback(async (id) => {
    if (!id) { setDetail(null); return; }
    try {
      const data = await apiRequest(`/tickets/${id}`, { token });
      setDetail(data);
    } catch (_err) { setDetail(null); }
  }, [token]);

  useEffect(() => {
    loadList();
    apiRequest('/tickets/integrations', { token }).then(setIntegrations).catch(() => {});
  }, [token, loadList]);

  useEffect(() => { loadList(); }, [statusFilter, loadList]);

  useEffect(() => {
    const timer = setInterval(() => {
      loadList();
      if (selectedIdRef.current) loadDetail(selectedIdRef.current);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [loadList, loadDetail]);

  useEffect(() => { loadDetail(selectedId); }, [selectedId, loadDetail]);

  function updateField(key, value) { setForm((prev) => ({ ...prev, [key]: value })); }

  async function createTicket(e) {
    e.preventDefault();
    setCreateErr(''); setCreateMsg('');
    if (!form.customer_name.trim() || !form.concern.trim()) {
      setCreateErr('Name and Concern are required.');
      return;
    }
    setCreating(true);
    try {
      const created = await apiRequest('/tickets', { method: 'POST', token, body: { ...form, tsr_checklist: formChecklist } });
      setForm(EMPTY_FORM);
      setFormChecklist([]);
      setCreateMsg(`Ticket ${created.ticket_number} created${integrations.email ? ' and emailed to NOC' : ''}.`);
      setStatusFilter('open');
      await loadList();
      setSelectedId(created.id);
    } catch (err) { setCreateErr(err.message); }
    finally { setCreating(false); }
  }

  async function sendMessage(e) {
    e.preventDefault();
    if (!selectedId || (!messageBody.trim() && !chatImage)) return;
    setSending(true);
    try {
      if (chatImage) {
        const fd = new FormData();
        fd.append('body', messageBody);
        fd.append('image', chatImage);
        await apiRequest(`/tickets/${selectedId}/messages`, { method: 'POST', token, formData: fd });
      } else {
        await apiRequest(`/tickets/${selectedId}/messages`, { method: 'POST', token, body: { body: messageBody } });
      }
      setMessageBody('');
      setChatImage(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      await loadDetail(selectedId);
    } catch (err) { setListErr(err.message); }
    finally { setSending(false); }
  }

  async function closeTicket(id) {
    if (!window.confirm('Close this ticket? It will leave the open list and be saved to the Google Sheet.')) return;
    try {
      await apiRequest(`/tickets/${id}/close`, { method: 'PATCH', token });
      await loadList();
      await loadDetail(id);
    } catch (err) { setListErr(err.message); }
  }

  async function reopenTicket(id) {
    try {
      await apiRequest(`/tickets/${id}/reopen`, { method: 'PATCH', token });
      await loadList();
      await loadDetail(id);
    } catch (err) { setListErr(err.message); }
  }

  const selectedTicket = detail?.ticket || null;
  // Compose mode = no ticket selected: the checklist is a draft for the NEW ticket.
  const composeMode = !selectedTicket;
  const activeChecklist = composeMode ? formChecklist : (selectedTicket?.tsr_checklist || []);
  const checkedSet = new Set(activeChecklist.map((e) => keyOf(e.category, e.group, e.item)));

  async function toggleCheck(category, group, item) {
    const k = keyOf(category, group, item);
    const current = activeChecklist;
    const next = checkedSet.has(k)
      ? current.filter((e) => keyOf(e.category, e.group, e.item) !== k)
      : [...current, { category, group, item }];

    if (composeMode) { setFormChecklist(next); return; }

    // Existing ticket: optimistic local update, then persist.
    setDetail((prev) => prev ? { ...prev, ticket: { ...prev.ticket, tsr_checklist: next } } : prev);
    try {
      const updated = await apiRequest(`/tickets/${selectedTicket.id}/checklist`, {
        method: 'PATCH', token, body: { tsr_checklist: next }
      });
      setDetail((prev) => prev ? { ...prev, ticket: { ...updated } } : prev);
    } catch (err) { setListErr(err.message); }
  }

  function toggleCat(title) {
    setOpenCats((prev) => ({ ...prev, [title]: !prev[title] }));
  }

  const checkedCount = checkedSet.size;

  return (
    <div className="tk">
      {/* ── Top: create form (left) + Ticket Number & TSR checklist (right) ── */}
      <div className="tk-top">
        <form className="tk-form" onSubmit={createTicket}>
          <h4 className="tk-heading">Customer detail</h4>
          <input className="tk-input" placeholder="Name"
            value={form.customer_name} onChange={(e) => updateField('customer_name', e.target.value)} />
          <input className="tk-input" placeholder="Address"
            value={form.customer_address} onChange={(e) => updateField('customer_address', e.target.value)} />
          <input className="tk-input" placeholder="Contact"
            value={form.customer_contact} onChange={(e) => updateField('customer_contact', e.target.value)} />
          <textarea className="tk-textarea" placeholder="Concern" rows={5}
            value={form.concern} onChange={(e) => updateField('concern', e.target.value)} />
          <div className="tk-form-actions">
            <button type="submit" className="tk-btn tk-btn--primary" disabled={creating}>
              {creating ? 'Submitting…' : 'Submit Ticket'}
            </button>
          </div>
          {createErr && <p className="tk-err">{createErr}</p>}
          {createMsg && <p className="tk-ok">{createMsg}</p>}
          <p className="tk-integrations">
            Google Sheet: <strong className={integrations.sheets ? 'tk-on' : 'tk-off'}>{integrations.sheets ? 'connected' : 'not configured'}</strong>
            {'  ·  '}NOC email: <strong className={integrations.email ? 'tk-on' : 'tk-off'}>{integrations.email ? 'connected' : 'not configured'}</strong>
          </p>
        </form>

        <div className="tk-detail">
          <div className="tk-ticketno">
            <span>Ticket Number:</span>
            <strong>{selectedTicket ? selectedTicket.ticket_number : 'New ticket (draft)'}</strong>
            {selectedTicket && <span className={`tk-pill tk-pill--${selectedTicket.status}`}>{selectedTicket.status}</span>}
            {selectedTicket && (
              <button type="button" className="tk-btn tk-btn--sm" onClick={() => setSelectedId(null)}>+ New</button>
            )}
          </div>

          <div className="tk-tsr">
            <div className="tk-tsr-head">
              <strong>TSR Check list</strong>
              <span className="tk-tsr-count">
                {composeMode ? 'tick before submit — ' : ''}{checkedCount} checked
              </span>
            </div>
            {composeMode && <p className="tk-muted tk-tsr-hint">Tick the troubleshooting you performed. It is saved with the ticket on Submit.</p>}
            {(
              <div className="tk-tsr-body">
                {TSR_CHECKLIST.map((cat) => {
                  const catChecked = cat.groups.reduce((n, g) =>
                    n + g.items.filter((it) => checkedSet.has(keyOf(cat.title, g.label, it))).length, 0);
                  const isOpen = openCats[cat.title] ?? false;
                  return (
                    <div key={cat.title} className="tk-tsr-cat">
                      <button type="button" className="tk-tsr-cat-head" onClick={() => toggleCat(cat.title)}>
                        <span>{isOpen ? '▾' : '▸'} {cat.title}</span>
                        {catChecked > 0 && <span className="tk-tsr-badge">{catChecked}</span>}
                      </button>
                      {isOpen && (
                        <div className="tk-tsr-groups">
                          {cat.groups.map((g) => (
                            <div key={g.label} className="tk-tsr-group">
                              {g.label && <div className="tk-tsr-group-label">{g.label}</div>}
                              {g.items.map((it) => {
                                const k = keyOf(cat.title, g.label, it);
                                return (
                                  <label key={k} className="tk-tsr-item">
                                    <input type="checkbox" checked={checkedSet.has(k)}
                                      onChange={() => toggleCheck(cat.title, g.label, it)} />
                                    <span>{it}</span>
                                  </label>
                                );
                              })}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Bottom: ticketing list (left) + ticket panel (right) ── */}
      <div className="tk-bottom">
        <div className="tk-list">
          <div className="tk-list-head">
            <strong>Ticketing list</strong>
          </div>
          <div className="tk-filters">
            {['open', 'closed', 'all'].map((s) => (
              <button key={s} type="button"
                className={statusFilter === s ? 'tk-filter active' : 'tk-filter'}
                onClick={() => setStatusFilter(s)}>{s}</button>
            ))}
          </div>
          {listErr && <p className="tk-err">{listErr}</p>}
          <div className="tk-clientlist">
            {tickets.length === 0 && <p className="tk-muted tk-center">No {statusFilter === 'all' ? '' : statusFilter} tickets.</p>}
            {tickets.map((t) => (
              <button key={t.id} type="button"
                className={selectedId === t.id ? 'tk-client active' : 'tk-client'}
                onClick={() => setSelectedId(t.id)}>
                <span className="tk-client-name">{t.customer_name}</span>
                <span className="tk-client-meta">
                  <span className="tk-mono">{t.ticket_number}</span>
                  <span className={`tk-pill tk-pill--${t.status}`}>{t.status}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="tk-panel">
          {!selectedTicket && <p className="tk-muted tk-center">Select a ticket to view its conversation.</p>}
          {selectedTicket && (
            <>
              <div className="tk-panel-head">
                <div className="tk-panel-title">
                  <span className="tk-mono">{selectedTicket.ticket_number}</span>
                  <span className={`tk-pill tk-pill--${selectedTicket.status}`}>{selectedTicket.status}</span>
                </div>
                <div className="tk-panel-actions">
                  {selectedTicket.status === 'open'
                    ? <button type="button" className="tk-btn tk-btn--danger tk-btn--sm" onClick={() => closeTicket(selectedTicket.id)}>Close</button>
                    : <button type="button" className="tk-btn tk-btn--sm" onClick={() => reopenTicket(selectedTicket.id)}>Reopen</button>}
                </div>
              </div>

              <div className="tk-panel-meta">
                <div><span>Name</span><strong>{selectedTicket.customer_name}</strong></div>
                <div><span>Contact</span><strong>{selectedTicket.customer_contact || '—'}</strong></div>
                <div className="tk-detail-wide"><span>Address</span><strong>{selectedTicket.customer_address || '—'}</strong></div>
                <div className="tk-detail-wide"><span>Concern</span><strong>{selectedTicket.concern}</strong></div>
              </div>

              {(selectedTicket.tsr_checklist || []).length > 0 && (
                <div className="tk-panel-tsr">
                  <div className="tk-panel-tsr-head">TSR troubleshooting performed</div>
                  {groupChecklist(selectedTicket.tsr_checklist).map(([cat, items]) => (
                    <div key={cat} className="tk-panel-tsr-cat">
                      <span className="tk-panel-tsr-cat-name">{cat}</span>
                      <ul>{items.map((it, i) => <li key={i}>{it}</li>)}</ul>
                    </div>
                  ))}
                </div>
              )}

              <div className="tk-thread">
                {(detail?.messages || []).length === 0 && <p className="tk-muted">No messages yet.</p>}
                {(detail?.messages || []).map((m) => (
                  <div key={m.id} className="tk-msg">
                    <div className="tk-msg-head">
                      <strong>{m.author_name || 'Staff'}</strong>
                      <span>{fmtTime(m.created_at)}</span>
                    </div>
                    {m.body && <div className="tk-msg-body">{m.body}</div>}
                    {m.has_image && (
                      <a href={chatImageUrl(m.id)} target="_blank" rel="noopener noreferrer">
                        <img className="tk-msg-img" src={chatImageUrl(m.id)} alt={m.image_name || 'attachment'} />
                      </a>
                    )}
                  </div>
                ))}
              </div>

              <p className="tk-muted tk-chat-note">Chat messages expire after 24 hours.</p>
              <form className="tk-composer-row" onSubmit={sendMessage}>
                <label className="tk-attach" title="Attach image">
                  📎
                  <input ref={fileInputRef} type="file" accept="image/*" hidden
                    onChange={(e) => setChatImage(e.target.files?.[0] || null)} />
                </label>
                <input className="tk-input" placeholder="Message…"
                  value={messageBody} onChange={(e) => setMessageBody(e.target.value)} />
                <button type="submit" className="tk-btn tk-btn--primary" disabled={sending || (!messageBody.trim() && !chatImage)}>
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </form>
              {chatImage && (
                <p className="tk-attach-note">📎 {chatImage.name}
                  <button type="button" className="tk-attach-clear" onClick={() => { setChatImage(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}>✕</button>
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
