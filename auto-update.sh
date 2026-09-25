#!/usr/bin/env bash
set -euo pipefail

REMOTE="${1:-origin}"
BRANCH="${2:-main}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "[1/4] Fetching ${REMOTE}/${BRANCH}..."
git fetch "$REMOTE" "$BRANCH"

echo "[2/4] Checking out ${BRANCH}..."
git checkout "$BRANCH"

echo "[3/4] Pulling latest changes (rebase)..."
git pull --rebase "$REMOTE" "$BRANCH"

# Always include the prod overlay: without it the frontend comes back up as
# the Vite dev server, which serves raw source and skips the production build.
COMPOSE=(compose -f docker-compose.yml -f docker-compose.prod.yml)

echo "[4/4] Building and starting containers..."
if docker info >/dev/null 2>&1; then
  DOCKER=(docker)
elif sudo -n docker info >/dev/null 2>&1; then
  DOCKER=(sudo -n docker)
else
  echo "Docker requires elevated privileges."
  echo "Run once manually with:"
  echo "  sudo docker ${COMPOSE[*]} up --build -d"
  echo "Or add this user to the docker group for passwordless docker access."
  exit 1
fi
"${DOCKER[@]}" "${COMPOSE[@]}" up --build -d

# The TLS proxy caches container IPs; after a recreate it 502s until restarted.
if "${DOCKER[@]}" ps --format "{{.Names}}" | grep -qx pdf_workflow_tls; then
  "${DOCKER[@]}" restart pdf_workflow_tls >/dev/null
fi

echo "Done. Current commit:"
git rev-parse --short HEAD
