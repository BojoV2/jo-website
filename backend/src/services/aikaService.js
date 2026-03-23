/**
 * Aika168 GPS Tracking Platform Integration Service
 *
 * LOGIN MODES
 * ───────────
 * account  (login_mode = 'account')
 *   LoginType=0, Name=username, Pass=accountPassword
 *   Response: {"state":"0","userInfo":{"userID":"...","userName":"...","p":"<token>",...}}
 *   Session token: userInfo.p (or loginKey / key2018 / key as fallbacks)
 *   Data: fleet endpoints → GetCarList etc → normalised vehicle list
 *
 * device   (login_mode = 'device')
 *   LoginType=1 first, then LoginType=2 as fallback
 *   Name=deviceID, Pass=devicePassword (factory default: 123456)
 *   Response: {"state":"0","deviceInfo":{"deviceID":"...","key2018":"<token>",...}}
 *   Session token: deviceInfo.key2018 (or p / token as fallbacks)
 *   Data: GetTracking for the single device
 *
 * FALLBACK CHAIN (when primary API server on port 8088 is unreachable)
 * ─────────────────────────────────────────────────────────────────────
 * B.5  Try portal ASMX with p token as JSON parameter (no cookies needed)
 * B.7  GET Monitor.aspx with id/n/p token → capture FormsAuth cookies → ASMX
 * B    Full ASP.NET WebForms login scraping → ASMX (last resort)
 *
 * Credentials are NEVER exposed to the frontend.
 */

const APP_KEY   = '7DU2DJFDR8321'; // Platform-hardcoded key (not a secret)
const LOGIN_APP = 'AKSH';
const GMT       = '8:00';          // GMT+8 (Philippines)
const TIMEOUT   = 20_000;

const DISCOVERY_FALLBACKS = [
  'http://www.aika168.com/getapp.aspx',
  'https://www.aika168.com/getapp.aspx',
];

const PORTAL_BASE = 'https://en.aika168.com';

// ── In-memory session cache ───────────────────────────────────────
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
      throw new Error(`Cannot resolve hostname in ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function timedFetchFull(url, options = {}) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal, redirect: 'manual' });
    const text = await res.text().catch(() => '');
    const setCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    return { text, setCookies, status: res.status, location: res.headers.get('location') || null };
  } catch (err) {
    const msg = err.message || '';
    if (err.name === 'AbortError' || msg.includes('abort')) throw new Error(`Timeout connecting to ${url}`);
    if (msg.includes('ECONNREFUSED') || msg.includes('ECONNRESET')) throw new Error(`Connection refused by ${url}`);
    if (msg.includes('ENOTFOUND') || msg.includes('getaddrinfo')) throw new Error(`Cannot resolve hostname in ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Cookie utilities ──────────────────────────────────────────────
function parseCookies(headers) {
  const jar = new Map();
  for (const h of headers) {
    const m = h.match(/^([^=]+)=([^;]*)/);
    if (m) jar.set(m[1].trim(), m[2].trim());
  }
  return jar;
}
function serializeCookies(jar) {
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}
function mergeCookies(jar, incoming) {
  for (const [k, v] of incoming) jar.set(k, v);
  return jar;
}

// ── Response parsing ──────────────────────────────────────────────
function looksLikeHtml(text) {
  const t = text.trimStart();
  return t.startsWith('<!') || t.startsWith('<html') || t.startsWith('<HTML') ||
         t.includes('<!DOCTYPE') || t.includes('<head>') || t.includes('<HEAD>');
}
function looksLikeApiUrl(text) {
  const t = text.trim();
  return /^https?:\/\/.{6,180}$/.test(t) && !t.includes('\n') && !t.includes('<');
}

function parseApiResponse(text) {
  if (!text || !text.trim()) throw new Error('Empty response from tracking server');
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) return JSON.parse(t);
  const m = t.match(/<string[^>]*>([\s\S]*?)<\/string>/i);
  if (m && m[1].trim()) return JSON.parse(m[1].trim());
  throw new Error(`Unexpected response format: ${t.substring(0, 120)}`);
}

async function apiPost(apiAddress, endpoint, payload) {
  const url  = `${apiAddress.replace(/\/$/, '')}/${endpoint}`;
  const body = new URLSearchParams(payload).toString();
  const text = await timedFetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return parseApiResponse(text);
}

// ── Discovery ─────────────────────────────────────────────────────
async function discoverApiAddress(overrideApiUrl, baseUrl) {
  if (overrideApiUrl && overrideApiUrl.trim().startsWith('http')) {
    const normalized = overrideApiUrl.trim();
    const lowered = normalized.toLowerCase();

    if (
      lowered.includes('/monitor.aspx') ||
      lowered.includes('/index.aspx') ||
      lowered.includes('/geofences') ||
      lowered.includes('/login.aspx')
    ) {
      throw new Error(
        `Direct API URL is set to an Aika168 portal page, not the API endpoint: ${normalized}\n` +
        `Clear the Direct API URL field or replace it with the real API endpoint ` +
        `(for this tenant: http://app.aika168.com:8088/openapiv3.asmx).`
      );
    }

    return normalized;
  }

  const candidates = [
    `${baseUrl.replace(/\/$/, '')}/getapp.aspx`,
    ...DISCOVERY_FALLBACKS,
  ];

  const tried = [];
  for (const url of candidates) {
    try {
      const text = await timedFetch(url);
      if (looksLikeHtml(text)) { tried.push(`${url} → returned HTML`); continue; }
      if (looksLikeApiUrl(text)) return text.trim();
      tried.push(`${url} → unrecognised: ${text.substring(0, 60)}`);
    } catch (err) {
      tried.push(`${url} → ${err.message}`);
    }
  }

  throw new Error(
    `Could not discover Aika168 API server address.\nTried:\n` +
    tried.map((t) => `  • ${t}`).join('\n') +
    `\n\nFix: Set the "Direct API URL" in Admin → Tracking (ask Aika168 support for it).`
  );
}

// ── JS-redirect login response parser ────────────────────────────
/**
 * Some Aika168 platform versions respond to the Login endpoint with a JavaScript
 * redirect instead of XML/JSON, e.g.:
 *   <script language="javascript">
 *     top.location.href='/Index.aspx?ReturnUrl=%2fMonitor.aspx%3fid%3d168414%26n%3dIMPERIALNETWORKINC%26p%3d1G3K8O...'
 *   </script>
 *
 * This IS a successful login — the server encodes userId, userName and the session
 * token (p=) in the Monitor.aspx redirect URL.  Parse them out and treat as a
 * successful login response.
 */
function parseJsRedirectLogin(text) {
  // Extract the href value from the script tag
  const hrefMatch = text.match(/top\.location\.href\s*=\s*['"]([^'"]+)['"]/);
  if (!hrefMatch) return null;

  const href = hrefMatch[1];

  // href is typically: /Index.aspx?ReturnUrl=%2fMonitor.aspx%3fid%3d...
  // Decode the ReturnUrl and then parse its query parameters
  const returnUrlMatch = href.match(/[?&]ReturnUrl=([^&'"]+)/i);
  const monitorUrl = returnUrlMatch
    ? decodeURIComponent(returnUrlMatch[1])
    : href; // fall back to parsing the href directly

  const idMatch  = monitorUrl.match(/[?&]id=(\d+)/);
  const nMatch   = monitorUrl.match(/[?&]n=([^&]+)/);
  const pMatch   = monitorUrl.match(/[?&]p=([^&'"]+)/);

  if (!pMatch) return null; // no session token — not a login success redirect

  return {
    userId:     idMatch ? idMatch[1] : null,
    userName:   nMatch  ? decodeURIComponent(nMatch[1]) : '',
    sessionKey: decodeURIComponent(pMatch[1]),
  };
}

// ── Login ─────────────────────────────────────────────────────────
/**
 * @param {string|null} overrideApiUrl  Admin-supplied direct API URL (skips discovery)
 * @param {string}      baseUrl         Provider base URL for discovery
 * @param {'account'|'device'} loginMode
 * @param {string}      identifier      username (account) or device ID (device)
 * @param {string}      password
 */
async function doLogin(overrideApiUrl, baseUrl, loginMode, identifier, password) {
  const apiAddress = await discoverApiAddress(overrideApiUrl, baseUrl);
  const errors     = [];

  // account → try LoginType 0 only
  // device  → try LoginType 1 first, then 2 as fallback
  const loginTypes = loginMode === 'device' ? ['1', '2'] : ['0'];

  for (const loginType of loginTypes) {
    try {
      // Use raw fetch so we can inspect the response before parsing
      const url      = `${apiAddress.replace(/\/$/, '')}/Login`;
      const rawText  = await timedFetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({
          Name: identifier.trim(), Pass: password, LoginType: loginType,
          LoginAPP: LOGIN_APP, GMT, Key: APP_KEY,
        }).toString(),
      });

      // ── Try standard JSON/XML response first ──────────────────
      let data = null;
      try {
        data = parseApiResponse(rawText);
      } catch {
        // ── Try JavaScript redirect response ──────────────────
        // e.g. <script>top.location.href='/Index.aspx?ReturnUrl=%2fMonitor.aspx%3fid%3d...'</script>
        // This is actually a successful login — the p= token is in the redirect URL.
        const jsLogin = parseJsRedirectLogin(rawText);
        if (jsLogin) {
          return {
            kind: 'api', loginMode, apiAddress,
            sessionKey: jsLogin.sessionKey,
            userId:     jsLogin.userId,
            userName:   jsLogin.userName,
            deviceId:   null,
            deviceName: '',
            model:      0,
            loginType,
          };
        }
        // Not a recognised format — surface the raw text for diagnosis
        errors.push(
          `LoginType ${loginType}: unrecognised response format. ` +
          `Raw (first 200 chars): ${rawText.substring(0, 200)}`
        );
        continue;
      }

      const stateOk = String(data?.state) === '0';

      // For device login: prefer deviceInfo keys. For account login: prefer userInfo keys.
      // Check all known field locations across platform versions.
      const sessionKey =
        data?.deviceInfo?.key2018 ||
        data?.deviceInfo?.p       ||
        data?.deviceInfo?.token   ||
        data?.userInfo?.loginKey  ||
        data?.userInfo?.key2018   ||
        data?.userInfo?.key       ||
        data?.userInfo?.p         ||  // visible as ?p= in Monitor.aspx URLs
        data?.key2018             ||
        data?.token               ||
        null;

      const userId     = data?.userInfo?.userID    || data?.deviceInfo?.deviceID  || null;
      const userName   = data?.userInfo?.userName  || data?.deviceInfo?.deviceName || '';
      const deviceId   = data?.deviceInfo?.deviceID   ?? null;
      const deviceName = data?.deviceInfo?.deviceName ?? '';
      const model      = data?.deviceInfo?.model      ?? 0;

      if (stateOk && sessionKey) {
        return { kind: 'api', loginMode, apiAddress, sessionKey, userId, userName, deviceId, deviceName, model, loginType };
      }

      if (stateOk && !sessionKey) {
        errors.push(
          `LoginType ${loginType}: server accepted login (state=0, user="${userName}", id=${userId}) ` +
          `but session key was not found in response. Full response: ${JSON.stringify(data)}\n` +
          `Known key fields checked: deviceInfo.key2018, deviceInfo.p, userInfo.loginKey, userInfo.key2018, userInfo.key, userInfo.p, key2018, token.`
        );
        continue;
      }

      // state != 0 means rejection
      errors.push(`LoginType ${loginType}: rejected — state=${data?.state} — full: ${JSON.stringify(data)}`);

    } catch (err) {
      errors.push(`LoginType ${loginType}: ${err.message}`);
      // Bail immediately on network-level failures — no point trying more LoginTypes
      if (err.message.includes('refused') || err.message.includes('Timeout') ||
          err.message.includes('blocked')  || err.message.includes('Cannot resolve')) {
        throw new Error(
          `Cannot reach API server at ${apiAddress}: ${err.message}\n` +
          `If port 8088 is blocked, ask Aika168 support for an HTTPS API endpoint and ` +
          `enter it in Admin → Tracking → Direct API URL.`
        );
      }
    }
  }

  throw new Error(
    `Authentication failed (login_mode=${loginMode}):\n` + errors.join('\n')
  );
}

// ── Fleet endpoints (account mode) ───────────────────────────────
const FLEET_ENDPOINTS = [
  'GetCarList', 'GetUserDeviceList',
  'GetAllDeviceGPS', 'GetMassLocation', 'GetUserDevice', 'GetDeviceByUser',
];

async function tryFleetEndpoints(apiAddress, sessionKey, userId) {
  const payloads = [
    { Key: sessionKey },
    { Key: sessionKey, UserID: userId },
    { Key: sessionKey, userID: userId },
  ];

  for (const ep of FLEET_ENDPOINTS) {
    for (const payload of payloads) {
      if ((payload.UserID || payload.userID) && !userId) continue;
      try {
        const data = await apiPost(apiAddress, ep, payload);
        let list = null;
        if (Array.isArray(data))                  list = data;
        else if (Array.isArray(data?.carList))    list = data.carList;
        else if (Array.isArray(data?.list))       list = data.list;
        else if (Array.isArray(data?.devices))    list = data.devices;
        else if (Array.isArray(data?.data))       list = data.data;
        else if (Array.isArray(data?.deviceList)) list = data.deviceList;
        else if (Array.isArray(data?.cars))       list = data.cars;
        else if (Array.isArray(data?.arr))        list = data.arr;
        if (list && list.length > 0) return { endpoint: ep, vehicles: list };
      } catch { /* Try next */ }
    }
  }
  return null;
}

// ── GetDeviceList + GetTracking (this platform's account-mode path) ──
// GetDeviceList requires extra params and returns no GPS; we enrich each
// device with a GetTracking call so callers get full lat/lng data.
async function tryGetDeviceListWithTracking(apiAddress, sessionKey, userId) {
  if (!userId) return null;
  let data;
  try {
    data = await apiPost(apiAddress, 'GetDeviceList', {
      Key: sessionKey, ID: userId,
      PageNo: 1, PageCount: 100,
      TypeID: 0, IsAll: 'true', Language: 'en',
    });
  } catch { return null; }

  const devices = Array.isArray(data?.arr) ? data.arr : null;
  if (!devices || devices.length === 0) return null;

  // Enrich each device with live GPS from GetTracking (parallel, non-fatal)
  const enriched = await Promise.all(devices.map(async (dev) => {
    try {
      const gps = await apiPost(apiAddress, 'GetTracking', {
        DeviceID: String(dev.id), Model: String(dev.model || 0),
        TimeZones: GMT, MapType: 'Google', Language: 'en', Key: sessionKey,
      });
      return { deviceID: dev.id, deviceName: dev.name, model: dev.model,
               sn: dev.sn, ...gps };
    } catch {
      return { deviceID: dev.id, deviceName: dev.name, model: dev.model, sn: dev.sn };
    }
  }));

  return { endpoint: 'GetDeviceList+GetTracking', vehicles: enriched };
}

// ── Single-device tracking (both modes) ──────────────────────────
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

// ── Portal ASMX helper ────────────────────────────────────────────
async function portalAsmxPost(endpoint, jsonBody, cookies) {
  const url = `${PORTAL_BASE}/Ajax/${endpoint}`;
  const UA  = 'Mozilla/5.0 (compatible; JOBorder-Tracker/1.0)';
  const headers = {
    'Content-Type':     'application/json; charset=utf-8',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent':       UA,
    'Referer':          `${PORTAL_BASE}/Monitor.aspx`,
  };
  if (cookies) headers['Cookie'] = cookies;

  const text   = await timedFetch(url, { method: 'POST', headers, body: JSON.stringify(jsonBody) });
  const parsed = JSON.parse(text);
  let raw = parsed?.d;
  if (typeof raw === 'string') try { raw = JSON.parse(raw); } catch { /* ok */ }
  return raw;
}

function extractVehicleList(raw) {
  let list = null;
  if (Array.isArray(raw))                  list = raw;
  else if (Array.isArray(raw?.carList))    list = raw.carList;
  else if (Array.isArray(raw?.list))       list = raw.list;
  else if (Array.isArray(raw?.devices))    list = raw.devices;
  else if (Array.isArray(raw?.data))       list = raw.data;
  else if (Array.isArray(raw?.deviceList)) list = raw.deviceList;
  else if (Array.isArray(raw?.arr))        list = raw.arr;
  return list && list.length > 0 ? list : null;
}

// ── B.5: Portal ASMX with p-token (no cookies) ───────────────────
async function tryPortalAsmxWithToken(sessionKey, userId) {
  // Try passing the p token as a JSON parameter — some platform versions accept it
  const variants = [
    { UserID: parseInt(userId) || 0, Key: sessionKey, isFirst: 1, TimeZones: GMT, DeviceID: 0 },
    { UserID: parseInt(userId) || 0, p:   sessionKey, isFirst: 1, TimeZones: GMT, DeviceID: 0 },
    { UserID: parseInt(userId) || 0,                  isFirst: 1, TimeZones: GMT, DeviceID: 0 },
  ];
  for (const body of variants) {
    try {
      const raw  = await portalAsmxPost('DevicesAjax.asmx/GetDevicesByUserID', body, null);
      const list = extractVehicleList(raw);
      if (list) return { endpoint: 'GetDevicesByUserID (portal/token)', vehicles: list };
    } catch { /* try next */ }
  }
  return null;
}

// ── B.7: Exchange p-token via Monitor.aspx for FormsAuth cookies ──
async function exchangeTokenForPortalCookies(userId, userName, pToken) {
  const jar  = new Map();
  const UA   = 'Mozilla/5.0 (compatible; JOBorder-Tracker/1.0)';
  const n    = (userName || '').replace(/\s+/g, '').toUpperCase();
  const url  = `${PORTAL_BASE}/Monitor.aspx?id=${encodeURIComponent(userId)}&n=${encodeURIComponent(n)}&p=${encodeURIComponent(pToken)}`;

  async function followRedirects(startUrl, startCookies, depth = 0) {
    if (depth > 3) return;
    const r = await timedFetchFull(startUrl, { headers: { 'User-Agent': UA, 'Cookie': startCookies } });
    mergeCookies(jar, parseCookies(r.setCookies));
    if ((r.status === 301 || r.status === 302) && r.location) {
      const next = r.location.startsWith('http') ? r.location
        : `${PORTAL_BASE}${r.location.startsWith('/') ? '' : '/'}${r.location}`;
      try { await followRedirects(next, serializeCookies(jar), depth + 1); } catch { /* ok */ }
    }
  }

  await followRedirects(url, '');
  if (jar.size === 0) throw new Error('Monitor.aspx token exchange: no cookies returned');
  return serializeCookies(jar);
}

// ── B: Full WebForms portal login ─────────────────────────────────
async function portalLogin(username, password) {
  const jar      = new Map();
  const loginUrl = `${PORTAL_BASE}/Index.aspx`;
  const UA       = 'Mozilla/5.0 (compatible; JOBorder-Tracker/1.0)';

  // Step 1: GET login page
  const s1 = await timedFetchFull(loginUrl, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } });
  mergeCookies(jar, parseCookies(s1.setCookies));

  let loginHtml = s1.text;
  if ((s1.status === 301 || s1.status === 302) && s1.location) {
    const redir = s1.location.startsWith('http') ? s1.location
      : `${PORTAL_BASE}${s1.location.startsWith('/') ? '' : '/'}${s1.location}`;
    const s1b = await timedFetchFull(redir, { headers: { 'User-Agent': UA, 'Cookie': serializeCookies(jar) } });
    mergeCookies(jar, parseCookies(s1b.setCookies));
    loginHtml = s1b.text;
  }

  // Extract ASP.NET hidden fields
  const vs  = (loginHtml.match(/id="__VIEWSTATE"\s+value="([^"]*)"/)         || ['',''])[1];
  const vsg = (loginHtml.match(/id="__VIEWSTATEGENERATOR"\s+value="([^"]*)"/) || ['',''])[1];
  const ev  = (loginHtml.match(/id="__EVENTVALIDATION"\s+value="([^"]*)"/)    || ['',''])[1];

  // Detect field names
  const uf = (loginHtml.match(/name="([^"]*(?:txtUser|txtAccount|txtName|txtLogin)[^"]*)"/i) || ['','txtUserName'])[1];
  const pf = (loginHtml.match(/name="([^"]*(?:txtPass)[^"]*)"/i)                            || ['','txtPassword'])[1];
  const bf = (loginHtml.match(/name="([^"]*(?:btnLogin|btnSubmit|btnEnter)[^"]*)"/i)         || ['','btnLogin'])[1];

  // Step 2: POST login form
  const formBody = new URLSearchParams({
    __VIEWSTATE: vs, __VIEWSTATEGENERATOR: vsg, __EVENTVALIDATION: ev,
    [uf]: username.trim(), [pf]: password, [bf]: 'Login',
  });

  const s2 = await timedFetchFull(loginUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie':       serializeCookies(jar),
      'Referer':      loginUrl,
      'User-Agent':   UA,
    },
    body: formBody.toString(),
  });
  mergeCookies(jar, parseCookies(s2.setCookies));

  // Step 3: follow redirect to pick up session cookies and extract userId
  let userId = null;
  if (s2.location) {
    const idMatch = s2.location.match(/[?&]id=(\d+)/);
    if (idMatch) userId = idMatch[1];

    const fullTarget = s2.location.startsWith('http') ? s2.location
      : `${PORTAL_BASE}${s2.location.startsWith('/') ? '' : '/'}${s2.location}`;
    try {
      const s3 = await timedFetchFull(fullTarget, { headers: { 'User-Agent': UA, 'Cookie': serializeCookies(jar) } });
      mergeCookies(jar, parseCookies(s3.setCookies));
      if (!userId) {
        const m = (s3.text + (s3.location || '')).match(/[?&]id=(\d+)/);
        if (m) userId = m[1];
      }
    } catch { /* non-fatal */ }
  }

  const cookieNames = Array.from(jar.keys()).join(', ');
  if (jar.size === 0) {
    throw new Error('Portal WebForms login returned no cookies — login may have failed.');
  }

  return { kind: 'portal', portalCookies: serializeCookies(jar), userId, _cookieNames: cookieNames };
}

// ── Portal ASMX: get fleet by userId ─────────────────────────────
// sessionKey is optional — when provided, also retries with Key/p in the body
// (the portal JavaScript always sends the session token in every ASMX request body)
async function portalGetDevices(portalCookies, userId, cookieNames, sessionKey = null) {
  const base = { UserID: parseInt(userId) || 0, isFirst: 1, TimeZones: GMT, DeviceID: 0 };
  const bodies = sessionKey
    ? [base, { ...base, Key: sessionKey }, { ...base, p: sessionKey }]
    : [base];

  let lastErr;
  for (const body of bodies) {
    try {
      const raw  = await portalAsmxPost('DevicesAjax.asmx/GetDevicesByUserID', body, portalCookies);
      const list = extractVehicleList(raw);
      if (!list) throw new Error(`No vehicles in response: ${JSON.stringify(raw).substring(0, 200)}`);
      return { endpoint: 'GetDevicesByUserID (portal)', vehicles: list };
    } catch (err) { lastErr = err; }
  }
  throw new Error(
    `Portal ASMX GetDevicesByUserID failed (userId=${userId}): ${lastErr.message}. ` +
    `Cookies captured: [${cookieNames || 'none'}]. ` +
    `If this error persists, ask Aika168 support for a direct HTTPS API URL and enter it in Admin → Tracking → Direct API URL.`
  );
}

// ── Portal ASMX: get single device tracking ───────────────────────
async function portalGetTracking(portalCookies, deviceId) {
  try {
    const raw = await portalAsmxPost(
      'DevicesAjax.asmx/GetTracking',
      { DeviceID: parseInt(deviceId) || 0, TimeZone: GMT },
      portalCookies
    );
    if (!raw) throw new Error('Empty response');
    return raw;
  } catch (err) {
    throw new Error(`Portal ASMX GetTracking failed (deviceId=${deviceId}): ${err.message}`);
  }
}

// ── Normalise raw vehicle record ──────────────────────────────────
function normaliseVehicle(raw) {
  const speedVal  = parseFloat(raw.speed || raw.Speed || 0);
  const statusStr = String(raw.status || raw.Status || '');
  const stateStr  = String(raw.acc || raw.ACC || '').toLowerCase();

  // ofl=0 means online on this platform; fall back to other fields
  const isOnline =
    raw.ofl       !== undefined ? Number(raw.ofl) === 0 :
    raw.isOnline  !== undefined ? Boolean(Number(raw.isOnline)) :
    raw.online    !== undefined ? Boolean(Number(raw.online))   :
    raw.Status    === 'online'  ? true :
    raw.status    === 'online'  ? true : false;

  // Ignition: check status string "ACC ON" or legacy acc field
  const ignition =
    statusStr.toLowerCase().includes('acc on') ||
    stateStr.includes('acc on') ||
    Boolean(Number(raw.ACC ?? raw.acc ?? 0));

  // Signal: parse "Network signal:strong(24)" → 24
  let signal = parseInt(raw.signalStrength || raw.signal || 0, 10);
  const sigMatch = statusStr.match(/signal[:\s]+\w+\((\d+)\)/i);
  if (sigMatch) signal = parseInt(sigMatch[1], 10);

  return {
    id:            String(raw.deviceID || raw.DeviceID || raw.id || raw.ID || ''),
    name:          raw.deviceName || raw.DeviceName || raw.name || raw.carName || raw.CarName || `Device ${raw.deviceID || raw.id || '?'}`,
    plate:         raw.licensePlate || raw.LicensePlate || raw.plate || raw.carNum || raw.CarNum || '',
    imei:          raw.IMEI || raw.imei || raw.sn || '',
    lat:           parseFloat(raw.lat  || raw.Lat  || raw.latitude  || 0),
    lng:           parseFloat(raw.lng  || raw.Lng  || raw.longitude || 0),
    speed:         speedVal,
    course:        parseInt(raw.course || raw.Course || raw.direction || 0, 10),
    isOnline,
    isMoving:      speedVal > 0 && !Boolean(Number(raw.is_stop ?? raw.isStop ?? 0)),
    ignition,
    battery:       parseInt(raw.battery || raw.Battery || raw.voltage || 0, 10),
    batteryStatus: raw.batteryStatus || raw.battery_status || '',
    signal,
    address:       raw.address || raw.Address || raw.addr || raw.location || '',
    lastUpdate:    raw.position_time || raw.positionTime || raw.updateTime || raw.lastUpdate || raw.LastUpdate || null,
    mileage:       parseFloat(raw.mileage || raw.totalMileage || raw.Mileage || 0),
  };
}

// ── Main export ───────────────────────────────────────────────────
export async function getVehicleData(trackerId, config) {
  const { base_url, username, password, api_url, login_mode, device_id } = config;

  const mode       = login_mode || 'account';
  const identifier = mode === 'device' ? (device_id || '').trim() : (username || '').trim();

  // Validate required fields up front with clear messages
  if (!identifier) {
    throw new Error(
      mode === 'device'
        ? 'Device ID is not configured. Edit the tracker in Admin → Tracking and enter the device ID number.'
        : 'Account username is not configured. Edit the tracker in Admin → Tracking and enter the username.'
    );
  }
  if (!password) {
    throw new Error(
      mode === 'device'
        ? 'Device password is not configured (factory default is 123456). Edit the tracker in Admin → Tracking.'
        : 'Account password is not configured. Edit the tracker in Admin → Tracking.'
    );
  }

  // ── Return cached session if still valid ──────────────────────
  let session = sessionCache.get(trackerId);
  if (session && Date.now() < session.expiresAt) {
    return dispatchSession(session, trackerId, identifier, mode);
  }
  session = null;

  // ── Try public API login ──────────────────────────────────────
  let apiSession = null;
  let apiError   = null;
  try {
    apiSession = await doLogin(api_url || null, base_url, mode, identifier, password);
  } catch (err) {
    apiError = err.message;
  }

  if (apiSession) {
    // ── Public API login succeeded ────────────────────────────
    if (mode === 'device') {
      // Device mode: use GetTracking for this single device
      const devId = apiSession.deviceId || identifier;
      try {
        const raw = await fetchSingleTracking(apiSession.apiAddress, apiSession.sessionKey, devId, apiSession.model);
        session = { ...apiSession, expiresAt: Date.now() + SESSION_TTL };
        sessionCache.set(trackerId, session);
        return { source: 'GetTracking', vehicles: [normaliseVehicle({ deviceID: devId, ...raw })] };
      } catch (trackErr) {
        // Port 8088 blocked — try portal ASMX GetTracking with p token via Monitor.aspx
        if (apiSession.sessionKey && apiSession.userId) {
          try {
            const cookies = await exchangeTokenForPortalCookies(apiSession.userId, apiSession.userName, apiSession.sessionKey);
            const raw     = await portalGetTracking(cookies, devId);
            session = { kind: 'portal', portalCookies: cookies, userId: apiSession.userId,
                        _deviceId: devId, _mode: 'device', expiresAt: Date.now() + SESSION_TTL };
            sessionCache.set(trackerId, session);
            return { source: 'GetTracking (portal)', vehicles: [normaliseVehicle({ deviceID: devId, ...raw })] };
          } catch { /* fall through */ }
        }
        throw new Error(
          `Device tracking fetch failed after login: ${trackErr.message}. ` +
          `Port 8088 may be blocked. Ask Aika168 support for an HTTPS API URL.`
        );
      }
    } else {
      // Account mode: try GetDeviceList+GetTracking first (this platform's native path),
      // then fall back to generic fleet endpoints
      const fleet =
        await tryGetDeviceListWithTracking(apiSession.apiAddress, apiSession.sessionKey, apiSession.userId) ||
        await tryFleetEndpoints(apiSession.apiAddress, apiSession.sessionKey, apiSession.userId);
      if (fleet) {
        session = { ...apiSession, expiresAt: Date.now() + SESSION_TTL };
        sessionCache.set(trackerId, session);
        return { source: fleet.endpoint, vehicles: fleet.vehicles.map(normaliseVehicle) };
      }

      // Fleet endpoints failed (port 8088 blocked?) — try portal fallbacks
      if (apiSession.sessionKey && apiSession.userId) {
        // B.5: ASMX with token as parameter
        const tokenFleet = await tryPortalAsmxWithToken(apiSession.sessionKey, apiSession.userId);
        if (tokenFleet) {
          session = { kind: 'portal+token', sessionKey: apiSession.sessionKey, userId: apiSession.userId,
                      expiresAt: Date.now() + SESSION_TTL };
          sessionCache.set(trackerId, session);
          return { source: tokenFleet.endpoint, vehicles: tokenFleet.vehicles.map(normaliseVehicle) };
        }

        // B.7: Exchange p token via Monitor.aspx for FormsAuth cookies
        try {
          const cookies    = await exchangeTokenForPortalCookies(apiSession.userId, apiSession.userName, apiSession.sessionKey);
          const cookieNames = cookies.split(';').map((c) => c.split('=')[0].trim()).join(', ');
          const portalData = await portalGetDevices(cookies, apiSession.userId, cookieNames, apiSession.sessionKey);
          session = { kind: 'portal', portalCookies: cookies, userId: apiSession.userId,
                      _cookieNames: cookieNames, _sessionKey: apiSession.sessionKey,
                      expiresAt: Date.now() + SESSION_TTL };
          sessionCache.set(trackerId, session);
          return { source: portalData.endpoint, vehicles: portalData.vehicles.map(normaliseVehicle) };
        } catch { /* fall through to WebForms login */ }
      }
    }
  }

  // ── Fallback: WebForms portal login (Path B) ──────────────────
  // API login failed or all portal token paths failed — try scraping the login form.
  // identifier is already correct for both modes (device_id for device, username for account).
  const webFormsSession = await portalLogin(identifier, password);
  // Fill in userId from API session if WebForms couldn't extract it
  const resolvedUserId = webFormsSession.userId || (apiSession?.userId) || null;

  if (mode === 'device') {
    const devId = apiSession?.deviceId || identifier;
    try {
      const raw = await portalGetTracking(webFormsSession.portalCookies, devId);
      session = { kind: 'portal', portalCookies: webFormsSession.portalCookies,
                  userId: resolvedUserId, _deviceId: devId, _mode: 'device',
                  _cookieNames: webFormsSession._cookieNames,
                  expiresAt: Date.now() + SESSION_TTL };
      sessionCache.set(trackerId, session);
      return { source: 'GetTracking (portal)', vehicles: [normaliseVehicle({ deviceID: devId, ...raw })] };
    } catch (err) {
      throw new Error(
        `All login paths exhausted for device mode. Last error: ${err.message}\n` +
        `API login error: ${apiError || 'n/a'}\n` +
        `Tip: Verify Device ID and password (factory default: 123456). ` +
        `Ask Aika168 support for the device's current API server address.`
      );
    }
  } else {
    try {
      const fleet = await portalGetDevices(
        webFormsSession.portalCookies, resolvedUserId, webFormsSession._cookieNames,
        apiSession?.sessionKey ?? null
      );
      session = { kind: 'portal', portalCookies: webFormsSession.portalCookies,
                  userId: resolvedUserId, _cookieNames: webFormsSession._cookieNames,
                  _sessionKey: apiSession?.sessionKey ?? null,
                  expiresAt: Date.now() + SESSION_TTL };
      sessionCache.set(trackerId, session);
      return { source: fleet.endpoint, vehicles: fleet.vehicles.map(normaliseVehicle) };
    } catch (err) {
      throw new Error(
        `All login paths exhausted for account mode. Last error: ${err.message}\n` +
        `API login error: ${apiError || 'n/a'}\n` +
        `Tip: Ask Aika168 support for a direct HTTPS API URL and enter it in Admin → Tracking → Direct API URL.\n` +
        `If this tenant only exposes single-device tracking, switch the tracker to device mode and use the device ID plus device password instead of the fleet account.`
      );
    }
  }
}

// ── Session dispatcher (cached sessions) ─────────────────────────
async function dispatchSession(session, trackerId, identifier, mode) {
  try {
    if (session.kind === 'api') {
      if (mode === 'device') {
        const devId = session.deviceId || identifier;
        const raw   = await fetchSingleTracking(session.apiAddress, session.sessionKey, devId, session.model);
        return { source: 'GetTracking', vehicles: [normaliseVehicle({ deviceID: devId, ...raw })] };
      }
      const fleet =
        await tryGetDeviceListWithTracking(session.apiAddress, session.sessionKey, session.userId) ||
        await tryFleetEndpoints(session.apiAddress, session.sessionKey, session.userId);
      if (fleet) return { source: fleet.endpoint, vehicles: fleet.vehicles.map(normaliseVehicle) };
      sessionCache.delete(trackerId);
      throw new Error('Fleet endpoints unreachable — session cleared, retry to re-authenticate.');
    }

    if (session.kind === 'portal+token') {
      const fleet = await tryPortalAsmxWithToken(session.sessionKey, session.userId);
      if (fleet) return { source: fleet.endpoint, vehicles: fleet.vehicles.map(normaliseVehicle) };
      sessionCache.delete(trackerId);
      throw new Error('Portal token session expired — retry to re-authenticate.');
    }

    if (session.kind === 'portal') {
      if (session._mode === 'device') {
        const raw = await portalGetTracking(session.portalCookies, session._deviceId || identifier);
        return { source: 'GetTracking (portal)', vehicles: [normaliseVehicle({ deviceID: session._deviceId, ...raw })] };
      }
      const fleet = await portalGetDevices(session.portalCookies, session.userId, session._cookieNames, session._sessionKey ?? null);
      return { source: fleet.endpoint, vehicles: fleet.vehicles.map(normaliseVehicle) };
    }

    throw new Error('Unknown session kind — clearing cache, retry.');
  } catch (err) {
    sessionCache.delete(trackerId);
    throw err;
  }
}

export function invalidateSession(trackerId) {
  sessionCache.delete(trackerId);
}
