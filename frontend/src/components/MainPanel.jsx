import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import ProfileSidebar from './ProfileSidebar.jsx';
import { resolveAvatar } from '../utils/avatar.js';

const AdminPanel = lazy(() => import('./AdminPanel.jsx'));
const UserPanel = lazy(() => import('./UserPanel.jsx'));

const SECTION_COLORS = {
  pdf: '#0ea5e9',
  apps: '#16a34a',
  tools: '#6366f1',
  admin: '#9333ea',
};

function canAccess(user, key) {
  if (!user.section_permissions) return true;
  return user.section_permissions[key] !== false;
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

const userCard = (id, chip, title, desc, forcedView, extra = {}) => ({
  id, chip, title, desc, panel: 'user', forcedView, ...extra,
});
const toolCard = (toolId, chip, title, desc) => userCard(`tool-${toolId}`, chip, title, desc, 'tools', { forcedTool: toolId });
const adminCard = (tab, chip, title, desc) => ({ id: `admin-${tab}`, chip, title, desc, panel: 'admin', forcedTab: tab });

function buildCatalogue(user) {
  const isAdmin = user.role === 'super_admin' || user.role === 'admin';
  const sections = [];

  if (canAccess(user, 'pdf_creation')) {
    const cards = [
      userCard('create', 'PC', 'Create PDF', 'Pick a template, fill in the form and generate the PDF.', 'create'),
      userCard('templates', 'TP', 'Templates', 'Browse every template, pin your favourite and start from one.', 'templates'),
      userCard('my-pdfs', 'MP', 'My PDFs', 'Every PDF you generated, with status, filters and history.', 'mypdfs'),
    ];
    if (isAdmin) {
      cards.push(adminCard('workflow', 'WF', 'Workflow', 'All submitted PDFs across every user. Update status and notes.'));
    }
    sections.push({ key: 'pdf', label: 'PDF Creation', color: SECTION_COLORS.pdf, cards });
  }

  if (canAccess(user, 'applications')) {
    sections.push({
      key: 'apps',
      label: 'Applications',
      color: SECTION_COLORS.apps,
      cards: [
        userCard('analytics', 'AN', 'Analytics', 'Monthly activity, status breakdown and the template preview mapper.', 'analytics'),
        userCard('profiling', 'PR', 'Profiling', 'Client profile archive by year and month, with folders.', 'profiling'),
        userCard('fieldeng', 'FE', 'Field Eng', 'Job orders for the field team: done, cancel, reschedule.', 'fieldeng'),
        userCard('macfinder', 'MF', 'MAC Finder', 'Find which OLT and port a client\'s MAC address is on.', 'macfinder'),
      ],
    });
  }

  if (canAccess(user, 'tools')) {
    sections.push({
      key: 'tools',
      label: 'Tools',
      color: SECTION_COLORS.tools,
      cards: [
        toolCard('client-lookup', 'CL', 'Client Lookup', 'Search a client and see their job order records.'),
        toolCard('adjustment', 'BA', 'Bill Adjustment', 'Credit for downtime and the adjusted amount to pay.'),
        toolCard('calculator', 'BC', 'Bill Calculator', 'First bill: pro-rated days used plus advance payment.'),
        toolCard('contract', 'CE', 'Contract End Date', 'When a contract expires, and the pre-termination fee.'),
        toolCard('discount', 'PD', 'Percentage Discount', 'Turn a peso discount into its percentage of the plan.'),
        toolCard('auto-reply', 'AR', 'Auto Reply', 'Ready-made replies to copy and send to clients.'),
        toolCard('link-to-qr', 'QR', 'Link to QR', 'Turn any link into a QR code you can download.'),
        toolCard('imperial-tracking', 'IT', 'Imperial Tracking', 'Live map of the field vehicles.'),
        toolCard('ticketing', 'TK', 'Ticketing', 'Raise and follow up client support tickets.'),
      ],
    });
  }

  if (isAdmin) {
    sections.push({
      key: 'admin',
      label: 'Administration',
      color: SECTION_COLORS.admin,
      cards: [
        adminCard('templates', 'TP', 'Templates', 'Upload, version and manage the PDF templates.'),
        adminCard('mapping', 'FM', 'Field Mapping', 'Place each form field on the template pages.'),
        adminCard('users', 'UM', 'User Management', 'Create accounts, set section access and reset passwords.'),
        adminCard('auto-reply', 'AR', 'Auto Reply Library', 'Add and edit the replies staff can copy.'),
        adminCard('qr-link', 'QL', 'QR Links', 'Every QR link staff have created.'),
        adminCard('tracking', 'TR', 'Tracking Setup', 'Configure the vehicle trackers and see the live map.'),
      ],
    });
  }

  return sections;
}

function readHash() {
  return window.location.hash.replace(/^#\/?/, '');
}

export default function MainPanel({
  token,
  user,
  onLogout,
  theme,
  onToggleTheme,
  onSessionUserUpdate,
}) {
  const catalogue = useMemo(() => buildCatalogue(user), [user]);
  const cardsById = useMemo(() => {
    const map = new Map();
    catalogue.forEach((section) => section.cards.forEach((card) => map.set(card.id, { ...card, color: section.color, section: section.label })));
    return map;
  }, [catalogue]);

  const [activeId, setActiveId] = useState(readHash);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef(null);

  const activeCard = cardsById.get(activeId) || null;

  useEffect(() => {
    const onHash = () => setActiveId(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      if (e.key === '/' && !['input', 'textarea', 'select'].includes(tag) && !e.target?.isContentEditable) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [activeId]);

  function open(id) {
    window.location.hash = id ? `/${id}` : '';
    setActiveId(id);
    setQuery('');
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return catalogue;
    return catalogue
      .map((section) => ({
        ...section,
        cards: section.cards.filter((card) => `${card.title} ${card.desc} ${section.label}`.toLowerCase().includes(q)),
      }))
      .filter((section) => section.cards.length > 0);
  }, [catalogue, query]);

  const shared = { token, user, onLogout, theme, onToggleTheme, onSessionUserUpdate };

  function renderPanel(card) {
    if (card.panel === 'admin') {
      return (
        <AdminPanel
          key={card.id}
          {...shared}
          embeddedMode
          forcedTab={card.forcedTab}
          onNavigate={(tab) => open(`admin-${tab}`)}
        />
      );
    }
    return (
      <UserPanel
        key={card.id}
        {...shared}
        embeddedMode
        forcedView={card.forcedView}
        forcedTool={card.forcedTool || null}
        onNavigate={(id) => open(id)}
      />
    );
  }

  const showHome = !activeCard || query.trim();

  return (
    <div className="noc-shell">
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

      <header className="noc-topbar">
        <div className="noc-topbar-left">
          <button type="button" className="noc-brand" onClick={() => open('')}>
            Imperial PDF Workflow
          </button>
          {activeCard && !query.trim() && (
            <nav className="noc-crumbs" aria-label="Breadcrumb">
              <span className="noc-crumb-sep">/</span>
              <span className="noc-crumb-section">{activeCard.section}</span>
              <span className="noc-crumb-sep">/</span>
              <span className="noc-crumb-current">{activeCard.title}</span>
            </nav>
          )}
        </div>

        <div className="noc-topbar-right">
          <label className="noc-search">
            <span className="noc-search-icon" aria-hidden="true">⌕</span>
            <input
              ref={searchRef}
              type="search"
              placeholder="Search tools…  ( / )"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur(); }
                if (e.key === 'Enter') {
                  const first = filtered[0]?.cards[0];
                  if (first) open(first.id);
                }
              }}
              aria-label="Search tools"
            />
          </label>
          <button type="button" className="noc-user" onClick={() => setSidebarOpen(true)} title="Profile and settings">
            <img className="noc-user-avatar" src={resolveAvatar(user)} alt="" />
            <span className="noc-user-email">{user.email}</span>
          </button>
        </div>
      </header>

      {showHome ? (
        <main className="noc-home">
          <div className="noc-hero">
            <h1>Every PDF workflow tool you need, in one place</h1>
            <p>
              {greeting()}, {user.name}. Create the PDFs, follow the jobs and keep the team in step.
            </p>
          </div>

          {filtered.length === 0 && (
            <p className="noc-empty">No tool matches “{query}”.</p>
          )}

          {filtered.map((section) => (
            <section key={section.key} className="noc-section">
              <h2 className="noc-section-label">{section.label}</h2>
              <div className="noc-grid">
                {section.cards.map((card) => (
                  <button key={card.id} type="button" className="noc-card" onClick={() => open(card.id)}>
                    <span className="noc-chip" style={{ background: section.color }}>{card.chip}</span>
                    <span className="noc-card-body">
                      <span className="noc-card-title">{card.title}</span>
                      <span className="noc-card-desc">{card.desc}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </main>
      ) : (
        <main className="noc-app">
          <div className="noc-app-head">
            <button type="button" className="noc-back" onClick={() => open('')}>
              ← All tools
            </button>
            <span className="noc-chip noc-chip-sm" style={{ background: activeCard.color }}>{activeCard.chip}</span>
            <div>
              <h1 className="noc-app-title">{activeCard.title}</h1>
              <p className="noc-app-desc">{activeCard.desc}</p>
            </div>
          </div>
          <Suspense fallback={<div className="noc-loading">Loading…</div>}>
            {renderPanel(activeCard)}
          </Suspense>
        </main>
      )}
    </div>
  );
}
