#!/bin/bash
# Nightly backup of the JO PDF Workflow system.
#
#   databases  -> gzipped pg_dump, kept 14 days here and 30 days on the NMS box
#   secrets    -> backend/.env and the compose files (cannot be rebuilt from git)
#   documents  -> storage/ mirrored to the NMS box; anything deleted upstream is
#                 moved into a dated attic there instead of disappearing
#
# Run by cron at 02:30 daily. Writes ~/backups/backup.log and a status file the
# health check reads. Exits non-zero if any step fails.

set -uo pipefail

APP_DIR=/home/uisp/JO/jo-website
LOCAL_DIR=/home/jo-ssh/backups
REMOTE_HOST=imperial999@10.86.0.186
REMOTE_DIR=/home/imperial999/jo-backups
SSH_KEY=/home/jo-ssh/.ssh/id_ed25519_backup
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"
KEEP_LOCAL_DAYS=14
KEEP_REMOTE_DAYS=30

STAMP=$(date +%Y%m%d-%H%M%S)
DAY=$(date +%Y%m%d)
DEST="$LOCAL_DIR/daily/$DAY"
LOG="$LOCAL_DIR/backup.log"
STATUS="$LOCAL_DIR/last-run.txt"
failures=0

mkdir -p "$DEST" "$LOCAL_DIR"

log() {
  printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" | tee -a "$LOG"
}

fail() {
  log "FAILED: $1"
  failures=$((failures + 1))
}

log "=== backup start ($STAMP) ==="

# ---------------------------------------------------------------- databases
if docker exec pdf_workflow_db pg_dump -U postgres -d pdf_workflow --clean --if-exists \
     | gzip > "$DEST/jo-pdf_workflow-$STAMP.sql.gz"; then
  if gzip -t "$DEST/jo-pdf_workflow-$STAMP.sql.gz"; then
    size=$(du -h "$DEST/jo-pdf_workflow-$STAMP.sql.gz" | cut -f1)
    rows=$(docker exec pdf_workflow_db psql -U postgres -d pdf_workflow -tAc \
           "SELECT count(*) FROM generated_pdfs" 2>/dev/null | tr -d '[:space:]')
    log "JO database dumped ($size, generated_pdfs=$rows)"
  else
    fail "JO dump is not a valid gzip"
  fi
else
  fail "JO pg_dump"
fi

if docker exec peering-manager-docker-postgres-1 sh -c 'pg_dumpall -U "$POSTGRES_USER"' \
     | gzip > "$DEST/peering-manager-$STAMP.sql.gz"; then
  gzip -t "$DEST/peering-manager-$STAMP.sql.gz" \
    && log "Peering Manager database dumped ($(du -h "$DEST/peering-manager-$STAMP.sql.gz" | cut -f1))" \
    || fail "Peering Manager dump is not a valid gzip"
else
  fail "Peering Manager pg_dumpall"
fi

# ---------------------------------------------------------------- secrets
cp "$APP_DIR/backend/.env" "$DEST/backend-env-$STAMP.txt" 2>/dev/null \
  && log "backend/.env copied" || fail "copying backend/.env"
cp "$APP_DIR/docker-compose.yml" "$DEST/docker-compose-$STAMP.yml" 2>/dev/null
cp "$APP_DIR/docker-compose.prod.yml" "$DEST/docker-compose-prod-$STAMP.yml" 2>/dev/null
chmod 600 "$DEST"/backend-env-*.txt 2>/dev/null

# ---------------------------------------------------------------- documents
if rsync -a --delete --human-readable \
      --backup --backup-dir="$REMOTE_DIR/deleted/$DAY" \
      -e "ssh $SSH_OPTS" \
      "$APP_DIR/storage/" "$REMOTE_HOST:$REMOTE_DIR/storage/" >> "$LOG" 2>&1; then
  files=$(find "$APP_DIR/storage" -type f | wc -l)
  log "storage mirrored off-box ($files files)"
else
  fail "storage rsync to $REMOTE_HOST"
fi

# ---------------------------------------------------------------- dumps off-box
if rsync -a --human-readable -e "ssh $SSH_OPTS" \
      "$LOCAL_DIR/daily/" "$REMOTE_HOST:$REMOTE_DIR/db/" >> "$LOG" 2>&1; then
  log "database dumps copied off-box"
else
  fail "dump rsync to $REMOTE_HOST"
fi

# ---------------------------------------------------------------- retention
find "$LOCAL_DIR/daily" -mindepth 1 -maxdepth 1 -type d -mtime +$KEEP_LOCAL_DAYS -exec rm -rf {} + 2>/dev/null

# mkdir first: the attic only exists once something upstream has been deleted,
# and running find against a missing directory would report the whole sweep as
# a failure.
ssh $SSH_OPTS "$REMOTE_HOST" \
  "mkdir -p $REMOTE_DIR/db $REMOTE_DIR/deleted $REMOTE_DIR/storage;
   find $REMOTE_DIR/db -mindepth 1 -maxdepth 1 -type d -mtime +$KEEP_REMOTE_DAYS -exec rm -rf {} + 2>/dev/null;
   find $REMOTE_DIR/deleted -mindepth 1 -maxdepth 1 -type d -mtime +$KEEP_REMOTE_DAYS -exec rm -rf {} + 2>/dev/null;
   exit 0" \
  >> "$LOG" 2>&1 || fail "remote retention sweep"

# ---------------------------------------------------------------- report
local_size=$(du -sh "$LOCAL_DIR/daily" 2>/dev/null | cut -f1)
remote_size=$(ssh $SSH_OPTS "$REMOTE_HOST" "du -sh $REMOTE_DIR 2>/dev/null | cut -f1" 2>/dev/null)

if [ "$failures" -eq 0 ]; then
  printf 'OK %s local=%s remote=%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$local_size" "$remote_size" > "$STATUS"
  log "=== backup OK (local $local_size, off-box $remote_size) ==="
else
  printf 'FAILED %s failures=%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$failures" > "$STATUS"
  log "=== backup finished with $failures failure(s) ==="
fi

# keep the log from growing without limit
tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"

exit "$failures"
