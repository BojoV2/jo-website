import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { apiRequest, getApiBase } from '../api.js';
import QRCode from 'qrcode';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import Ticketing from './Ticketing.jsx';

// Fallback: read token directly from session storage in case the prop chain breaks
function getSessionToken() {
  const raw = localStorage.getItem('pdfwf.session') || sessionStorage.getItem('pdfwf.session');
  if (!raw) return null;
  try { return JSON.parse(raw)?.token || null; } catch { return null; }
}

const PLANS = [
  { value: 599,  speed: '35 Mbps'  },
  { value: 799,  speed: '50 Mbps'  },
  { value: 999,  speed: '100 Mbps' },
  { value: 1200, speed: '150 Mbps' },
  { value: 1400, speed: '200 Mbps' },
  { value: 1600, speed: '300 Mbps' },
  { value: 2000, speed: '500 Mbps' },
];

const TOOLS = [
  { id: 'adjustment',        label: 'Bill Adjustment'     },
  { id: 'calculator',        label: 'Bill Calculator'     },
  { id: 'contract',          label: 'Contract End Date'   },
  { id: 'discount',          label: 'Percentage Discount' },
  { id: 'auto-reply',        label: 'Auto Reply'          },
  { id: 'link-to-qr',       label: 'Link to QR'          },
  { id: 'imperial-tracking', label: 'Imperial Tracking'   },
  { id: 'ticketing',         label: 'Tiketing'            },
];

const HOW_TO_USE = {
  adjustment: [
    'Select the customer\'s internet plan.',
    'Enter the total days and/or hours the service was unavailable.',
    'Enter the bill due date.',
    'Click Calculate — the credit and adjusted amount appear below.',
  ],
  calculator: [
    'Select the customer\'s internet plan.',
    'Set the billing due date (activation date).',
    'Set the cycle date (how far into the cycle to calculate).',
    'Click Calculate — the prorated charge and first bill total appear below.',
  ],
  contract: [
    'Enter the contract start date.',
    'Set the contract length in months (default is 12).',
    'Click Find End Date — the contract expiry and termination fee appear below.',
  ],
  discount: [
    'Select the customer\'s internet plan.',
    'Enter the peso amount of the discount (e.g., ₱100).',
    'Click Calculate — the equivalent percentage and discounted price appear.',
    'Use the Copy button to copy the percentage value directly.',
  ],
};

function formatPeso(amount) {
  return '₱' + amount.toFixed(2);
}

function PlanSelect({ id, value, onChange }) {
  const selected = PLANS.find((p) => p.value === value);
  return (
    <>
      <select id={id} value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {PLANS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.speed} — {formatPeso(p.value)} Monthly
          </option>
        ))}
      </select>
      {selected && <small className="bt-plan-speed">{selected.speed}</small>}
    </>
  );
}

function HowToUse({ steps }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bt-howto">
      <button type="button" className="bt-howto-toggle" onClick={() => setOpen((v) => !v)}>
        <span>{open ? '▲' : '▼'}</span>
        How to use it
      </button>
      {open && (
        <ol className="bt-howto-list">
          {steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ── Bill Adjustment ───────────────────────────────────────────────
function BillAdjustment() {
  const [plan, setPlan]         = useState(599);
  const [daysLost, setDaysLost] = useState('');
  const [hoursLost, setHoursLost] = useState('');
  const [dueDate, setDueDate]   = useState('');
  const [result, setResult]     = useState(null);
  const [error, setError]       = useState('');

  function calculate() {
    const days  = parseInt(daysLost)  || 0;
    const hours = parseInt(hoursLost) || 0;
    if (!dueDate || (days === 0 && hours === 0)) {
      setError('Please fill in all fields and provide at least days or hours without service.');
      setResult(null);
      return;
    }
    setError('');
    const planInfo    = PLANS.find((p) => p.value === plan);
    const totalHours  = days * 24 + hours;
    const hourlyRate  = plan / (30 * 24);
    const credit      = hourlyRate * totalHours;
    const adjusted    = plan - credit;
    setResult({ planInfo, days, hours, totalHours, hourlyRate, credit, adjusted, dueDate });
  }

  return (
    <div>
      <HowToUse steps={HOW_TO_USE.adjustment} />
      <div className="bt-form">
        <div className="bt-field">
          <label htmlFor="adj-plan">Select Plan</label>
          <PlanSelect id="adj-plan" value={plan} onChange={setPlan} />
        </div>
        <div className="bt-field">
          <label>Total Time Without Service</label>
          <div className="bt-row">
            <input type="number" placeholder="Days" min="0" value={daysLost}  onChange={(e) => setDaysLost(e.target.value)}  />
            <input type="number" placeholder="Hours" min="0" value={hoursLost} onChange={(e) => setHoursLost(e.target.value)} />
          </div>
        </div>
        <div className="bt-field">
          <label htmlFor="adj-due">Due Date</label>
          <input id="adj-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
        <button type="button" className="bt-submit" onClick={calculate}>Calculate</button>
      </div>
      {error && <p className="bt-error">{error}</p>}
      {result && (
        <div className="bt-result">
          <div className="bt-result-summary">
            <p>📅 <strong>Due Date:</strong> {result.dueDate}</p>
            <p>📡 <strong>Plan:</strong> {result.planInfo.speed} ({formatPeso(plan)})</p>
            <p>❌ <strong>Credit for {result.days}d {result.hours}h:</strong> −{formatPeso(result.credit)}</p>
            <p>✅ <strong>Adjusted Amount to Pay:</strong> {formatPeso(result.adjusted)}</p>
          </div>
          <div className="bt-result-details">
            <h4>Detailed Calculation</h4>
            <ul>
              <li>Plan <strong>{result.planInfo.speed}</strong> at {formatPeso(plan)}/month.</li>
              <li>30-day billing cycle = 720 hours → hourly rate: <strong>{formatPeso(result.hourlyRate)}</strong>.</li>
              <li>Time without service: <strong>{result.days}d + {result.hours}h = {result.totalHours} hours</strong>.</li>
              <li>Credit: <strong>{formatPeso(result.credit)}</strong>.</li>
              <li>Adjusted bill: <strong>{formatPeso(plan)} − {formatPeso(result.credit)} = {formatPeso(result.adjusted)}</strong>.</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Bill Calculator ───────────────────────────────────────────────
function BillCalculator() {
  const [plan, setPlan]         = useState(599);
  const [dueDate, setDueDate]   = useState('');
  const [cycleDate, setCycleDate] = useState('');
  const [result, setResult]     = useState(null);
  const [error, setError]       = useState('');

  function calculate() {
    const activation = new Date(dueDate);
    const cycle      = new Date(cycleDate);
    if (isNaN(activation.getTime()) || isNaN(cycle.getTime())) {
      setError('Please fill in all date fields.');
      setResult(null);
      return;
    }
    setError('');
    const planInfo  = PLANS.find((p) => p.value === plan);
    const dailyRate = plan / 30;
    let daysUsed    = Math.ceil((cycle - activation) / (1000 * 60 * 60 * 24));
    if (daysUsed < 0) daysUsed = 0;
    const prorated  = dailyRate * daysUsed;
    const total     = prorated + plan;
    setResult({ planInfo, activation, cycle, dailyRate, daysUsed, prorated, total });
  }

  return (
    <div>
      <HowToUse steps={HOW_TO_USE.calculator} />
      <div className="bt-form">
        <div className="bt-field">
          <label htmlFor="calc-plan">Select Plan</label>
          <PlanSelect id="calc-plan" value={plan} onChange={setPlan} />
        </div>
        <div className="bt-field">
          <label htmlFor="calc-due">Due Date</label>
          <input id="calc-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
        <div className="bt-field">
          <label htmlFor="calc-cycle">Days Consume (cycle date)</label>
          <input id="calc-cycle" type="date" value={cycleDate} onChange={(e) => setCycleDate(e.target.value)} />
        </div>
        <button type="button" className="bt-submit" onClick={calculate}>Calculate</button>
      </div>
      {error && <p className="bt-error">{error}</p>}
      {result && (
        <div className="bt-result">
          <div className="bt-result-summary">
            <p>📡 <strong>Plan:</strong> {result.planInfo.speed} ({formatPeso(plan)})</p>
            <p>📆 <strong>Due Date:</strong> {result.activation.toDateString()}</p>
            <p>🔄 <strong>Days Consume:</strong> {result.cycle.toDateString()}</p>
            <p>💰 <strong>First Bill Total:</strong> {formatPeso(result.total)}</p>
          </div>
          <div className="bt-result-details">
            <h4>First Bill Breakdown</h4>
            <ul>
              <li>Daily rate: <strong>{formatPeso(result.dailyRate)}</strong> (plan ÷ 30).</li>
              <li>Pro-rated charge for {result.daysUsed} day(s): <strong>{formatPeso(result.prorated)}</strong>.</li>
              <li>Advance payment (next full month): <strong>{formatPeso(plan)}</strong>.</li>
              <li>Total first bill: <strong>{formatPeso(result.prorated)} + {formatPeso(plan)} = {formatPeso(result.total)}</strong>.</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Contract End Date ─────────────────────────────────────────────
function ContractEndDate() {
  const [startDate, setStartDate] = useState('');
  const [months, setMonths]       = useState(12);
  const [result, setResult]       = useState(null);
  const [error, setError]         = useState('');

  function calculate() {
    if (!startDate || isNaN(Number(months)) || Number(months) < 1) {
      setError('Please enter a valid start date and contract length.');
      setResult(null);
      return;
    }
    setError('');
    const start = new Date(startDate);
    const end   = new Date(start);
    end.setMonth(end.getMonth() + Number(months));
    if (end.getDate() < start.getDate()) end.setDate(0);
    end.setDate(end.getDate() - 1);
    setResult({ start, end, months: Number(months) });
  }

  return (
    <div>
      <HowToUse steps={HOW_TO_USE.contract} />
      <div className="bt-form">
        <div className="bt-field">
          <label htmlFor="con-start">Start Date</label>
          <input id="con-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </div>
        <div className="bt-field">
          <label htmlFor="con-months">Contract Length (months)</label>
          <input id="con-months" type="number" min="1" value={months} onChange={(e) => setMonths(e.target.value)} />
        </div>
        <button type="button" className="bt-submit" onClick={calculate}>Find End Date</button>
      </div>
      {error && <p className="bt-error">{error}</p>}
      {result && (
        <div className="bt-result">
          <div className="bt-result-summary">
            <p>📅 <strong>Contract ends on:</strong> {result.end.toDateString()}</p>
          </div>
          <div className="bt-result-details">
            <h4>Contract Details</h4>
            <ul>
              <li>Start date: <strong>{result.start.toDateString()}</strong></li>
              <li>Contract length: <strong>{result.months} month(s)</strong></li>
              <li>Termination fee if not completed: <strong>₱2,500.00</strong></li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Percentage Discount ───────────────────────────────────────────
function PercentageDiscount() {
  const [plan, setPlan]               = useState(599);
  const [discountAmount, setDiscount] = useState('');
  const [result, setResult]           = useState(null);
  const [error, setError]             = useState('');
  const [copied, setCopied]           = useState(false);

  function calculate() {
    const discount = parseFloat(discountAmount);
    if (isNaN(discount) || discount < 0) {
      setError('Please select a plan and enter a valid discount amount.');
      setResult(null);
      return;
    }
    if (discount > plan) {
      setError('Discount amount cannot be greater than the plan price.');
      setResult(null);
      return;
    }
    setError('');
    const planInfo        = PLANS.find((p) => p.value === plan);
    const percentage      = (discount / plan) * 100;
    const discountedPrice = plan - discount;
    setResult({ planInfo, discount, percentage, discountedPrice });
  }

  async function copyPercentage() {
    if (!result) return;
    await navigator.clipboard.writeText(String(result.percentage));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div>
      <HowToUse steps={HOW_TO_USE.discount} />
      <div className="bt-form">
        <div className="bt-field">
          <label htmlFor="disc-plan">Select Plan</label>
          <PlanSelect id="disc-plan" value={plan} onChange={setPlan} />
        </div>
        <div className="bt-field">
          <label htmlFor="disc-amount">Discount Amount (₱)</label>
          <input id="disc-amount" type="number" placeholder="e.g., 100" min="0" value={discountAmount} onChange={(e) => setDiscount(e.target.value)} />
        </div>
        <button type="button" className="bt-submit" onClick={calculate}>Calculate Percentage</button>
      </div>
      {error && <p className="bt-error">{error}</p>}
      {result && (
        <div className="bt-result">
          <div className="bt-result-summary">
            <p><strong>Plan Price:</strong> {formatPeso(plan)}</p>
            <p><strong>Discount Amount:</strong> −{formatPeso(result.discount)}</p>
            <p>
              <strong>Percentage Discount:</strong> {result.percentage}%
              <button type="button" className="bt-copy-btn" onClick={copyPercentage}>
                {copied ? '✓ Copied' : 'Copy'}
              </button>
            </p>
            <p><strong>Discounted Price:</strong> {formatPeso(result.discountedPrice)}</p>
          </div>
          <div className="bt-result-details">
            <h4>How We Got This</h4>
            <p>Formula: <strong>(Discount ÷ Original Price) × 100</strong></p>
            <ul>
              <li>Plan: <strong>{result.planInfo.speed}</strong> at {formatPeso(plan)}</li>
              <li>Discount: <strong>{formatPeso(result.discount)}</strong></li>
              <li>({result.discount} ÷ {plan}) × 100 = <strong>{result.percentage}%</strong></li>
              <li>Final price: <strong>{formatPeso(plan)} − {formatPeso(result.discount)} = {formatPeso(result.discountedPrice)}</strong></li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Auto Reply ────────────────────────────────────────────────────
const AR_PIN_KEY = 'ar_pinned_message_id';

function AutoReply({ token }) {
  const [messages, setMessages]   = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [pinnedId, setPinnedId]   = useState(() => localStorage.getItem(AR_PIN_KEY) || '');
  const [copied, setCopied]       = useState('');
  const [lightbox, setLightbox]   = useState(null); // { src, alt }

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiRequest('/auto-reply', { token });
      setMessages(data);
    } catch (e) {
      setError(e.message || 'Failed to load messages');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  function togglePin(id) {
    const next = pinnedId === id ? '' : id;
    setPinnedId(next);
    if (next) localStorage.setItem(AR_PIN_KEY, next);
    else localStorage.removeItem(AR_PIN_KEY);
  }

  async function copyText(text, id) {
    await navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(''), 2000);
  }

  function imageUrl(imageId) {
    return `${getApiBase()}/auto-reply/images/${imageId}`;
  }

  // Sort so pinned message appears first
  const sorted = pinnedId
    ? [...messages].sort((a, b) => (a.id === pinnedId ? -1 : b.id === pinnedId ? 1 : 0))
    : messages;

  if (loading) return <p className="muted">Loading messages…</p>;
  if (error)   return <p className="bt-error">{error}</p>;
  if (sorted.length === 0) return <p className="muted">No auto-reply messages yet.</p>;

  return (
    <div className="ar-list">
      {lightbox && (
        <div className="ar-lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox.src} alt={lightbox.alt} onClick={(e) => e.stopPropagation()} />
          <button className="ar-lightbox-close" onClick={() => setLightbox(null)}>✕</button>
        </div>
      )}

      {sorted.map((msg) => {
        const isPinned = pinnedId === msg.id;
        return (
          <div key={msg.id} className={`ar-card${isPinned ? ' ar-card--pinned' : ''}`}>
            <div className="ar-card-header">
              <span className="ar-card-title">
                {isPinned && <span className="ar-pin-badge">📌 Pinned</span>}
                {msg.title}
              </span>
              <div className="ar-card-actions">
                <button
                  type="button"
                  className={`bt-copy-btn${isPinned ? ' ar-pin-active' : ''}`}
                  onClick={() => togglePin(msg.id)}
                  title={isPinned ? 'Unpin message' : 'Pin message'}
                >
                  {isPinned ? '📌 Unpin' : '📌 Pin'}
                </button>
                <button
                  type="button"
                  className="bt-copy-btn"
                  onClick={() => copyText(msg.message_text, msg.id)}
                >
                  {copied === msg.id ? '✓ Copied' : 'Copy'}
                </button>
              </div>
            </div>

            <pre className="ar-message-text">{msg.message_text}</pre>

            {msg.images && msg.images.length > 0 && (
              <div className="ar-images">
                {msg.images.map((img) => (
                  <img
                    key={img.id}
                    src={imageUrl(img.id)}
                    alt={img.original_name || 'image'}
                    className="ar-thumb"
                    onClick={() => setLightbox({ src: imageUrl(img.id), alt: img.original_name || 'image' })}
                    title="Click to enlarge"
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Single QR card (user view) ─────────────────────────────────────
function QrCard({ link }) {
  const [dataUrl, setDataUrl]   = useState('');
  const [lightbox, setLightbox] = useState(false);

  useEffect(() => {
    QRCode.toDataURL(link.url, { width: 260, margin: 2, color: { dark: '#112b47', light: '#ffffff' } })
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
    <div className="qr-card">
      {lightbox && (
        <div className="ar-lightbox" onClick={() => setLightbox(false)}>
          <img src={dataUrl} alt="QR Code (enlarged)" onClick={(e) => e.stopPropagation()} />
          <button className="ar-lightbox-close" onClick={() => setLightbox(false)}>✕</button>
        </div>
      )}
      {link.label && <p className="qr-label">{link.label}</p>}
      {dataUrl ? (
        <img
          src={dataUrl}
          alt="QR Code"
          className="qr-image"
          title="Click to enlarge"
          onClick={() => setLightbox(true)}
        />
      ) : (
        <div className="qr-placeholder">Generating QR…</div>
      )}
      <p className="qr-url">{link.url}</p>
      <p className="qr-hint">Click to enlarge · Esc to close</p>
    </div>
  );
}

// ── Link to QR ────────────────────────────────────────────────────
function LinkToQR({ token }) {
  const [qrLinks, setQrLinks]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiRequest('/qr-link', { token });
      setQrLinks(data);
    } catch (e) {
      setError(e.message || 'Failed to load QR codes');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <p className="muted">Loading QR codes…</p>;
  if (error)   return <p className="bt-error">{error}</p>;
  if (qrLinks.length === 0) return (
    <div className="qr-empty">
      <p className="muted">No QR codes have been published yet. Check back later.</p>
    </div>
  );

  return (
    <div className="qr-grid">
      {qrLinks.map((link) => (
        <QrCard key={link.id} link={link} />
      ))}
    </div>
  );
}

// ── Imperial Tracking ─────────────────────────────────────────────

// SVG car marker — realistic top-down view, colour changes per vehicle state
function makeCarIcon(color, rotateDeg = 0) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 64" width="24" height="38">
    <!-- Drop shadow -->
    <ellipse cx="20" cy="60" rx="10" ry="3" fill="rgba(0,0,0,0.25)"/>
    <!-- Wheels (drawn first so body overlaps slightly) -->
    <rect x="2"  y="10" width="8" height="13" rx="3" fill="#1a1a2e"/>
    <rect x="30" y="10" width="8" height="13" rx="3" fill="#1a1a2e"/>
    <rect x="2"  y="38" width="8" height="13" rx="3" fill="#1a1a2e"/>
    <rect x="30" y="38" width="8" height="13" rx="3" fill="#1a1a2e"/>
    <!-- Wheel shine -->
    <rect x="3"  y="11" width="3" height="4" rx="1.5" fill="rgba(255,255,255,0.15)"/>
    <rect x="31" y="11" width="3" height="4" rx="1.5" fill="rgba(255,255,255,0.15)"/>
    <rect x="3"  y="39" width="3" height="4" rx="1.5" fill="rgba(255,255,255,0.15)"/>
    <rect x="31" y="39" width="3" height="4" rx="1.5" fill="rgba(255,255,255,0.15)"/>
    <!-- Main car body -->
    <path d="M9,6 Q11,2 20,2 Q29,2 31,6 L33,18 L33,50 Q33,57 20,57 Q7,57 7,50 L7,18 Z"
          fill="${color}" stroke="rgba(255,255,255,0.6)" stroke-width="1"/>
    <!-- Body highlight (left side) -->
    <path d="M10,8 Q11,5 20,4.5 L20,55 Q10,54 9,50 L9,18 Z"
          fill="rgba(255,255,255,0.08)"/>
    <!-- Front windshield -->
    <path d="M12,16 L13,8 L27,8 L28,16 Q20,14.5 12,16 Z"
          fill="rgba(180,220,255,0.75)" stroke="rgba(255,255,255,0.4)" stroke-width="0.5"/>
    <!-- Windshield glare -->
    <path d="M14,10 L16,9 L18,14 L15,14.5 Z" fill="rgba(255,255,255,0.35)"/>
    <!-- Roof panel -->
    <rect x="11" y="18" width="18" height="18" rx="2"
          fill="${color}" stroke="rgba(0,0,0,0.1)" stroke-width="0.5"/>
    <!-- Roof centre line -->
    <line x1="20" y1="19" x2="20" y2="35" stroke="rgba(0,0,0,0.12)" stroke-width="1"/>
    <!-- Rear windshield -->
    <path d="M12,38 Q20,39.5 28,38 L27,46 L13,46 Z"
          fill="rgba(180,220,255,0.5)" stroke="rgba(255,255,255,0.3)" stroke-width="0.5"/>
    <!-- Headlights -->
    <rect x="11" y="4"  width="7" height="3" rx="1.5" fill="#fffde7" opacity="0.95"/>
    <rect x="22" y="4"  width="7" height="3" rx="1.5" fill="#fffde7" opacity="0.95"/>
    <!-- Tail lights -->
    <rect x="11" y="52" width="6" height="3" rx="1.5" fill="#ff1744" opacity="0.9"/>
    <rect x="23" y="52" width="6" height="3" rx="1.5" fill="#ff1744" opacity="0.9"/>
    <!-- Front bumper -->
    <rect x="12" y="2" width="16" height="2" rx="1" fill="rgba(255,255,255,0.3)"/>
  </svg>`;
  // Wrap in a div so CSS rotation keeps the anchor at the icon centre
  const html = `<div style="width:24px;height:38px;transform:rotate(${rotateDeg}deg);transform-origin:12px 19px;line-height:0">${svg}</div>`;
  return L.divIcon({
    html,
    className: '',
    iconSize:    [24, 38],
    iconAnchor:  [12, 19],   // centre of icon so rotation stays on the vehicle position
    popupAnchor: [0, -22],
  });
}
const ICON_IDLE    = makeCarIcon('#94a3b8', 0);  // grey  — idle / online but stopped
const ICON_OFFLINE = makeCarIcon('#ef4444', 0);  // red   — offline / off
// Moving icons are created per-vehicle to carry the correct heading

function vehicleIcon(v) {
  if (!v.isOnline) return ICON_OFFLINE;
  if (v.isMoving)  return makeCarIcon('#22c55e', v.course || 0);  // rotated green car
  return ICON_IDLE;
}

function statusDot(v) {
  if (!v.isOnline) return <span className="it-dot it-dot--offline" title="Offline" />;
  if (v.isMoving)  return <span className="it-dot it-dot--moving"  title="Moving"  />;
  return                  <span className="it-dot it-dot--idle"    title="Idle"    />;
}

function formatSpeed(kmh) {
  if (!kmh && kmh !== 0) return '—';
  return `${Math.round(kmh)} km/h`;
}

function formatTime(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

function VehicleRow({ v, selected, onClick }) {
  return (
    <div
      className={`it-vehicle-item${selected ? ' it-vehicle-item--selected' : ''}`}
      onClick={onClick}
    >
      <div className="it-vehicle-header">
        {statusDot(v)}
        <span className="it-vehicle-name">{v.name}</span>
        {v.plate && <span className="it-vehicle-plate">{v.plate}</span>}
      </div>
      <div className="it-vehicle-meta">
        <span>{v.speed > 0 ? formatSpeed(v.speed) : 'Stopped'}</span>
        {v.lastUpdate && <span>{formatTime(v.lastUpdate)}</span>}
      </div>
    </div>
  );
}

function ImperialTracking({ token }) {
  const [trackerList, setTrackerList]   = useState([]);  // enabled trackers from /status
  const [activeTrackerId, setActiveTrackerId] = useState(null);
  const [vehicles, setVehicles]         = useState([]);
  const [loading, setLoading]           = useState(true);
  const [syncing, setSyncing]           = useState(false);
  const [error, setError]               = useState('');
  const [syncError, setSyncError]       = useState('');
  const [syncedAt, setSyncedAt]         = useState(null);
  const [selectedVehicle, setSelectedVehicle] = useState(null);
  const [search, setSearch]             = useState('');

  const mapRef      = useRef(null);   // DOM div
  const mapObj      = useRef(null);   // Leaflet map instance
  const markersRef  = useRef({});     // { vehicleId → Leaflet marker }
  const popupRef    = useRef(null);

  // ── 1. Load tracker list ──────────────────────────────────────
  useEffect(() => {
    apiRequest('/tracking/status', { token })
      .then((data) => {
        setTrackerList(data);
        if (data.length > 0) setActiveTrackerId(data[0].id);
        else { setLoading(false); }
      })
      .catch((e) => { setError(e.message || 'Failed to load trackers'); setLoading(false); });
  }, [token]);

  // ── 2. Load vehicles whenever tracker changes ─────────────────
  const loadVehicles = useCallback(async (id) => {
    if (!id) return;
    setSyncing(true);
    setSyncError('');
    try {
      const data = await apiRequest(`/tracking/${id}/vehicles`, { token });
      setVehicles(data.vehicles || []);
      setSyncedAt(data.synced_at || null);
      if (data.sync_error) setSyncError(data.sync_error);
    } catch (e) {
      setSyncError(e.message || 'Sync failed');
    } finally {
      setSyncing(false);
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!activeTrackerId) return;
    setLoading(true);
    loadVehicles(activeTrackerId);
    const interval = setInterval(() => loadVehicles(activeTrackerId), 30_000);
    return () => clearInterval(interval);
  }, [activeTrackerId, loadVehicles]);

  // ── 3. Init map ───────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || mapObj.current) return;
    const map = L.map(mapRef.current, {
      center: [14.5995, 120.9842], // Philippines default centre
      zoom: 12,
      zoomControl: true,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);
    mapObj.current = map;
    // Ensure Leaflet recalculates tile layout after the container is fully painted
    setTimeout(() => map.invalidateSize(), 0);
    return () => {
      if (mapObj.current) { mapObj.current.remove(); mapObj.current = null; }
    };
  }, []);

  // ── 4. Update markers when vehicles change ────────────────────
  useEffect(() => {
    const map = mapObj.current;
    if (!map) return;

    const currentIds = new Set(vehicles.map((v) => v.id));
    const bounds = [];

    // Remove stale markers
    Object.entries(markersRef.current).forEach(([id, marker]) => {
      if (!currentIds.has(id)) { marker.remove(); delete markersRef.current[id]; }
    });

    vehicles.forEach((v) => {
      if (!v.lat || !v.lng) return;
      const latlng = [v.lat, v.lng];
      bounds.push(latlng);

      const popupContent = () => `
        <div class="it-popup">
          <p class="it-popup-name">${v.name}</p>
          ${v.plate ? `<p><b>Plate:</b> ${v.plate}</p>` : ''}
          <p><b>Status:</b> ${v.isOnline ? (v.isMoving ? 'Moving' : 'Idle') : 'Offline'}</p>
          <p><b>Speed:</b> ${formatSpeed(v.speed)}</p>
          ${v.address ? `<p><b>Location:</b> ${v.address}</p>` : ''}
          <p><b>Ignition:</b> ${v.ignition ? 'On' : 'Off'}</p>
          ${v.lastUpdate ? `<p><b>Updated:</b> ${formatTime(v.lastUpdate)}</p>` : ''}
        </div>`;

      if (markersRef.current[v.id]) {
        // Update existing marker
        const marker = markersRef.current[v.id];
        marker.setLatLng(latlng);
        marker.setIcon(vehicleIcon(v));
        marker.getPopup()?.setContent(popupContent());
      } else {
        // Create new marker
        const marker = L.marker(latlng, { icon: vehicleIcon(v) })
          .bindPopup(popupContent, { maxWidth: 240 })
          .addTo(map);
        marker.on('click', () => setSelectedVehicle(v));
        markersRef.current[v.id] = marker;
      }
    });

    // Fit map if we have positions and no user interaction yet
    if (bounds.length > 0 && !selectedVehicle) {
      try { map.fitBounds(bounds, { padding: [32, 32], maxZoom: 15 }); } catch {}
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicles]);

  // ── 5. Focus marker when vehicle selected from list ───────────
  useEffect(() => {
    if (!selectedVehicle || !mapObj.current) return;
    const marker = markersRef.current[selectedVehicle.id];
    if (marker) {
      mapObj.current.setView(marker.getLatLng(), 16, { animate: true });
      marker.openPopup();
    }
  }, [selectedVehicle]);

  // ── Counters ──────────────────────────────────────────────────
  const counters = useMemo(() => ({
    all:     vehicles.length,
    online:  vehicles.filter((v) => v.isOnline).length,
    moving:  vehicles.filter((v) => v.isMoving).length,
    offline: vehicles.filter((v) => !v.isOnline).length,
  }), [vehicles]);

  const filtered = useMemo(() => {
    if (!search.trim()) return vehicles;
    const s = search.trim().toLowerCase();
    return vehicles.filter((v) =>
      v.name.toLowerCase().includes(s) ||
      (v.plate && v.plate.toLowerCase().includes(s))
    );
  }, [vehicles, search]);

  // ── Render ────────────────────────────────────────────────────
  // Note: do NOT early-return before rendering the map div — the map useEffect fires
  // once after mount and needs mapRef.current to be non-null. Loading state is shown
  // inline inside the sidebar so the map container is always in the DOM.
  if (error) return <p className="bt-error">{error}</p>;
  if (!loading && trackerList.length === 0) {
    return <p className="muted">No tracking portals are currently available. Contact your administrator.</p>;
  }

  return (
    <div className="it-dashboard">

      {/* Top bar: tracker selector + counters + sync */}
      <div className="it-topbar">
        {trackerList.length > 1 && (
          <select
            className="it-tracker-select"
            value={activeTrackerId || ''}
            onChange={(e) => { setActiveTrackerId(e.target.value); setSelectedVehicle(null); }}
          >
            {trackerList.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        )}
        {trackerList.length === 1 && (
          <span className="it-tracker-name">{trackerList[0].name}</span>
        )}

        <div className="it-counters">
          <div className="it-counter it-counter--all">
            <span className="it-counter-val">{counters.all}</span>
            <span className="it-counter-lbl">All</span>
          </div>
          <div className="it-counter it-counter--online">
            <span className="it-counter-val">{counters.online}</span>
            <span className="it-counter-lbl">Online</span>
          </div>
          <div className="it-counter it-counter--moving">
            <span className="it-counter-val">{counters.moving}</span>
            <span className="it-counter-lbl">Moving</span>
          </div>
          <div className="it-counter it-counter--offline">
            <span className="it-counter-val">{counters.offline}</span>
            <span className="it-counter-lbl">Offline</span>
          </div>
        </div>

        <div className="it-sync-info">
          {syncing && <span className="it-syncing">Syncing…</span>}
          {!syncing && syncedAt && (
            <span className="it-synced-at">Updated {formatTime(syncedAt)}</span>
          )}
          <button
            type="button"
            className="bt-copy-btn"
            disabled={syncing}
            onClick={() => loadVehicles(activeTrackerId)}
          >
            Refresh
          </button>
        </div>
      </div>

      {syncError && (
        <div className="it-sync-error">
          Sync issue: {syncError}
        </div>
      )}

      {/* Main layout: sidebar + map */}
      <div className="it-body">
        {/* Vehicle list sidebar */}
        <div className="it-sidebar">
          <input
            type="search"
            className="it-search"
            placeholder="Search by name or plate…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="it-vehicle-list">
            {loading && vehicles.length === 0 && (
              <p className="muted" style={{ padding: '12px 14px' }}>Loading vehicles…</p>
            )}
            {!loading && filtered.length === 0 && (
              <p className="muted" style={{ padding: '12px 14px' }}>No vehicles found.</p>
            )}
            {filtered.map((v) => (
              <VehicleRow
                key={v.id}
                v={v}
                selected={selectedVehicle?.id === v.id}
                onClick={() => setSelectedVehicle(v.id === selectedVehicle?.id ? null : v)}
              />
            ))}
          </div>
        </div>

        {/* Map */}
        <div className="it-map-area">
          <div ref={mapRef} className="it-map" />
        </div>
      </div>

      {/* Details panel: selected vehicle */}
      {selectedVehicle && (
        <div className="it-detail-panel">
          <div className="it-detail-header">
            <span className="it-detail-title">
              {statusDot(selectedVehicle)} {selectedVehicle.name}
              {selectedVehicle.plate && <span className="it-vehicle-plate">{selectedVehicle.plate}</span>}
            </span>
            <button type="button" className="it-detail-close" onClick={() => setSelectedVehicle(null)}>✕</button>
          </div>
          <div className="it-detail-grid">
            <div className="it-detail-field"><span>Status</span><strong>{selectedVehicle.isOnline ? (selectedVehicle.isMoving ? 'Moving' : 'Idle') : 'Offline'}</strong></div>
            <div className="it-detail-field"><span>Speed</span><strong>{formatSpeed(selectedVehicle.speed)}</strong></div>
            <div className="it-detail-field"><span>Ignition</span><strong>{selectedVehicle.ignition ? 'On' : 'Off'}</strong></div>
            {selectedVehicle.battery > 0 && <div className="it-detail-field"><span>Battery</span><strong>{selectedVehicle.battery}%</strong></div>}
            {selectedVehicle.signal > 0  && <div className="it-detail-field"><span>Signal</span><strong>{selectedVehicle.signal}</strong></div>}
            {selectedVehicle.mileage > 0 && <div className="it-detail-field"><span>Mileage</span><strong>{selectedVehicle.mileage.toFixed(1)} km</strong></div>}
            <div className="it-detail-field"><span>Coordinates</span><strong>{selectedVehicle.lat.toFixed(6)}, {selectedVehicle.lng.toFixed(6)}</strong></div>
            {selectedVehicle.address && <div className="it-detail-field it-detail-field--wide"><span>Address</span><strong>{selectedVehicle.address}</strong></div>}
            <div className="it-detail-field it-detail-field--wide"><span>Last Update</span><strong>{formatTime(selectedVehicle.lastUpdate)}</strong></div>
          </div>
        </div>
      )}

      {/* Full vehicle table */}
      {vehicles.length > 0 && (
        <div className="it-table-wrap">
          <table className="it-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Plate</th>
                <th>Status</th>
                <th>Speed</th>
                <th>Ignition</th>
                <th>Lat</th>
                <th>Lng</th>
                <th>Last Update</th>
              </tr>
            </thead>
            <tbody>
              {vehicles.map((v) => (
                <tr
                  key={v.id}
                  className={selectedVehicle?.id === v.id ? 'it-table-row--selected' : ''}
                  onClick={() => setSelectedVehicle(v.id === selectedVehicle?.id ? null : v)}
                  style={{ cursor: 'pointer' }}
                >
                  <td>{v.name}</td>
                  <td>{v.plate || '—'}</td>
                  <td>
                    <span className={`it-status-pill ${v.isOnline ? (v.isMoving ? 'it-status-pill--moving' : 'it-status-pill--idle') : 'it-status-pill--offline'}`}>
                      {v.isOnline ? (v.isMoving ? 'Moving' : 'Idle') : 'Offline'}
                    </span>
                  </td>
                  <td>{formatSpeed(v.speed)}</td>
                  <td>{v.ignition ? 'On' : 'Off'}</td>
                  <td>{v.lat ? v.lat.toFixed(5) : '—'}</td>
                  <td>{v.lng ? v.lng.toFixed(5) : '—'}</td>
                  <td>{formatTime(v.lastUpdate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Root component ────────────────────────────────────────────────
const TOOL_COMPONENTS = {
  adjustment:          BillAdjustment,
  calculator:          BillCalculator,
  contract:            ContractEndDate,
  discount:            PercentageDiscount,
  'auto-reply':        AutoReply,
  'link-to-qr':        LinkToQR,
  'imperial-tracking': ImperialTracking,
  ticketing:           Ticketing,
};

export default function BillingTools({ token }) {
  const [activeTool, setActiveTool] = useState('adjustment');
  const ActiveComponent = TOOL_COMPONENTS[activeTool];
  const effectiveToken = token || getSessionToken();

  return (
    <div className="card bt-shell">
      <div className="bt-nav">
        {TOOLS.map((tool) => (
          <button
            key={tool.id}
            type="button"
            className={activeTool === tool.id ? 'bt-nav-btn active' : 'bt-nav-btn'}
            onClick={() => setActiveTool(tool.id)}
          >
            {tool.label}
          </button>
        ))}
      </div>

      <div className="bt-content">
        <div className="bt-content-header">
          <h3>{TOOLS.find((t) => t.id === activeTool)?.label}</h3>
        </div>
        <ActiveComponent key={activeTool} token={effectiveToken} />
      </div>
    </div>
  );
}
