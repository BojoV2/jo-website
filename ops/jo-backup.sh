#!/bin/bash
# Nightly backup of the JO PDF Workflow system.
#
#   databases  -> gzipped pg_dump, encrypted, kept 14 days here / 30 days off-box
#   secrets    -> backend/.env and the project .env (cannot be rebuilt from git)
#   documents  -> storage/ as encrypted archives: a full one on Sundays, an
#                 incremental of what changed on the other days
#
# Everything that leaves this host is AES-256 encrypted with the passphrase in
# $PASS_FILE, so the backup server never holds readable customer documents.
#
# Run by cron at 02:30 daily. Writes ~/backups/backup.log and a status file the
# health check reads. Exits non-zero if any step fails.

set -uo pipefail

APP_DIR=/home/uisp/JO/jo-website
LOCAL_DIR=/home/jo-ssh/backups
REMOTE_HOST=zabbix@10.86.0.141
REMOTE_DIR=/home/zabbix/jo-backups
SSH_KEY=/home/jo-ssh/.ssh/id_ed25519_backup
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"
PASS_FILE=/home/jo-ssh/.jo-backup-pass
KEEP_LOCAL_DAYS=14
KEEP_REMOTE_DAYS=30
KEEP_FULL_ARCHIVES=4

# The passphrase lives only on this host, chmod 600 - keep a copy somewhere
# else, or losing this machine also makes every off-box copy unreadable.
if [ ! -s "$PASS_FILE" ]; then
  openssl rand -base64 48 > "$PASS_FILE"
  chmod 600 "$PASS_FILE"
fi

STAMP=$(date +%Y%m%d-%H%M%S)
DAY=$(date +%Y%m%d)
DEST="$LOCAL_DIR/daily/$DAY"
LOG="$LOCAL_DIR/backup.log"
STATUS="$LOCAL_DIR/last-run.txt"
MARKER="$LOCAL_DIR/.storage-full-marker"
failures=0

mkdir -p "$DEST" "$LOCAL_DIR"

log() {
  printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" | tee -a "$LOG"
}

fail() {
  log "FAILED: $1"
  failures=$((failures + 1))
}

encrypt() {
  # encrypt <file> -> <file>.enc, plaintext removed
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
    -pass "file:$PASS_FILE" -in "$1" -out "$1.enc" && rm -f "$1"
}

remote() {
  ssh $SSH_OPTS "$REMOTE_HOST" "$@"
}

log "=== backup start ($STAMP) ==="
remote "mkdir -p $REMOTE_DIR/db $REMOTE_DIR/storage" >> "$LOG" 2>&1 || fail "preparing the backup server"

# ---------------------------------------------------------------- databases
if docker exec pdf_workflow_db pg_dump -U postgres -d pdf_workflow --clean --if-exists \
     | gzip > "$DEST/jo-pdf_workflow-$STAMP.sql.gz"; then
  if gzip -t "$DEST/jo-pdf_workflow-$STAMP.sql.gz"; then
    size=$(du -h "$DEST/jo-pdf_workflow-$STAMP.sql.gz" | cut -f1)
    rows=$(docker exec pdf_workflow_db psql -U postgres -d pdf_workflow -tAc \
           "SELECT count(*) FROM generated_pdfs" 2>/dev/null | tr -d '[:space:]')
    encrypt "$DEST/jo-pdf_workflow-$STAMP.sql.gz" || fail "encrypting the JO dump"
    log "JO database dumped and encrypted ($size, generated_pdfs=$rows)"
  else
    fail "JO dump is not a valid gzip"
  fi
else
  fail "JO pg_dump"
fi

if docker exec peering-manager-docker-postgres-1 sh -c 'pg_dumpall -U "$POSTGRES_USER"' \
     | gzip > "$DEST/peering-manager-$STAMP.sql.gz"; then
  if gzip -t "$DEST/peering-manager-$STAMP.sql.gz"; then
    pm_size=$(du -h "$DEST/peering-manager-$STAMP.sql.gz" | cut -f1)
    encrypt "$DEST/peering-manager-$STAMP.sql.gz" || fail "encrypting the Peering Manager dump"
    log "Peering Manager database dumped and encrypted ($pm_size)"
  else
    fail "Peering Manager dump is not a valid gzip"
  fi
else
  fail "Peering Manager pg_dumpall"
fi

# ---------------------------------------------------------------- secrets
if cp "$APP_DIR/backend/.env" "$DEST/backend-env-$STAMP.txt" 2>/dev/null; then
  chmod 600 "$DEST/backend-env-$STAMP.txt"
  encrypt "$DEST/backend-env-$STAMP.txt" \
    && log "backend/.env copied and encrypted" || fail "encrypting backend/.env"
else
  fail "copying backend/.env"
fi

# the project .env carries the database password that compose substitutes in
if cp "$APP_DIR/.env" "$DEST/project-env-$STAMP.txt" 2>/dev/null; then
  chmod 600 "$DEST/project-env-$STAMP.txt"
  encrypt "$DEST/project-env-$STAMP.txt" || fail "encrypting the project .env"
fi

cp "$APP_DIR/docker-compose.yml" "$DEST/docker-compose-$STAMP.yml" 2>/dev/null
cp "$APP_DIR/docker-compose.prod.yml" "$DEST/docker-compose-prod-$STAMP.yml" 2>/dev/null

# ---------------------------------------------------------------- documents
# Customer documents are archived, encrypted, then streamed straight to the
# backup server - nothing readable is written there, and no plaintext copy is
# staged locally. Sunday (or a missing marker) takes a full archive; other days
# only carry what changed since that full.
# No gzip: the archive is nearly all PDFs and images, which do not compress,
# and squeezing them cost ~19 minutes of CPU on this 5 GB host for nothing.
# tar exits 1 when a file is written while being read - staff generate PDFs all
# day, so that warning is expected and only exit 2 is a real failure.
archive_storage() {
  local archive="$1"
  local status
  shift
  "$@" \
    | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$PASS_FILE" \
    | remote "cat > $REMOTE_DIR/storage/$archive"
  status=("${PIPESTATUS[@]}")
  [ "${status[0]}" -le 1 ] && [ "${status[1]}" -eq 0 ] && [ "${status[2]}" -eq 0 ]
}

if [ "$(date +%u)" = "7" ] || [ ! -f "$MARKER" ]; then
  ARCHIVE="storage-full-$DAY.tar.enc"
  log "storage: taking a full archive"
  if archive_storage "$ARCHIVE" tar -C "$APP_DIR" --warning=no-file-changed -cf - storage; then
    touch "$MARKER"
    files=$(find "$APP_DIR/storage" -type f | wc -l)
    remote_size=$(remote "du -h $REMOTE_DIR/storage/$ARCHIVE | cut -f1")
    log "storage full archive sent ($files files, $remote_size encrypted)"
  else
    fail "storage full archive"
  fi
else
  ARCHIVE="storage-since-$(date -r "$MARKER" +%Y%m%d)-$DAY.tar.enc"
  CHANGED_LIST=$(mktemp)
  find "$APP_DIR/storage" -type f -newer "$MARKER" -printf 'storage/%P\n' > "$CHANGED_LIST"
  changed=$(wc -l < "$CHANGED_LIST")
  if [ "$changed" -eq 0 ]; then
    log "storage: nothing changed since the last full archive"
  elif archive_storage "$ARCHIVE" tar -C "$APP_DIR" --warning=no-file-changed -cf - -T "$CHANGED_LIST"; then
    remote_size=$(remote "du -h $REMOTE_DIR/storage/$ARCHIVE | cut -f1")
    log "storage incremental sent ($changed changed files, $remote_size encrypted)"
  else
    fail "storage incremental archive"
  fi
  rm -f "$CHANGED_LIST"
fi

# ---------------------------------------------------------------- dumps off-box
if rsync -a --human-readable -e "ssh $SSH_OPTS" \
      "$LOCAL_DIR/daily/" "$REMOTE_HOST:$REMOTE_DIR/db/" >> "$LOG" 2>&1; then
  log "database dumps and secrets copied off-box (encrypted)"
else
  fail "dump rsync to $REMOTE_HOST"
fi

# ---------------------------------------------------------------- retention
find "$LOCAL_DIR/daily" -mindepth 1 -maxdepth 1 -type d -mtime +$KEEP_LOCAL_DAYS -exec rm -rf {} + 2>/dev/null

remote "mkdir -p $REMOTE_DIR/db $REMOTE_DIR/storage;
        find $REMOTE_DIR/db -mindepth 1 -maxdepth 1 -type d -mtime +$KEEP_REMOTE_DAYS -exec rm -rf {} + 2>/dev/null;
        ls -1t $REMOTE_DIR/storage/storage-full-*.tar.enc 2>/dev/null | tail -n +$((KEEP_FULL_ARCHIVES + 1)) | xargs -r rm -f;
        oldest_full=\$(ls -1t $REMOTE_DIR/storage/storage-full-*.tar.enc 2>/dev/null | tail -1);
        [ -n \"\$oldest_full\" ] && find $REMOTE_DIR/storage -name 'storage-since-*' ! -newer \"\$oldest_full\" -delete 2>/dev/null;
        exit 0" >> "$LOG" 2>&1 || fail "remote retention sweep"

# ---------------------------------------------------------------- report
local_size=$(du -sh "$LOCAL_DIR/daily" 2>/dev/null | cut -f1)
remote_size=$(remote "du -sh $REMOTE_DIR 2>/dev/null | cut -f1" 2>/dev/null)
remote_free=$(remote "df -h / | tail -1 | awk '{print \$4}'" 2>/dev/null)

if [ "$failures" -eq 0 ]; then
  printf 'OK %s local=%s remote=%s free=%s host=%s\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$local_size" "$remote_size" "$remote_free" "$REMOTE_HOST" > "$STATUS"
  log "=== backup OK (local $local_size, off-box $remote_size on $REMOTE_HOST, $remote_free free) ==="
else
  printf 'FAILED %s failures=%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$failures" > "$STATUS"
  log "=== backup finished with $failures failure(s) ==="
fi

tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"

exit "$failures"
