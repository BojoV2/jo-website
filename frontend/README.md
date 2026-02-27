# Frontend

Vite + React web client for the PDF workflow system.

## Features
- Login screen
- Role-based UI:
  - Admin/Super Admin: template upload, field mapping, workflow status board
  - User: template form fill, PDF generation, personal status tabs
- Secure file download using JWT

## Access
- Local: `http://localhost:3000`
- LAN: `http://<server-ip>:3000`

The frontend auto-targets API at `http://<current-host>:8080/api` unless `VITE_API_BASE_URL` is set.