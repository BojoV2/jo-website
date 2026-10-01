import { Suspense, lazy, useState } from 'react';
import ProfileSidebar from './ProfileSidebar.jsx';
import { resolveAvatar } from '../utils/avatar.js';

const AdminPanel = lazy(() => import('./AdminPanel.jsx'));
const UserPanel  = lazy(() => import('./UserPanel.jsx'));

// ── helpers ───────────────────────────────────────────────────────────────
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

// ── card / section catalogue ──────────────────────────────────────────────
function buildCatalogue(user) {
  const isAdmin = user.role === 'super_admin' || user.role === 'admin';

  const sections = [];

  // ── PDF CREATION ─────────────────────────────────────────────────────────
  if (canAccess(user, 'pdf_creation')) {
    const cards = [
      {
        chip: 'PC', color: '#e5252a',
        title: 'Create PDF',
        desc: 'Fill in a template and generate a signed PDF.',
        panel: 'user', forcedView: 'create', forcedUserSection: 'create',
      },
      {
        chip: 'MP', color: '#f97316',
        title: 'My PDFs',
        desc: 'Your generated PDFs, status updates and history.',
        panel: 'user', forcedView: 'create', forcedUserSection: 'history',
      },
    ];
    if (isAdmin) {
      cards.push({
        chip: 'WF', color: '#7c3aed',
        title: 'Workflow',
        desc: 'All submitted PDFs across every user — approve, update status.',
        panel: 'admin', forcedTab: 'workflow',
      });
    }
    sections.push({ label: 'PDF CREATION', cards });
  }

  // ── APPLICATIONS ──────────────────────────────────────────────────────────
  if (canAccess(user, 'applications')) {
    sections.push({
      label: 'APPLICATIONS',
      cards: [
        {
          chip: 'AN', color: '#7c3aed',
          title: 'Analytics',
          desc: 'Template usage stats, monthly activity and status breakdown.',
          panel: 'user', forcedView: 'analytics', forcedUserSection: null,
        },
        {
          chip: 'PR', color: '#0ea5e9',
          title: 'Profiling',
          desc: 'Client profile archive, free-depth folders and admin controls.',
          panel: 'user', forcedView: 'profiling', forcedUserSection: null,
        },
        {
          chip: 'FE', color: '#059669',
          title: 'Field Eng',
          desc: 'Job orders, scheduling, Done / Cancel / Reschedule and team notes.',
          panel: 'user', forcedView: 'fieldeng', forcedUserSection: null,
        },
        {
          chip: 'MF', color: '#d97706',
          title: 'MAC Finder',
          desc: 'Look up a client\'s connected device by MAC address across OLTs.',
          panel: 'user', forcedView: 'macfinder', forcedUserSection: null,
        },
      ],
    });
  }

  // ── TOOLS ─────────────────────────────────────────────────────────────────
  if (canAccess(user, 'tools')) {
    sections.push({
      label: 'TOOLS',
      cards: [
        {
          chip: 'CL', color: '#2563eb',
          title: 'Client Lookup',
          desc: 'Search and view client account and status details.',
          panel: 'user', forcedView: 'tools', forcedUserSection: null,
        },
        {
          chip: 'BA', color: '#0d9488',
          title: 'Bill Adjustment',
          desc: 'Credit and debit adjustments applied to billing.',
          panel: 'user', forcedView: 'tools', forcedUserSection: null,
        },
        {
          chip: 'BC', color: '#4f46e5',
          title: 'Bill Calculator',
          desc: 'Calculate prorated and monthly billing amounts.',
          panel: 'user', forcedView: 'tools', forcedUserSection: null,
        },
        {
          chip: 'CE', color: '#be185d',
          title: 'Contract End Date',
          desc: 'Look up contract end dates per client account.',
          panel: 'user', forcedView: 'tools', forcedUserSection: null,
        },
        {
          chip: 'PD', color: '#ea580c',
          title: 'Percentage Discount',
          desc: 'Apply and calculate percentage-based discounts.',
          panel: 'user', forcedView: 'tools', forcedUserSection: null,
        },
        {
          chip: 'AR', color: '#475569',
          title: 'Auto Reply',
          desc: 'View and compose the automated response message.',
          panel: 'user', forcedView: 'tools', forcedUserSection: null,
        },
        {
          chip: 'QR', color: '#7c3aed',
          title: 'QR Link',
          desc: 'Generate QR codes that point to any URL.',
          panel: 'user', forcedView: 'tools', forcedUserSection: null,
        },
        {
          chip: 'IT', color: '#16a34a',
          title: 'Imperial Tracking',
          desc: 'Live vehicle tracking map for the field team.',
          panel: 'user', forcedView: 'tools', forcedUserSection: null,
        },
        {
          chip: 'TK', color: '#dc2626',
          title: 'Ticketing',
          desc: 'Create and manage client support tickets.',
          panel: 'user', forcedView: 'tools', forcedUserSection: null,
        },
      ],
    });
  }

  // ── ADMINISTRATION ────────────────────────────────────────────────────────
  if (isAdmin) {
    sections.push({
      label: 'ADMINISTRATION',
      cards: [
        {
          chip: 'TP', color: '#374151',
          title: 'Templates Mgmt',
          desc: 'Upload, version and manage every PDF template.',
          panel: 'admin', forcedTab: 'templates',
        },
        {
          chip: 'FM', color: '#374151',
          title: 'Field Mapping',
          desc: 'Map template fields to their canvas positions.',
          panel: 'admin', forcedTab: 'mapping',
        },
        {
          chip: 'US', color: '#374151',
          title: 'User Accounts',
          desc: 'Create accounts, set access permissions and manage passwords.',
          panel: 'admin', forcedTab: 'users',
        },
        {
          chip: 'AR', color: '#4b5563',
          title: 'Auto Reply Config',
          desc: 'Edit the automated response that users see.',
          panel: 'admin', forcedTab: 'auto-reply',
        },
        {
          chip: 'QR', color: '#4b5563',
          title: 'QR Link Config',
          desc: 'Manage QR code generation settings.',
          panel: 'admin', forcedTab: 'qr-link',
        },
        {
          chip: 'TK', color: '#4b5563',
          title: 'Tracking Config',
          desc: 'Configure the live vehicle tracking map.',
          panel: 'admin', forcedTab: 'tracking',
        },
      ],
    });
  }

  return sections;
}

// ── main component ────────────────────────────────────────────────────────
export default function MainPanel({
  token,
  user,
  onLogout,
  theme,
  onToggleTheme,
  onSessionUserUpdate,
}) {
  const [activeCard, setActiveCard]   = useState(null); // null = home
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const catalogue = buildCatalogue(user);
  const shared = { token, user, onLogout, theme, onToggleTheme, onSessionUserUpdate };

  // ── panel inside a card ──────────────────────────────────────────────────
  function renderPanel(card) {
    if (card.panel === 'admin') {
      return (
        <Suspense fallback={<div className="noc-home-loading">Loading…</div>}>
          <AdminPanel {...shared} embeddedMode forcedTab={card.forcedTab} />
        </Suspense>
      );
    }
    return (
      <Suspense fallback={<div className="noc-home-loading">Loading…</div>}>
        <UserPanel
          {...shared}
          embeddedMode
          forcedView={card.forcedView}
          forcedUserSection={card.forcedUserSection}
        />
      </Suspense>
    );
  }

  return (
    <div className="noc-shell" data-theme={theme}>
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
      <header className="noc-topbar">
        <div className="noc-topbar-left">
          {activeCard ? (
            <button
              type="button"
              className="noc-back-btn"
              onClick={() => setActiveCard(null)}
              aria-label="Back to home"
            >
              ← Back
            </button>
          ) : null}
          <span className="noc-brand">Imperial PDF Workflow</span>
          {activeCard && (
            <span className="noc-breadcrumb">/ {activeCard.title}</span>
          )}
        </div>
        <div className="noc-topbar-right">
          <button
            type="button"
            className="noc-user-btn"
            onClick={() => setSidebarOpen(true)}
          >
            <img
              className="avatar avatar-sm"
              src={resolveAvatar(user)}
              alt={user.name}
            />
            <span className="noc-user-email">{user.email}</span>
          </button>
        </div>
      </header>

      {/* ── Content ── */}
      {activeCard ? (
        <div className="noc-panel-wrap">
          {renderPanel(activeCard)}
        </div>
      ) : (
        <main className="noc-home">
          {/* hero */}
          <div className="noc-hero">
            <h1 className="noc-hero-title">
              Every PDF workflow tool you need, in one place
            </h1>
            <p className="noc-hero-sub">
              {greeting()}, <strong>{user.name}</strong>.
              Create PDFs, track jobs and manage the team from one screen.
            </p>
          </div>

          {/* card grid */}
          {catalogue.map((section) => (
            <section key={section.label} className="noc-section">
              <div className="noc-section-label">{section.label}</div>
              <div className="noc-card-grid">
                {section.cards.map((card) => (
                  <button
                    key={`${card.chip}-${card.title}`}
                    type="button"
                    className="noc-card"
                    onClick={() => setActiveCard(card)}
                  >
                    <div
                      className="noc-chip"
                      style={{ background: card.color }}
                    >
                      {card.chip}
                    </div>
                    <div className="noc-card-body">
                      <div className="noc-card-title">{card.title}</div>
                      <div className="noc-card-desc">{card.desc}</div>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </main>
      )}
    </div>
  );
}
