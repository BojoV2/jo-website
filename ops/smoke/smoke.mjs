// End-to-end smoke test for the JO website, driven through the public API the
// way the portal uses it. Started by ops/jo-smoke-test.sh, which creates the two
// throwaway accounts and removes everything they touched afterwards.
//
//   node smoke.mjs <baseUrl> <password>
//
// Exit code = number of failed checks.
const BASE = process.argv[2].replace(/\/$/, '');
const PW = process.argv[3];
const ADMIN = 'zz-smoke-admin@test.local';
const USER = 'zz-smoke-user@test.local';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  [${ok ? ' OK ' : 'FAIL'}] ${name}${detail ? ` - ${detail}` : ''}`);
}

async function api(path, { token, method = 'GET', body, raw = false } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function step(name, fn) {
  try {
    const [ok, detail] = await fn();
    check(name, ok, detail);
  } catch (err) {
    check(name, false, `threw ${err.message}`);
  }
}

async function login(email) {
  const r = await api('/auth/login', { method: 'POST', body: { identifier: email, password: PW } });
  if (r.status !== 200) throw new Error(`login ${email} -> ${r.status} ${r.data?.error || ''}`);
  return r.data;
}

console.log(`== frontend (${BASE}) ==`);
await step('home page and every script/style it loads', async () => {
  const res = await fetch(`${BASE}/`);
  const html = await res.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
  const bad = [];
  for (const a of assets) {
    const r = await fetch(`${BASE}${a}`);
    if (r.status !== 200) bad.push(`${a} ${r.status}`);
  }
  return [res.status === 200 && assets.length > 0 && bad.length === 0, `${assets.length} assets${bad.length ? `, broken: ${bad.join(', ')}` : ''}`];
});

console.log('== sign in ==');
let admin;
let user;
await step('admin and standard test accounts sign in', async () => {
  admin = await login(ADMIN);
  user = await login(USER);
  return [admin.user.role === 'admin' && user.user.role === 'user', `${admin.user.role} + ${user.user.role}`];
});
if (!admin || !user) {
  console.log('\nCannot continue without both sessions.');
  process.exit(results.filter((r) => !r.ok).length || 1);
}
const A = admin.token;
let U = user.token;
const userId = user.user.id;

console.log('== PDF workflow ==');
let pdfId = null;
await step('generate a PDF from the simplest template', async () => {
  const templates = (await api('/templates', { token: U })).data || [];
  let pick = null;
  for (const tpl of templates) {
    const fields = (await api(`/templates/${tpl.id}/fields`, { token: U })).data || [];
    const docs = (await api(`/templates/${tpl.id}/document-requirements`, { token: U })).data;
    const needsDocs = Array.isArray(docs) && docs.some((d) => d.required);
    const textOnly = fields.filter((f) => f.required).every((f) => f.field_type === 'text');
    if (!needsDocs && textOnly && (!pick || fields.length < pick.fields.length)) pick = { tpl, fields };
  }
  if (!pick) return [false, 'no template with text-only required fields'];
  const data = Object.fromEntries(pick.fields.filter((f) => f.field_type === 'text').map((f) => [f.field_name, 'ZZ-SMOKE test']));
  const r = await api('/generated-pdfs/generate', { token: U, method: 'POST', body: { template_id: pick.tpl.id, submitted_data: data } });
  pdfId = r.data?.id || r.data?.generated?.id || null;
  return [r.status < 300 && !!pdfId, `${pick.tpl.title} -> ${r.status}`];
});

await step('generated PDF downloads as a real PDF', async () => {
  const res = await api(`/generated-pdfs/${pdfId}/download`, { token: U, raw: true });
  const head = Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString();
  return [res.status === 200 && head === '%PDF', `${res.status} ${head}`];
});

await step('status change pending -> done', async () => {
  const r = await api(`/generated-pdfs/${pdfId}/status`, { token: U, method: 'PATCH', body: { status: 'done', note: null, reschedule_date: null } });
  return [r.status === 200, `${r.status} ${r.data?.error || ''}`];
});

console.log('== applications and tools (read paths) ==');
const reads = [
  ['analytics', `/generated-pdfs/analytics/templates`],
  ['client lookup finds the test client', `/clients?q=${encodeURIComponent('ZZ-SMOKE')}`, (d) => Array.isArray(d) ? d.length > 0 : (d?.results || d?.clients || []).length > 0],
  ['profiling folders', '/profiling/folders'],
  ['field eng jobs', '/field-eng/jobs'],
  ['auto reply messages', '/auto-reply'],
  ['QR links', '/qr-link'],
  ['vehicle tracking', '/tracking/status'],
  ['tickets', '/tickets'],
];
for (const [name, path, extra] of reads) {
  await step(name, async () => {
    const r = await api(path, { token: U });
    return [r.status === 200 && (!extra || extra(r.data)), `${r.status}`];
  });
}

console.log('== user management ==');
await step('admin lists accounts', async () => {
  const r = await api('/users', { token: A });
  return [r.status === 200 && r.data.some((u) => u.id === userId), `${r.status}, ${r.data?.length} accounts`];
});
await step('standard account cannot open user management', async () => {
  const r = await api('/users', { token: U });
  return [r.status === 403, `${r.status}`];
});
await step('per-app access saves', async () => {
  const r = await api(`/users/${userId}/permissions`, { token: A, method: 'PATCH', body: { section_permissions: { 'tool-ticketing': false } } });
  const me = await api('/auth/me', { token: U });
  const ok = r.status === 200 && me.data?.user?.section_permissions?.['tool-ticketing'] === false;
  await api(`/users/${userId}/permissions`, { token: A, method: 'PATCH', body: { section_permissions: null } });
  return [ok, `${r.status}`];
});

const imageId = ((await api('/auto-reply', { token: U })).data || [])
  .flatMap((m) => m.images || (m.image_id ? [{ id: m.image_id }] : []))
  .map((img) => img.id || img.image_id)
  .find(Boolean);

await step('disable signs the account out everywhere (incl. image links)', async () => {
  const before = imageId ? (await api(`/auto-reply/images/${imageId}?t=${encodeURIComponent(U)}`, { raw: true })).status : null;
  const d = await api(`/users/${userId}/status`, { token: A, method: 'PATCH', body: { disabled: true } });
  const me = await api('/auth/me', { token: U });
  const img = imageId ? (await api(`/auto-reply/images/${imageId}?t=${encodeURIComponent(U)}`, { raw: true })).status : null;
  const relog = await api('/auth/login', { method: 'POST', body: { identifier: USER, password: PW } });
  await api(`/users/${userId}/status`, { token: A, method: 'PATCH', body: { disabled: false } });
  const ok = d.status === 200 && me.status === 401 && relog.status === 403 && (imageId ? before === 200 && img === 401 : true);
  return [ok, `api ${me.status}, login ${relog.status}${imageId ? `, image ${before}->${img}` : ', no image to test'}`];
});

await step('enabled again can sign in', async () => {
  user = await login(USER);
  U = user.token;
  return [true, 'ok'];
});

await step('audit trail records the changes', async () => {
  const r = await api('/users/audit?limit=20', { token: A });
  const actions = (r.data || []).map((e) => e.action);
  const need = ['admin.user.disable', 'admin.user.enable', 'admin.user.access', 'login.ok'];
  return [need.every((a) => actions.includes(a)), need.filter((a) => !actions.includes(a)).join(', ') || 'all present'];
});

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed);
