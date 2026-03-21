# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Full-stack PDF workflow management system. Admins upload PDF templates and configure field coordinates; users fill forms that generate PDFs. Includes role-based access, a status workflow (pending/done/cancelled/rescheduled), optional Google Sheets sync, an analytics dashboard, and a billing tools suite.

## Commands

### Docker (recommended)
```bash
docker compose up --build        # Start full stack (Postgres + backend + frontend)
docker compose up -d --build     # Daemonized
```

### Backend (`backend/`)
```bash
npm run dev      # Dev server with nodemon (port 8080)
npm start        # Production
npm run db:init  # Initialize DB schema
npm test         # Run vitest tests
```

### Frontend (`frontend/`)
```bash
npm run dev      # Vite dev server (port 3000)
npm run build    # Production build
npm run preview  # Preview production build
```

## Architecture

### Stack
- **Backend:** Node.js + Express (ES modules), PostgreSQL 16, pdf-lib for PDF generation, JWT auth, express-rate-limit
- **Frontend:** React 18 + Vite, Framer Motion, pdfjs-dist for rendering, Recharts for analytics

### Backend structure (`backend/src/`)
- `index.js` — Entry point; validates required env vars at startup, starts server, schedules Google Sheets sync
- `app.js` — Express app, CORS config (defaults to `http://localhost:3000`), route registration
- `bootstrap.js` — Runs DB schema init on startup
- `db.js` — PostgreSQL connection pool (via `pg`)
- `constants.js` — Shared constants; exports `PDF_STATUSES = ['pending','done','cancelled','rescheduled']`
- `middleware/auth.js` — JWT verification + role-based guards (`requireRole`)
- `routes/` — Four route modules: `auth`, `users`, `templates`, `generatedPdfs`
- `services/pdfService.js` — Core PDF rendering: inserts text at x/y coordinates per page using pdf-lib
- `services/googleSheetsService.js` — Syncs generated PDF submissions to Google Sheets (monthly tabs)

### Frontend structure (`frontend/src/`)
- `App.jsx` — Session management (localStorage/sessionStorage), theme toggle, lazy-loads `AdminPanel` and `UserPanel`
- `api.js` — Fetch wrapper that injects JWT from storage into all requests
- `components/AdminPanel.jsx` — Template upload, PDF field coordinate mapping, workflow kanban board, analytics
- `components/UserPanel.jsx` — Template selection, form filling, PDF preview and download, analytics, tools view
- `components/BillingTools.jsx` — Billing tools suite (see Tools section below)
- `components/StatusStackedBarChart.jsx` — Monthly stacked bar chart (done/pending/rescheduled/cancelled per month)
- `components/StatusDonutChart.jsx` — Donut chart showing current-month status distribution for selected template
- `components/ProfileSidebar.jsx` — User profile drawer
- `components/TemplateMonthlyAreaChart.jsx` — Legacy area chart (kept but no longer used in panels)
- `components/ui/` — Reusable UI primitives

### Database schema
Key tables: `users`, `pdf_templates`, `pdf_fields`, `generated_pdfs`, `status_history`, `field_presets`, `template_predefined_pdfs`. See `backend/sql/schema.sql` for full schema.

### Auth model
JWT-based. Three roles: `super_admin`, `admin`, `user`. Route guards in `middleware/auth.js` protect endpoints. Token is stored in localStorage or sessionStorage depending on user's "remember me" setting.

### PDF field types
Fields support: `text`, `dropdown`, `date`, `order_number`, `checkbox`. The backend auto-calculates font size to fit text within field bounds.

### Storage
Files (uploaded templates, generated PDFs) are stored in `./storage/` on the host, mounted into containers. Paths: `storage/templates/`, `storage/generated/`, `storage/template-predefined-pdfs/`.

## Environment

Backend reads from `backend/.env`:
```
PORT=8080
DATABASE_URL=postgres://...
JWT_SECRET=...
CORS_ORIGIN=http://localhost:3000
STORAGE_ROOT=/app/storage
# Optional Google Sheets:
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_PRIVATE_KEY=
GOOGLE_SHEETS_SYNC_INTERVAL_MINUTES=60
```

## Analytics

Both `AdminPanel` and `UserPanel` share the same analytics setup:

- **Status Stacked Bar Chart** (`StatusStackedBarChart.jsx`) — primary chart. Shows monthly PDF volume stacked by status (cancelled → rescheduled → pending → done from bottom to top). Driven by `GET /generated-pdfs/analytics/templates/monthly-by-status?months=N&template_id=X`. UserPanel passes `template_id` for the selected template; AdminPanel omits it for all-template totals.
- **Status Donut Chart** (`StatusDonutChart.jsx`) — secondary chart. Shows this month's status distribution as a donut with center total and a legend with counts and percentages. Reads from the `analytics` state already loaded per template (no extra API call).
- Both charts sit side-by-side in a `.chart-combo` grid (collapses to vertical on narrow screens).

### Analytics API endpoints
- `GET /generated-pdfs/analytics/template/:templateId` — current-month summary for one template (pending, done, cancelled, rescheduled counts, cancellation rate, avg processing time)
- `GET /generated-pdfs/analytics/templates` — current-month summary across all templates
- `GET /generated-pdfs/analytics/templates/monthly?months=N` — monthly totals per template (original, used by legacy area chart)
- `GET /generated-pdfs/analytics/templates/monthly-by-status?months=N&template_id=X` — monthly totals broken down by status; optional `template_id` filter

## User Panel — Views

The user panel has two top-level views controlled by `activeView` state (`'workspace'` | `'tools'`):

- **Workspace** — the default view. Contains the 4 workspace sections (Create PDF, Analytics, Preview, My PDFs). Clicking any workspace section button switches `activeView` back to `'workspace'`.
- **Tools** — activated by the **TL** button in the sidebar. Renders `BillingTools`. Templates remain selectable in the sidebar while in tools view.

Additional UX:
- **Form clear on success** — after a successful PDF generation, `formValues` is reset to field defaults. On error, values are preserved.
- **Back to top button** — appears (fixed, bottom-right) when the user scrolls more than 300px; smooth-scrolls to top on click.
- **Message auto-dismiss** — success/error messages in both panels clear automatically after 5 seconds.

## Tools — Billing Tools Suite

`BillingTools.jsx` is a self-contained component accessible from the user sidebar (Tools → TL). It has a left-nav tab layout (collapses to a horizontal row on mobile) with 4 tools. Each tool has a collapsible "How to use it" section.

### Plans (shared across all tools)
| Speed   | Monthly Price |
|---------|--------------|
| 35 Mbps | ₱599         |
| 50 Mbps | ₱799         |
| 100 Mbps| ₱999         |
| 150 Mbps| ₱1,200       |
| 200 Mbps| ₱1,400       |
| 300 Mbps| ₱1,600       |
| 500 Mbps| ₱2,000       |

### Tool 1 — Bill Adjustment
Calculates a credit for downtime and the adjusted amount the customer should pay.
- **Inputs:** plan, days without service, hours without service, due date
- **Logic:** `hourlyRate = plan / 720` → `credit = hourlyRate × totalHours` → `adjusted = plan − credit`
- Assumes a 30-day / 720-hour billing cycle.

### Tool 2 — Bill Calculator (First Bill)
Calculates a customer's first bill: pro-rated charge for days used plus advance payment.
- **Inputs:** plan, due date (activation date), cycle date
- **Logic:** `dailyRate = plan / 30` → `daysUsed = ceil((cycleDate − dueDate) / 86400000)` → `prorated = dailyRate × daysUsed` → `firstBill = prorated + plan`

### Tool 3 — Contract End Date
Finds when a contract expires given a start date and length in months.
- **Inputs:** start date, contract length (months, default 12)
- **Logic:** `endDate = startDate + months`; handles month overflow; subtracts 1 day for end-of-period. Shows termination fee of ₱2,500 if contract is not completed.

### Tool 4 — Percentage Discount
Converts a peso discount amount into its percentage equivalent.
- **Inputs:** plan, discount amount in ₱
- **Logic:** `percentage = (discountAmount / plan) × 100` → `discountedPrice = plan − discountAmount`
- Includes a **Copy** button to copy the percentage value to clipboard.

## Security & Validation

- **Rate limiting:** `POST /auth/login` and `POST /auth/register` are limited to 20 requests per 15-minute window via `express-rate-limit`.
- **PDF magic-byte check:** uploaded files are validated against the `%PDF` header (first 4 bytes) in addition to MIME type checking. Invalid files are deleted and rejected with 400.
- **Regex anchoring:** field validation regexes are auto-anchored as `^(?:pattern)$` to prevent partial matches.
- **Duplicate field names:** adding or updating a PDF field checks for an existing field with the same name on the same template (returns 409 if duplicate).
- **Orphaned predefined PDFs:** if a predefined PDF file is missing from disk when requested, the DB record is auto-deleted and a 404 is returned.
- **Env var validation:** `JWT_SECRET` and `DATABASE_URL` are checked at startup; the process exits with an error if either is missing.
- **CORS:** defaults to `http://localhost:3000`; override with `CORS_ORIGIN` env var.

## System Flows

`docs/SYSTEM_FLOWS.md` contains Mermaid diagrams for all major workflows: template upload, PDF generation, status transitions, Google Sheets sync, and user auth.
