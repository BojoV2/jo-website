# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Full-stack PDF workflow management system. Admins upload PDF templates and configure field coordinates; users fill forms that generate PDFs. Includes role-based access, a status workflow (pending/done/cancelled/rescheduled), and optional Google Sheets sync.

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
- **Backend:** Node.js + Express (ES modules), PostgreSQL 16, pdf-lib for PDF generation, JWT auth
- **Frontend:** React 18 + Vite, Framer Motion, pdfjs-dist for rendering, Recharts for analytics

### Backend structure (`backend/src/`)
- `index.js` — Entry point; starts server and schedules Google Sheets sync
- `app.js` — Express app, CORS config, route registration
- `bootstrap.js` — Runs DB schema init on startup
- `db.js` — PostgreSQL connection pool (via `pg`)
- `middleware/auth.js` — JWT verification + role-based guards (`requireRole`)
- `routes/` — Four route modules: `auth`, `users`, `templates`, `generatedPdfs`
- `services/pdfService.js` — Core PDF rendering: inserts text at x/y coordinates per page using pdf-lib
- `services/googleSheetsService.js` — Syncs generated PDF submissions to Google Sheets (monthly tabs)

### Frontend structure (`frontend/src/`)
- `App.jsx` — Session management (localStorage/sessionStorage), theme toggle, lazy-loads `AdminPanel` and `UserPanel`
- `api.js` — Fetch wrapper that injects JWT from storage into all requests
- `components/AdminPanel.jsx` — Template upload, PDF field coordinate mapping, workflow kanban board
- `components/UserPanel.jsx` — Template selection, form filling, PDF preview and download
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
CORS_ORIGIN=*
STORAGE_ROOT=/app/storage
# Optional Google Sheets:
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_PRIVATE_KEY=
GOOGLE_SHEETS_SYNC_INTERVAL_MINUTES=60
```

## System Flows

`docs/SYSTEM_FLOWS.md` contains Mermaid diagrams for all major workflows: template upload, PDF generation, status transitions, Google Sheets sync, and user auth.
