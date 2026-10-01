import { Suspense, lazy, useState } from 'react';
import ProfileSidebar from './ProfileSidebar.jsx';
import { resolveAvatar } from '../utils/avatar.js';

const AdminPanel = lazy(() => import('./AdminPanel.jsx'));
const UserPanel  = lazy(() => import('./UserPanel.jsx'));

// ── section permission check ──────────────────────────────────────────────
function canAccess(user, key) {
  if (!user.section_permissions) return true;
  return user.section_permissions[key] !== false;
}

// ── section / sub-tab definitions ────────────────────────────────────────
const SECTIONS = [
  { id: 'pdf-creation', label: 'PDF Creation', permKey: 'pdf_creation' },
  { id: 'applications', label: 'Applications',  permKey: 'applications' },
  { id: 'tools',        label: 'Tools',          permKey: 'tools' },
  { id: 'administration', label: 'Administration', adminOnly: true },
];

const PDF_TABS = [
  { id: 'create',   label: 'Create' },
  { id: 'my-pdfs',  label: 'My PDFs' },
  { id: 'workflow', label: 'Workflow', adminOnly: true },
];

const APP_TABS = [
  { id: 'analytics', label: 'Analytics' },
  { id: 'profiling', label: 'Profiling' },
  { id: 'fieldeng',  label: 'Field Eng' },
  { id: 'macfinder', label: 'MAC Finder' },
];

const ADMIN_TABS = [
  { id: 'templates',  label: 'Templates Mgmt', chip: 'TP' },
  { id: 'mapping',    label: 'Field Mapping',   chip: 'FM' },
  { id: 'users',      label: 'Users',           chip: 'US' },
  { id: 'auto-reply', label: 'Auto Reply',      chip: 'AR' },
  { id: 'qr-link',    label: 'QR Link',         chip: 'QR' },
  { id: 'tracking',   label: 'Tracking',        chip: 'TK' },
];

export default function MainPanel({
  token,
  user,
  onLogout,
  theme,
  onToggleTheme,
  onSessionUserUpdate,
}) {
  const isAdmin = user.role === 'super_admin' || user.role === 'admin';

  // Build visible sections
  const visibleSections = SECTIONS.filter(s => {
    if (s.adminOnly) return isAdmin;
    return canAccess(user, s.permKey);
  });

  // Pick first available section as default
  const defaultSection = visibleSections[0]?.id ?? 'tools';

  const [section,    setSection]    = useState(defaultSection);
  const [pdfTab,     setPdfTab]     = useState('create');
  const [appTab,     setAppTab]     = useState('analytics');
  const [adminTab,   setAdminTab]   = useState('templates');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Compute sub-tabs for current section
  const pdfTabs   = PDF_TABS.filter(t => !t.adminOnly || isAdmin);
  const appTabs   = APP_TABS;
  const adminTabs = ADMIN_TABS;

  // Derive UserPanel forcedView / forcedUserSection
  function userPanelProps() {
    if (section === 'pdf-creation') {
      if (pdfTab === 'my-pdfs') return { forcedView: 'create', forcedUserSection: 'history' };
      return { forcedView: 'create', forcedUserSection: 'create' };
    }
    if (section === 'applications') {
      const map = { analytics: 'analytics', profiling: 'profiling', fieldeng: 'fieldeng', macfinder: 'macfinder' };
      return { forcedView: map[appTab] ?? 'analytics', forcedUserSection: null };
    }
    if (section === 'tools') {
      return { forcedView: 'tools', forcedUserSection: null };
    }
    return { forcedView: 'create', forcedUserSection: 'create' };
  }

  // Derive AdminPanel forcedTab
  function adminPanelTab() {
    if (section === 'pdf-creation' && pdfTab === 'workflow') return 'workflow';
    if (section === 'administration') return adminTab;
    return null;
  }

  // Decide which panel to render
  function renderPanel() {
    const shared = { token, user, onLogout, theme, onToggleTheme, onSessionUserUpdate };

    // Workflow inside PDF Creation → AdminPanel
    if (section === 'pdf-creation' && pdfTab === 'workflow' && isAdmin) {
      return (
        <Suspense fallback={<div className="meta">Loading…</div>}>
          <AdminPanel {...shared} embeddedMode forcedTab="workflow" />
        </Suspense>
      );
    }

    // Administration section → AdminPanel
    if (section === 'administration') {
      return (
        <Suspense fallback={<div className="meta">Loading…</div>}>
          <AdminPanel {...shared} embeddedMode forcedTab={adminTab} />
        </Suspense>
      );
    }

    // Everything else → UserPanel
    const { forcedView, forcedUserSection } = userPanelProps();
    return (
      <Suspense fallback={<div className="meta">Loading…</div>}>
        <UserPanel
          {...shared}
          embeddedMode
          forcedView={forcedView}
          forcedUserSection={forcedUserSection}
        />
      </Suspense>
    );
  }

  // Sub-tab bar for current section
  function renderSubTabs() {
    if (section === 'pdf-creation') {
      return (
        <div className="v2-subtabs">
          {pdfTabs.map(t => (
            <button
              key={t.id}
              className={`v2-subtab${pdfTab === t.id ? ' active' : ''}`}
              onClick={() => setPdfTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      );
    }
    if (section === 'applications') {
      return (
        <div className="v2-subtabs">
          {appTabs.map(t => (
            <button
              key={t.id}
              className={`v2-subtab${appTab === t.id ? ' active' : ''}`}
              onClick={() => setAppTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      );
    }
    if (section === 'administration') {
      return (
        <div className="v2-subtabs">
          {adminTabs.map(t => (
            <button
              key={t.id}
              className={`v2-subtab${adminTab === t.id ? ' active' : ''}`}
              onClick={() => setAdminTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      );
    }
    return null; // Tools has no sub-tabs
  }

  return (
    <div className="v2-shell">
      <ProfileSidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        token={token}
        user={user}
        onUserUpdated={onSessionUserUpdate}
        theme={theme}
        onToggleTheme={onToggleTheme}
        onLogout={onLogout}
      />

      {/* ── Top bar ── */}
      <div className="v2-topbar">
        <div className="v2-brand">
          <img
            className="v2-brand-logo"
            src="/imperial-network-logo.svg"
            alt="Imperial Network"
          />
          <div>
            <div className="v2-brand-name">Imperial</div>
            <div className="v2-brand-sub">PDF Workflow</div>
          </div>
        </div>

        <nav className="v2-nav" aria-label="Main navigation">
          {visibleSections.map(s => (
            <button
              key={s.id}
              className={`v2-nav-item${section === s.id ? ' active' : ''}`}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <div className="v2-topbar-right">
          <button
            type="button"
            className="avatar-trigger"
            onClick={() => setSidebarOpen(true)}
            title="Open settings"
          >
            <img className="avatar avatar-md" src={resolveAvatar(user)} alt={user.name} />
          </button>
        </div>
      </div>

      {/* ── Sub-tab bar ── */}
      {renderSubTabs()}

      {/* ── Content ── */}
      <div className="v2-content">
        {renderPanel()}
      </div>
    </div>
  );
}
