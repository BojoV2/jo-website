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

echo "[4/4] Building and starting containers..."
if docker info >/dev/null 2>&1; then
  docker compose up --build -d
elif sudo -n docker info >/dev/null 2>&1; then
  sudo -n docker compose up --build -d
else
  echo "Docker requires elevated privileges."
  echo "Run once manually with:"
  echo "  sudo docker compose up --build -d"
  echo "Or add this user to the docker group for passwordless docker access."
  exit 1
fi

echo "Done. Current commit:"
git rev-parse --short HEAD
