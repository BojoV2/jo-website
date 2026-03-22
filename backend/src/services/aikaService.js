/**
 * Aika168 GPS Tracking Platform Integration Service
 *
 * Protocol:  HTTP POST with application/x-www-form-urlencoded body
 * Responses: XML-wrapped JSON  →  <string xmlns="...">{"key":"value"}</string>
 * Discovery: GET {base}/getapp.aspx  →  plain-text API server address
 *            NOTE: en.aika168.com/getapp.aspx returns HTML (not the API URL).
 *                  Use http://www.aika168.com/getapp.aspx for discovery.
 * Login:     POST {api_server}/Login
 * Fleet:     POST {api_server}/GetCarList (or similar – tried in order)
 *
 * Credentials are NEVER exposed to the frontend.
 */

const APP_KEY   = '7DU2DJFDR8321'; // Platform-hardcoded key (not a secret)
const LOGIN_APP = 'AKSH';
const GMT       = '8:00';          // GMT+8 (Philippines)
const TIMEOUT   = 20_000;

// Candidate discovery URLs tried in order when the configured one returns HTML
const DISCOVERY_FALLBACKS = [
  'http://www.aika168.com/getapp.aspx',
  'https://www.aika168.com/getapp.aspx',
];

// ── In-memory session cache ───────────────────────────────────────
// trackerId → { apiAddress, sessionKey, deviceId, model, expiresAt }
const sessionCache = new Map();
const SESSION_TTL  = 28 * 60 * 1000; // 28 minutes

// ── HTTP helpers ──────────────────────────────────────────────────
async function timedFetch(url, options = {}) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.text();
  } catch (err) {
    const msg = err.message || '';
    if (err.name === 'AbortError' || msg.includes('abort')) {
      throw new Error(`Timeout connecting to ${url} — API port may be blocked`);
    }
    if (msg.includes('ECONNREFUSED') || msg.includes('ECONNRESET')) {
      throw new Error(`Connection refused by ${url} — port not accessible from this server`);
    }
    if (msg.includes('ENOTFOUND') || msg.includes('getaddrinfo')) {
      throw new Error(`Cannot resolve hostname in ${url} — check the Base URL`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function looksLikeHtml(text) {
  const t = text.trimStart();
  return t.startsWith('<!') || t.startsWith('<html') || t.startsWith('<HTML') ||
         t.includes('<!DOCTYPE') || t.includes('<head>') || t.includes('<HEAD>');
}

function looksLikeApiUrl(text) {
  const t = text.trim();
  return /^https?:\/\/.{6,180}$/.test(t) && !t.includes('\n') && !t.includes('<');
}

/**
 * Aika responses: plain JSON or XML-wrapped JSON.
 * <string xmlns="http://tempuri.org/">{"key":"value"}</string>
 */
function parseResponse(text) {
  if (!text || !text.trim()) throw new Error('Empty response from tracking server');
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }
  const m = trimmed.match(/<string[^>]*>([\s\S]*?)<\/string>/i);
  if (m && m[1].trim()) return JSON.parse(m[1].trim());
  throw new Error(`Unexpected response format: ${trimmed.substring(0, 120)}`);
}

async function apiPost(apiAddress, endpoint, payload) {
  const url  = `${apiAddress.replace(/\/$/, '')}/${endpoint}`;
  const body = new URLSearchParams(payload).toString();
  const text = await timedFetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return parseResponse(text);
}

// ── Discovery ─────────────────────────────────────────────────────
/**
 * Fetch the API server address from getapp.aspx.
 * en.aika168.com/getapp.aspx returns HTML (the homepage wrapper) — not the
 * API URL. We fall back to www.aika168.com which returns the plain-text address.
 *
 * @param {string|null} overrideApiUrl  If admin set a direct API URL, use it.
 * @param {string}      baseUrl         Configured portal base URL.
 */
async function discoverApiAddress(overrideApiUrl, baseUrl) {
  // If admin has manually entered the API URL, use it directly — no discovery needed
  if (overrideApiUrl && overrideApiUrl.trim().startsWith('http')) {
    return overrideApiUrl.trim();
  }

  // Build the candidate list: configured URL first, then known fallbacks
  const candidates = [
    `${baseUrl.replace(/\/$/, '')}/getapp.aspx`,
    ...DISCOVERY_FALLBACKS,
  ];

  const tried = [];
  for (const url of candidates) {
    try {
      const text = await timedFetch(url);
      if (looksLikeHtml(text)) {
        tried.push(`${url} → returned HTML page (not an API address)`);
        continue;
      }
      if (looksLikeApiUrl(text)) {
        return text.trim();
      }
      tried.push(`${url} → unrecognised response: ${text.substring(0, 60)}`);
    } catch (err) {
      tried.push(`${url} → ${err.message}`);
    }
  }

  throw new Error(
    `Could not discover Aika168 API server address. Tried:\n` +
    tried.map((t) => `  • ${t}`).join('\n') +
    `\n\nFix: In Admin → Tracking, set the "Direct API URL" field to the ` +
    `address provided by Aika168 support (e.g. http://app.aika168.com:8088/openapiv3.asmx).`
  );
}

// ── Login ─────────────────────────────────────────────────────────
async function doLogin(overrideApiUrl, baseUrl, username, password) {
  const apiAddress = await discoverApiAddress(overrideApiUrl, baseUrl);

  const errors = [];

  for (const loginType of ['0', '1', '2']) {
    try {
      const data = await apiPost(apiAddress, 'Login', {
        Name:      username.trim(),
        Pass:      password,
        LoginType: loginType,
        LoginAPP:  LOGIN_APP,
        GMT,
        Key:       APP_KEY,
      });

      const sessionKey = data?.deviceInfo?.key2018;
      if (!sessionKey) {
        const hint = data?.result || data?.msg || data?.message || JSON.stringify(data).substring(0, 80);
        errors.push(`LoginType ${loginType}: server rejected — ${hint}`);
        continue;
      }

      return {
        apiAddress,
        sessionKey,
        deviceId:   data.deviceInfo?.deviceID   ?? null,
        deviceName: data.deviceInfo?.deviceName  ?? '',
        model:      data.deviceInfo?.model       ?? 0,
        loginType,
      };
    } catch (err) {
      errors.push(`LoginType ${loginType}: ${err.message}`);
      // Network errors won't be fixed by retrying with a different LoginType
      if (err.message.includes('refused') || err.message.includes('Timeout') ||
          err.message.includes('blocked')  || err.message.includes('Cannot resolve')) {
        throw new Error(
          `Network error reaching API server (${apiAddress}): ${err.message}\n` +
          `If port 8088 is blocked by your firewall, ask Aika168 support for an ` +
          `alternative HTTPS API endpoint and enter it in the "Direct API URL" field.`
        );
      }
    }
  }

  throw new Error(`Authentication failed — ${errors.join(' | ')}`);
}

// ── Fleet vehicle list ────────────────────────────────────────────
const FLEET_ENDPOINTS = [
  'GetCarList',
  'GetDeviceList',
  'GetUserDeviceList',
  'GetAllDeviceGPS',
  'GetMassLocation',
];

async function tryFleetEndpoints(apiAddress, sessionKey) {
  for (const ep of FLEET_ENDPOINTS) {
    try {
      const data = await apiPost(apiAddress, ep, { Key: sessionKey });
      let list = null;
      if (Array.isArray(data))               list = data;
      else if (Array.isArray(data?.carList)) list = data.carList;
      else if (Array.isArray(data?.list))    list = data.list;
      else if (Array.isArray(data?.devices)) list = data.devices;
      else if (Array.isArray(data?.data))    list = data.data;
      if (list && list.length > 0) return { endpoint: ep, vehicles: list };
    } catch {
      // Try next endpoint
    }
  }
  return null;
}

// ── Single-device tracking ────────────────────────────────────────
async function fetchSingleTracking(apiAddress, sessionKey, deviceId, model) {
  return apiPost(apiAddress, 'GetTracking', {
    DeviceID:  String(deviceId),
    Model:     String(model || 0),
    TimeZones: GMT,
    MapType:   'Google',
    Language:  'en',
    Key:       sessionKey,
  });
}

// ── Normalise raw vehicle record ──────────────────────────────────
function normaliseVehicle(raw) {
  const speedVal = parseFloat(raw.speed || raw.Speed || 0);
  const stateStr = String(raw.state || raw.acc || raw.ACC || '').toLowerCase();
  const isOnline =
    raw.isOnline !== undefined ? Boolean(Number(raw.isOnline)) :
    raw.online   !== undefined ? Boolean(Number(raw.online))   :
    raw.Status   === 'online'  ? true :
    raw.status   === 'online'  ? true : false;

  return {
    id:          String(raw.deviceID || raw.DeviceID || raw.id || raw.ID || ''),
    name:        raw.deviceName || raw.DeviceName || raw.name || raw.carName || raw.CarName || `Device ${raw.deviceID || raw.id}`,
    plate:       raw.licensePlate || raw.LicensePlate || raw.plate || raw.carNum || raw.CarNum || '',
    imei:        raw.IMEI || raw.imei || '',
    lat:         parseFloat(raw.lat  || raw.Lat  || raw.latitude  || 0),
    lng:         parseFloat(raw.lng  || raw.Lng  || raw.longitude || 0),
    speed:       speedVal,
    course:      parseInt(raw.course || raw.Course || raw.direction || 0, 10),
    isOnline,
    isMoving:    speedVal > 0 && !Boolean(Number(raw.is_stop ?? raw.isStop ?? 0)),
    ignition:    stateStr.includes('acc on') || Boolean(Number(raw.ACC ?? raw.acc ?? 0)),
    battery:     parseInt(raw.battery || raw.Battery || raw.voltage || 0, 10),
    batteryStatus: raw.batteryStatus || raw.battery_status || '',
    signal:      parseInt(raw.signalStrength || raw.signal || 0, 10),
    address:     raw.address || raw.Address || raw.addr || raw.location || '',
    lastUpdate:  raw.position_time || raw.positionTime || raw.updateTime || raw.lastUpdate || raw.LastUpdate || null,
    mileage:     parseFloat(raw.mileage || raw.totalMileage || raw.Mileage || 0),
  };
}

// ── Main export ───────────────────────────────────────────────────
export async function getVehicleData(trackerId, config) {
  const { base_url, username, password, api_url } = config;
  if (!username || !password) throw new Error('Tracker credentials not configured');

  let session = sessionCache.get(trackerId);
  if (!session || Date.now() > session.expiresAt) {
    session = await doLogin(api_url || null, base_url, username, password);
    session.expiresAt = Date.now() + SESSION_TTL;
    sessionCache.set(trackerId, session);
  }

  const { apiAddress, sessionKey, deviceId, model } = session;

  const fleet = await tryFleetEndpoints(apiAddress, sessionKey);
  if (fleet) {
    return { source: fleet.endpoint, vehicles: fleet.vehicles.map(normaliseVehicle) };
  }

  if (deviceId) {
    const raw = await fetchSingleTracking(apiAddress, sessionKey, deviceId, model);
    return { source: 'GetTracking', vehicles: [normaliseVehicle({ deviceID: deviceId, ...raw })] };
  }

  throw new Error(
    'Login succeeded but no vehicle data found. ' +
    'Fleet endpoint not available and no device ID returned from login. ' +
    'Contact Aika168 to confirm account type and fleet API endpoint name.'
  );
}

export function invalidateSession(trackerId) {
  sessionCache.delete(trackerId);
}
