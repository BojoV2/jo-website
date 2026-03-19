# Backend Setup

## Run with Docker

1. From project root:
   ```bash
   docker compose up --build
   ```
2. API base URL:
   `http://localhost:8080/api`
3. Health check:
   `http://localhost:8080/health`
4. Frontend URL:
   `http://localhost:3000`

A super admin is auto-seeded from `backend/.env` on first run.

## Storage Layout

- Templates: `/app/storage/templates`
- Generated PDFs: `/app/storage/generated`

On host machine these map to:
- `./storage/templates`
- `./storage/generated`

## Google Sheets Sync

Each template can have its own Google Spreadsheet.

- Existing templates: a spreadsheet is created or re-linked automatically on backend startup.
- New templates: a spreadsheet is created automatically when the template is added.
- Monthly rollover: every template spreadsheet gets a worksheet tab named `YYYY-MM`, and the backend scheduler ensures the current month tab exists automatically.
- Generated PDF submissions: each generated record is appended to the worksheet for that month.

Required Google service account configuration:

- `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`
- Or use both `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`

Optional settings:

- `GOOGLE_PROJECT_ID`
- `GOOGLE_SHEETS_SHARE_EMAIL` to auto-share each spreadsheet with a user or shared mailbox
- `GOOGLE_SHEETS_SYNC_INTERVAL_MINUTES` to control how often the backend ensures current month sheets for all templates

Recommended Google APIs to enable in the Google Cloud project:

- Google Sheets API
- Google Drive API

## Core Endpoints

### Auth
- `POST /api/auth/register` (public user registration only)
- `POST /api/auth/login` (`identifier` can be email or name)
- `GET /api/auth/me`

### Users (Admin/Super Admin)
- `POST /api/users`
- `GET /api/users`
- `PATCH /api/users/:userId/password`
- `POST /api/users/:userId/password/reset`

### Templates
- `GET /api/templates`
- `POST /api/templates` (multipart form-data: `title`, `description`, `template` file)
- `PUT /api/templates/:templateId`
- `DELETE /api/templates/:templateId`
- `GET /api/templates/:templateId/fields`
- `POST /api/templates/:templateId/fields`
- `PUT /api/templates/fields/:fieldId`
- `DELETE /api/templates/fields/:fieldId`
- `GET /api/templates/:templateId/file`
- `GET /api/templates/presets`
- `POST /api/templates/presets`
- `DELETE /api/templates/presets/:presetId`

### Generated PDFs + Workflow
- `POST /api/generated-pdfs/generate`
- `GET /api/generated-pdfs?template_id=<uuid>&status=pending&user_id=<optional>&keyword=<optional>&date_from=<YYYY-MM-DD>&date_to=<YYYY-MM-DD>`
- `GET /api/generated-pdfs/export?template_id=<uuid>&status=<optional>&format=csv|json`
- `GET /api/generated-pdfs/analytics/template/:templateId`
- `GET /api/generated-pdfs/analytics/templates`
- `PATCH /api/generated-pdfs/:generatedPdfId/status`
- `POST /api/generated-pdfs/bulk-status`
- `GET /api/generated-pdfs/:generatedPdfId/history`
- `GET /api/generated-pdfs/:generatedPdfId/download`

## Status Rules
- On generation: `pending`
- Allowed admin transitions: `done`, `cancelled`, `rescheduled`
- `reschedule_date` allowed only when status is `rescheduled`

## Ubuntu Deployment Notes

1. Install Docker Engine + Docker Compose plugin.
2. Copy project folder to server.
3. Update `backend/.env` with production values (`JWT_SECRET`, DB password).
4. Run:
   ```bash
   docker compose up -d --build
   ```
5. Put a reverse proxy (Nginx/Caddy) in front of port `8080`.
6. Expose frontend port `3000` (or proxy it behind your domain).
