import React, { useEffect, useState } from 'react';
import { apiRequest, getApiBase } from '../api.js';

/* Client lookup - search a customer, then see everything filed under them:
   documents, the files attached to those documents, and their tickets. */

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleDateString();
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

export default function ClientLookup({ token }) {
  const [term, setTerm] = useState('');
  const [clients, setClients] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(null);
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const query = term.trim();
    if (query.length < 2) {
      setClients([]);
      return undefined;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const data = await apiRequest(`/clients?q=${encodeURIComponent(query)}`, { token });
        if (!cancelled) setClients(data.clients || []);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term, token]);

  async function openClient(name) {
    setSelected(name);
    setProfile(null);
    setError('');
    try {
      const data = await apiRequest(`/clients/profile?name=${encodeURIComponent(name)}`, { token });
      setProfile(data);
    } catch (err) {
      setError(err.message);
    }
  }

  function openDocument(id) {
    const base = getApiBase();
    fetch(`${base}/generated-pdfs/${id}/download`, { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => {
        if (!response.ok) throw new Error(`Could not open the PDF (${response.status})`);
        return response.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank', 'noopener,noreferrer');
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      })
      .catch((err) => setError(err.message));
  }

  function openAttachment(id) {
    const base = getApiBase();
    fetch(`${base}/attachments/${id}/file`, { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => {
        if (!response.ok) throw new Error(`Could not open the file (${response.status})`);
        return response.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank', 'noopener,noreferrer');
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      })
      .catch((err) => setError(err.message));
  }

  const summary = profile?.summary;

  return (
    <div className="cl ui-plain">
      <div className="cl-searchbar">
        <label className="cl-field">
          <span>Find a client</span>
          <input
            type="search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Name, contact number, or order / account number"
          />
        </label>
        {selected && (
          <button type="button" onClick={() => { setSelected(null); setProfile(null); }}>
            Back to results
          </button>
        )}
      </div>

      {error && <p className="cl-error">{error}</p>}

      {!selected && (
        <div className="cl-results">
          {term.trim().length < 2 ? (
            <p className="muted">Type at least two characters. Everyone who ever appeared on a form is searchable.</p>
          ) : searching ? (
            <p className="muted">Searching...</p>
          ) : clients.length === 0 ? (
            <p className="muted">Nobody matches that.</p>
          ) : (
            clients.map((client) => (
              <button key={client.name} type="button" className="cl-result" onClick={() => openClient(client.name)}>
                <span className="cl-result-name">{client.name}</span>
                <span className="cl-result-meta">
                  {[client.contact, client.address].filter(Boolean).join(' - ') || 'No contact on file'}
                </span>
                <span className="cl-result-stats">
                  <span>{client.document_count} document{client.document_count === 1 ? '' : 's'}</span>
                  {client.pending_count > 0 && <span className="cl-chip cl-chip--pending">{client.pending_count} pending</span>}
                  <span className="muted">last {formatDate(client.last_seen)}</span>
                </span>
              </button>
            ))
          )}
        </div>
      )}

      {selected && !profile && !error && <p className="muted">Loading {selected}...</p>}

      {selected && profile && (
        <div className="cl-profile">
          <div className="cl-head">
            <div>
              <h3>{summary.name}</h3>
              <p className="muted">
                {[summary.contact, summary.address].filter(Boolean).join(' - ') || 'No contact on file'}
              </p>
              <p className="muted cl-head-sub">
                First seen {formatDate(summary.first_seen)} - last activity {formatDate(summary.last_seen)}
                {summary.templates.length > 0 && ` - ${summary.templates.join(', ')}`}
              </p>
            </div>
            <div className="cl-stats">
              <div className="cl-stat"><span>Documents</span><strong>{summary.document_count}</strong></div>
              <div className="cl-stat"><span>Pending</span><strong>{summary.pending_count}</strong></div>
              <div className="cl-stat"><span>Auto-closed</span><strong>{summary.auto_closed_count}</strong></div>
              <div className="cl-stat"><span>Files</span><strong>{summary.attachment_count}</strong></div>
              <div className="cl-stat"><span>Tickets</span><strong>{summary.ticket_count}</strong></div>
            </div>
          </div>

          <section className="cl-section">
            <h4>Documents</h4>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Template</th>
                    <th>Reference</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th>By</th>
                    <th>Files</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {profile.documents.map((doc) => (
                    <tr key={doc.id}>
                      <td>{doc.template_title || '-'}</td>
                      <td>{doc.reference || '-'}</td>
                      <td>
                        <span className={`cl-chip cl-chip--${doc.status}`}>{doc.status}</span>
                        {doc.auto_closed && <span className="auto-closed-tag">auto</span>}
                      </td>
                      <td>{formatDateTime(doc.created_at)}</td>
                      <td>{doc.created_by_name || '-'}</td>
                      <td>{doc.attachment_count}</td>
                      <td className="actions">
                        <button type="button" onClick={() => openDocument(doc.id)}>Open PDF</button>
                      </td>
                    </tr>
                  ))}
                  {profile.documents.length === 0 && (
                    <tr><td colSpan="7">No documents.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="cl-section">
            <h4>Attached files</h4>
            {profile.attachments.length === 0 ? (
              <p className="muted">Nothing has been attached to this client's documents.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>File</th>
                      <th>Type</th>
                      <th>Uploaded by</th>
                      <th>Uploaded</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {profile.attachments.map((file) => (
                      <tr key={file.id}>
                        <td>{file.original_name}</td>
                        <td>{file.mime_type}</td>
                        <td>{file.uploaded_by_name || '-'}</td>
                        <td>{formatDateTime(file.created_at)}</td>
                        <td className="actions">
                          <button type="button" onClick={() => openAttachment(file.id)}>Open</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="cl-section">
            <h4>Tickets</h4>
            {profile.tickets.length === 0 ? (
              <p className="muted">No support tickets under this name.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Ticket</th>
                      <th>Status</th>
                      <th>Concern</th>
                      <th>Opened</th>
                      <th>Closed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {profile.tickets.map((ticket) => (
                      <tr key={ticket.id}>
                        <td>{ticket.ticket_number}</td>
                        <td><span className={`cl-chip cl-chip--${ticket.status}`}>{ticket.status}</span></td>
                        <td>{ticket.concern}</td>
                        <td>{formatDateTime(ticket.created_at)}</td>
                        <td>{ticket.closed_at ? formatDateTime(ticket.closed_at) : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
