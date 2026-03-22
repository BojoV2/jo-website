import { useState, useEffect, useCallback } from 'react';
import { apiRequest, getApiBase } from '../api.js';
import QRCode from 'qrcode';

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
  { id: 'adjustment',  label: 'Bill Adjustment'     },
  { id: 'calculator',  label: 'Bill Calculator'     },
  { id: 'contract',    label: 'Contract End Date'   },
  { id: 'discount',    label: 'Percentage Discount' },
  { id: 'auto-reply',  label: 'Auto Reply'          },
  { id: 'link-to-qr', label: 'Link to QR'          },
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

// ── Root component ────────────────────────────────────────────────
const TOOL_COMPONENTS = {
  adjustment:    BillAdjustment,
  calculator:    BillCalculator,
  contract:      ContractEndDate,
  discount:      PercentageDiscount,
  'auto-reply':  AutoReply,
  'link-to-qr':  LinkToQR,
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
