# Ops scripts

Copies of what runs on the JO host, kept here so they are versioned and reviewable.

- `jo-backup.sh` — nightly (cron 02:30, user jo-ssh): dumps both databases, copies backend/.env and the compose files, streams storage/ off-box as encrypted archives, encrypts everything that leaves the host, prunes to 14 days local / 30 days off-box / 4 full archives, writes ~/backups/last-run.txt.
- `jo-health-check.sh` — run after a reboot or any change: host memory, IP drift, containers, API, row counts, storage, backup freshness. Exit 0 means healthy.

Both live at /home/jo-ssh/ on the host; edit there and copy back.
