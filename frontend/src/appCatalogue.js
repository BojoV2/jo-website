// Applications a standard account can be granted, grouped as on the home page.
// Ids double as permission keys (backend/src/services/accountAudit.js APP_KEYS).
export const APP_GROUPS = [
  {
    key: 'pdf_creation',
    label: 'PDF Creation',
    apps: [
      { id: 'create', label: 'Create PDF' },
      { id: 'templates', label: 'Templates' },
      { id: 'my-pdfs', label: 'My PDFs' },
    ],
  },
  {
    key: 'applications',
    label: 'Applications',
    apps: [
      { id: 'analytics', label: 'Analytics' },
      { id: 'profiling', label: 'Profiling' },
      { id: 'fieldeng', label: 'Field Eng' },
      { id: 'macfinder', label: 'MAC Finder' },
    ],
  },
  {
    key: 'tools',
    label: 'Tools',
    apps: [
      { id: 'tool-client-lookup', label: 'Client Lookup' },
      { id: 'tool-adjustment', label: 'Bill Adjustment' },
      { id: 'tool-calculator', label: 'Bill Calculator' },
      { id: 'tool-contract', label: 'Contract End Date' },
      { id: 'tool-discount', label: 'Percentage Discount' },
      { id: 'tool-auto-reply', label: 'Auto Reply' },
      { id: 'tool-link-to-qr', label: 'Link to QR' },
      { id: 'tool-imperial-tracking', label: 'Imperial Tracking' },
      { id: 'tool-ticketing', label: 'Ticketing' },
    ],
  },
];

export const ALL_APPS = APP_GROUPS.flatMap((group) => group.apps.map((app) => ({ ...app, group: group.key })));

export function isPrivileged(account) {
  return account?.role === 'super_admin' || account?.role === 'admin';
}

// A section key set to false (older accounts) blocks every app in that group.
export function canOpen(account, groupKey, appId) {
  if (isPrivileged(account)) return true;
  const perms = account?.section_permissions;
  if (!perms) return true;
  return perms[groupKey] !== false && perms[appId] !== false;
}

// Normalise to per-app keys only, so the Manage dialog edits one consistent shape.
export function allowedMap(account) {
  return Object.fromEntries(ALL_APPS.map((app) => [app.id, canOpen(account, app.group, app.id)]));
}

export function permsFromAllowed(allowed) {
  const off = ALL_APPS.filter((app) => allowed[app.id] === false).map((app) => [app.id, false]);
  return off.length ? Object.fromEntries(off) : null;
}
