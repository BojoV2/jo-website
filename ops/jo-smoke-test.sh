#!/bin/bash
# End-to-end smoke test for the JO website. Run after every deploy:
#   ssh jo 'bash /home/uisp/JO/jo-website/ops/jo-smoke-test.sh'              (live site)
#   ssh jo 'bash /home/uisp/JO/jo-website/ops/jo-smoke-test.sh fetest_tls'   (a test copy)
# Creates two throwaway accounts (zz-smoke-*), generates one PDF, exercises the
# API, then deletes every row and file those accounts produced. Exit 0 = healthy.
set -u
TARGET="${1:-pdf_workflow_tls}"
HERE="$(cd "$(dirname "$0")" && pwd)"
STORAGE="${JO_STORAGE:-$(cd "$HERE/.." && pwd)/storage}"
NET=jo-website_default
DB=pdf_workflow_db
PW="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)Aa9"

sql() { docker exec -i "$DB" psql -U postgres -d pdf_workflow -v ON_ERROR_STOP=1 -q "$@"; }

cleanup() {
  local files
  files=$(sql -At <<'SQL'
SELECT g.file_path FROM generated_pdfs g JOIN users u ON u.id = g.user_id
 WHERE u.email LIKE 'zz-smoke-%@test.local';
SQL
)
  sql <<'SQL'
BEGIN;
CREATE TEMP TABLE zz_u AS SELECT id FROM users WHERE email LIKE 'zz-smoke-%@test.local';
CREATE TEMP TABLE zz_p AS SELECT id FROM generated_pdfs WHERE user_id IN (SELECT id FROM zz_u);
CREATE TEMP TABLE zz_j AS SELECT id FROM fe_jobs WHERE generated_pdf_id IN (SELECT id FROM zz_p);
DELETE FROM fe_visits WHERE job_id IN (SELECT id FROM zz_j);
DELETE FROM fe_audit WHERE job_id IN (SELECT id FROM zz_j);
DELETE FROM fe_jobs WHERE id IN (SELECT id FROM zz_j);
DELETE FROM generated_pdf_attachments WHERE generated_pdf_id IN (SELECT id FROM zz_p);
DELETE FROM status_history WHERE generated_pdf_id IN (SELECT id FROM zz_p);
DELETE FROM generated_pdfs WHERE id IN (SELECT id FROM zz_p);
UPDATE status_history SET changed_by = NULL WHERE changed_by IN (SELECT id FROM zz_u);
DELETE FROM users WHERE id IN (SELECT id FROM zz_u);
DELETE FROM account_audit WHERE actor_name LIKE 'zz-smoke-%' OR target_name LIKE 'zz-smoke-%';
COMMIT;
SQL
  local f
  for f in $files; do
    case "$f" in generated/*.pdf) case "$f" in *..*) ;; *) rm -f -- "$STORAGE/$f" ;; esac ;; esac
  done
}
trap cleanup EXIT

cleanup   # leftovers from an interrupted earlier run

HASH=$(docker exec -e P="$PW" pdf_workflow_backend node -e 'console.log(require("bcryptjs").hashSync(process.env.P, 10))')
sql -v h="$HASH" <<'SQL'
INSERT INTO users (id, name, email, password_hash, role) VALUES
  (gen_random_uuid(), 'zz-smoke-admin', 'zz-smoke-admin@test.local', :'h', 'admin'),
  (gen_random_uuid(), 'zz-smoke-user',  'zz-smoke-user@test.local',  :'h', 'user');
SQL

echo "JO smoke test against https://$TARGET  ($(date '+%F %T'))"
docker run --rm --network "$NET" \
  -e NODE_TLS_REJECT_UNAUTHORIZED=0 -e NODE_NO_WARNINGS=1 -e SMOKE_PW="$PW" \
  -v "$HERE/smoke:/smoke:ro" \
  jo-website-backend:latest sh -c 'node /smoke/smoke.mjs "https://'"$TARGET"'" "$SMOKE_PW"'
rc=$?
[ "$rc" -eq 0 ] && echo "RESULT: healthy" || echo "RESULT: $rc check(s) failed"
exit "$rc"
