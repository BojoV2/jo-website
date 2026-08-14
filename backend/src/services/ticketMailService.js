/**
 * Emails the NOC when a ticket is submitted, using the Gmail API and the shared
 * service account with domain-wide delegation (sends as GMAIL_SENDER).
 *
 * Env:
 *   GMAIL_SENDER   mailbox to send as (must be a real Workspace user)
 *   NOC_EMAIL      recipient (defaults to noc@imperialnetworkph.com)
 *
 * Best-effort: no-op when not configured; never throws into the request path.
 */
import { getGmailClient, gmailSender, isServiceAccountConfigured } from './ticketGoogle.js';

const DEFAULT_NOC = 'noc@imperialnetworkph.com';

export function nocEmail() {
  return String(process.env.NOC_EMAIL || DEFAULT_NOC).trim();
}

export function isTicketMailEnabled() {
  return isServiceAccountConfigured() && Boolean(gmailSender());
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildRawMessage({ from, to, subject, html }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8'
  ];
  const mime = `${headers.join('\r\n')}\r\n\r\n${html}`;
  return Buffer.from(mime, 'utf8').toString('base64url');
}

export async function emailNocNewTicket(ticket) {
  if (!isTicketMailEnabled()) return { sent: false, skipped: true };

  const from = gmailSender();
  const to = nocEmail();
  const subject = `[Ticket ${ticket.ticket_number}] ${ticket.customer_name}`;

  const checklist = Array.isArray(ticket.tsr_checklist) ? ticket.tsr_checklist : [];
  let tsrHtml = '';
  if (checklist.length > 0) {
    const byCat = new Map();
    for (const e of checklist) {
      const cat = e.category || 'Other';
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(e.item);
    }
    const blocks = Array.from(byCat.entries()).map(([cat, items]) =>
      `<div style="margin-top:6px"><strong>${escapeHtml(cat)}</strong><ul style="margin:4px 0">${
        items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')
      }</ul></div>`).join('');
    tsrHtml = `<h3 style="margin:16px 0 4px">TSR troubleshooting performed</h3>${blocks}`;
  }
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111">
      <h2 style="margin:0 0 12px">New Support Ticket</h2>
      <table cellpadding="6" style="border-collapse:collapse">
        <tr><td style="color:#666">Ticket Number</td><td><strong>${escapeHtml(ticket.ticket_number)}</strong></td></tr>
        <tr><td style="color:#666">Customer</td><td>${escapeHtml(ticket.customer_name)}</td></tr>
        <tr><td style="color:#666">Address</td><td>${escapeHtml(ticket.customer_address || '—')}</td></tr>
        <tr><td style="color:#666">Contact</td><td>${escapeHtml(ticket.customer_contact || '—')}</td></tr>
        <tr><td style="color:#666">Submitted by</td><td>${escapeHtml(ticket.created_by_name || '—')}</td></tr>
        <tr><td style="color:#666;vertical-align:top">Concern</td><td>${escapeHtml(ticket.concern).replace(/\n/g, '<br>')}</td></tr>
      </table>
      ${tsrHtml}
      <p style="color:#888;margin-top:16px">Submitted ${escapeHtml(ticket.created_at)} — Imperial Network JO portal.</p>
    </div>`;

  const gmail = getGmailClient(from);
  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: buildRawMessage({ from, to, subject, html }) }
  });
  return { sent: true };
}
