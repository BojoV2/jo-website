# Ops scripts

Copies of what runs on the JO host, kept here so they are versioned and reviewable.

- `jo-backup.sh` — nightly (cron 02:30, user jo-ssh): dumps both databases, copies backend/.env and the compose files, streams storage/ off-box as encrypted archives, encrypts everything that leaves the host, prunes to 14 days local / 30 days off-box / 4 full archives, writes ~/backups/last-run.txt.
- `jo-health-check.sh` — run after a reboot or any change: host memory, IP drift, containers, API, row counts, storage, backup freshness. Exit 0 means healthy.

Both live at /home/jo-ssh/ on the host; edit there and copy back.
- `jo-smoke-test.sh` — run after every deploy (from the repo, not ~/): signs in as two throwaway accounts, generates and downloads a PDF, changes its status, reads every application and tool, and checks user management (access, disable, audit trail), then deletes everything it created. Exit 0 means healthy. `bash ops/jo-smoke-test.sh` for the live site, `bash ops/jo-smoke-test.sh fetest_tls` for a test copy.

The backend runs `npm start` (not nodemon) through docker-compose.prod.yml: code changes need `./auto-update.sh` or a container recreate to take effect.
