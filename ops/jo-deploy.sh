#!/bin/bash
# Deploy the JO website to production and verify with smoke test.
# Usage: bash ops/jo-deploy.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"

echo "[deploy] pulling latest..."
git -C "$APP" pull --ff-only

echo "[deploy] rebuilding backend..."
docker compose -f "$APP/docker-compose.yml" -f "$APP/docker-compose.prod.yml" \
  up -d --no-deps --build backend

echo "[deploy] rebuilding frontend..."
docker compose -f "$APP/docker-compose.yml" -f "$APP/docker-compose.prod.yml" \
  up -d --no-deps --build frontend
docker restart pdf_workflow_tls

echo "[deploy] waiting for services..."
sleep 5

echo "[deploy] running smoke test..."
bash "$HERE/jo-smoke-test.sh" pdf_workflow_tls

echo "[deploy] done."
