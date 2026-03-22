/**
 * Aika168 GPS Tracking Platform Integration Service
 *
 * Protocol:  HTTP POST with application/x-www-form-urlencoded body
 * Responses: XML-wrapped JSON  →  <string xmlns="...">{"key":"value"}</string>
 * Discovery: GET {base_url}/getapp.aspx  →  returns actual API server address
 * Login:     POST {api_server}/Login     →  returns session key in deviceInfo.key2018
 * Tracking:  POST {api_server}/GetTracking
 * Fleet:     POST {api_server}/GetCarList (or similar – tried in order)
 *
 * Credentials are NEVER exposed to the frontend.
 */

const APP_KEY   = '7DU2DJFDR8321'; // Hardcoded by the platform (not our secret)
const LOGIN_APP = 'AKSH';
const GMT       = '8:00';          // GMT+8 (Philippines)
const TIMEOUT   = 15_000;

// ── In-memory session cache ───────────────────────────────────────
// trackerId → { apiAddress, sessionKey, deviceId, model, expiresAt }
const sessionCache = new Map();
const SESSION_TTL  = 28 * 60 * 1000; // 28 minutes (server sessions ~30 min)

// ── HTTP helpers ──────────────────────────────────────────────────
async function timedFetch(url, options = {}) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Aika responses are either plain JSON or JSON wrapped in an XML string element.
 * <string xmlns="http://tempuri.org/">{"key":"value"}</string>
 */
function parseResponse(text) {
  if (!text || !text.trim()) throw new Error('Empty response from tracking server');
  const trimmed = text.trim();

  // Plain JSON
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }

  // XML-wrapped: extract content of first <string> element
  const m = trimmed.match(/<string[^>]*>([\s\S]*?)<\/string>/i);
  if (m && m[1].trim()) {
    return JSON.parse(m[1].trim());
  }

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
async function discoverApiAddress(baseUrl) {
  const url  = `${baseUrl.replace(/\/$/, '')}/getapp.aspx`;
  const text = await timedFetch(url);
  const addr = text.trim();
  if (!addr || addr.length < 10) throw new Error('Failed to discover API address from tracking server');
  return addr;
}

// ── Login ─────────────────────────────────────────────────────────
async function doLogin(baseUrl, username, password) {
  const apiAddress = await discoverApiAddress(baseUrl);

  // Try account login (LoginType 0 = fleet/account, 1 = IMEI/device)
  for (const loginType of ['0', '1']) {
    try {
      const data = await apiPost(apiAddress, 'Login', {
        Name:      username,
        Pass:      password,
        LoginType: loginType,
        LoginAPP:  LOGIN_APP,
        GMT,
        Key:       APP_KEY,
      });

      const sessionKey = data?.deviceInfo?.key2018;
      if (!sessionKey) continue; // Try next type

      return {
        apiAddress,
        sessionKey,
        deviceId:   data.deviceInfo?.deviceID   ?? null,
        deviceName: data.deviceInfo?.deviceName  ?? '',
        model:      data.deviceInfo?.model       ?? 0,
        loginType,
      };
    } catch {
      // Try next loginType
    }
  }
  throw new Error('Login failed — check username and password in tracker settings');
}

// ── Fleet vehicle list ────────────────────────────────────────────
// The fleet endpoint name varies by platform build. We try known names in order.
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

      // Normalise response shape to an array
      let list = null;
      if (Array.isArray(data))               list = data;
      else if (Array.isArray(data?.carList)) list = data.carList;
      else if (Array.isArray(data?.list))    list = data.list;
      else if (Array.isArray(data?.devices)) list = data.devices;
      else if (Array.isArray(data?.data))    list = data.data;

      if (list && list.length > 0) {
        return { endpoint: ep, vehicles: list };
      }
    } catch {
      // Try next
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

// ── Normalise raw vehicle record to our internal shape ────────────
function normaliseVehicle(raw) {
  const speedVal = parseFloat(raw.speed || raw.Speed || 0);
  const stateStr = String(raw.state || raw.acc || raw.ACC || '').toLowerCase();

  // isOnline: prefer explicit field; fall back to "has recent position"
  const isOnline =
    raw.isOnline !== undefined ? Boolean(Number(raw.isOnline)) :
    raw.online   !== undefined ? Boolean(Number(raw.online))   :
    raw.Status === 'online'    ? true                          :
    raw.status === 'online'    ? true                          :
    false;

  return {
    id:           String(raw.deviceID || raw.DeviceID || raw.id || raw.ID || ''),
    name:         raw.deviceName || raw.DeviceName || raw.name || raw.carName || raw.CarName || `Device ${raw.deviceID || raw.id}`,
    plate:        raw.licensePlate || raw.LicensePlate || raw.plate || raw.carNum || raw.CarNum || '',
    imei:         raw.IMEI || raw.imei || '',
    lat:          parseFloat(raw.lat  || raw.Lat  || raw.latitude  || 0),
    lng:          parseFloat(raw.lng  || raw.Lng  || raw.longitude || 0),
    speed:        speedVal,
    course:       parseInt(raw.course || raw.Course || raw.direction || 0, 10),
    isOnline,
    isMoving:     speedVal > 0 && !Boolean(Number(raw.is_stop ?? raw.isStop ?? 0)),
    ignition:     stateStr.includes('acc on') || Boolean(Number(raw.ACC ?? raw.acc ?? 0)),
    battery:      parseInt(raw.battery || raw.Battery || raw.voltage || 0, 10),
    batteryStatus:raw.batteryStatus || raw.battery_status || '',
    signal:       parseInt(raw.signalStrength || raw.signal || 0, 10),
    address:      raw.address || raw.Address || raw.addr || raw.location || '',
    lastUpdate:   raw.position_time || raw.positionTime || raw.updateTime || raw.lastUpdate || raw.LastUpdate || null,
    mileage:      parseFloat(raw.mileage || raw.totalMileage || raw.Mileage || 0),
  };
}

// ── Main export: get all vehicle data for a tracker config ────────
export async function getVehicleData(trackerId, config) {
  const { base_url, username, password } = config;
  if (!username || !password) throw new Error('Tracker credentials not configured');

  // Re-use cached session if valid
  let session = sessionCache.get(trackerId);
  if (!session || Date.now() > session.expiresAt) {
    session = await doLogin(base_url, username, password);
    session.expiresAt = Date.now() + SESSION_TTL;
    sessionCache.set(trackerId, session);
  }

  const { apiAddress, sessionKey, deviceId, model } = session;

  // 1. Try fleet endpoint
  const fleet = await tryFleetEndpoints(apiAddress, sessionKey);
  if (fleet) {
    return {
      source:   fleet.endpoint,
      vehicles: fleet.vehicles.map(normaliseVehicle),
    };
  }

  // 2. Fall back to single-device if login gave us a deviceId
  if (deviceId) {
    const raw = await fetchSingleTracking(apiAddress, sessionKey, deviceId, model);
    return {
      source:   'GetTracking',
      vehicles: [normaliseVehicle({ deviceID: deviceId, ...raw })],
    };
  }

  throw new Error('No fleet endpoint available and no device ID from login. Check credentials and account type.');
}

/** Call this when credentials change so stale session is discarded */
export function invalidateSession(trackerId) {
  sessionCache.delete(trackerId);
}
