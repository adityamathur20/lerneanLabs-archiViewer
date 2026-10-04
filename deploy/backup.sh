#!/usr/bin/env bash
# Nightly: dump Postgres, keep it in Garage AND off the box. A dump that only
# exists on the disk it protects is not a backup (spec §10).
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE="${COMPOSE:-docker compose -f docker-compose.prod.yml}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="pg-${STAMP}.sql.gz"
# Under /srv/planto3d, which `deploy` owns. /var/backups is root:root 0755, so
# the cron job the runbook installs in deploy's crontab died on its first
# command — and because the log redirect needed root too, it died silently.
LOCAL="${BACKUP_DIR:-/srv/planto3d/backups}"
mkdir -p "$LOCAL"

$COMPOSE exec -T postgres pg_dump -U archiagent archiagent | gzip -9 > "${LOCAL}/${NAME}"

# Refuse to keep a dump that is suspiciously small — an empty dump is worse
# than no dump, because it looks like success.
SIZE=$(wc -c < "${LOCAL}/${NAME}" | tr -d ' ')
[ "$SIZE" -gt 1024 ] || { echo "dump is only ${SIZE} bytes; refusing"; rm -f "${LOCAL}/${NAME}"; exit 1; }

# Into the object store, so it is covered by whatever protects artifacts.
$COMPOSE cp "${LOCAL}/${NAME}" "api:/tmp/${NAME}"
$COMPOSE cp deploy/upload-backup.py "api:/tmp/upload-backup.py"
$COMPOSE exec -T -e BACKUP_NAME="$NAME" api python /tmp/upload-backup.py
# As root: `compose cp` writes these as root, and the container runs as
# appuser, so appuser cannot remove them. Under `set -e` a failed cleanup
# would abort a backup that had already succeeded.
$COMPOSE exec -T --user root api rm -f "/tmp/${NAME}" /tmp/upload-backup.py

find "$LOCAL" -name 'pg-*.sql.gz' -mtime +14 -delete

# The object-store copy needs pruning too; it shares the 100 GB disk with every
# artifact. Keeps the newest 14.
$COMPOSE cp deploy/prune-backups.py "api:/tmp/prune-backups.py"
$COMPOSE exec -T -e KEEP=14 api python /tmp/prune-backups.py
$COMPOSE exec -T --user root api rm -f /tmp/prune-backups.py
# I8 / spec §12.7: offsite is the ONLY thing that survives losing the VPS, so
# it runs here rather than living in a README as a reminder nobody actions.
if [ -n "${OFFSITE_REMOTE:-}" ]; then
  if command -v rclone >/dev/null 2>&1; then
    rclone copy "${LOCAL}/${NAME}" "${OFFSITE_REMOTE}" --no-traverse
    echo "offsite copy -> ${OFFSITE_REMOTE}/${NAME}"
  else
    echo "ERROR: OFFSITE_REMOTE is set but rclone is not installed" >&2
    exit 1
  fi
else
  # Loud, on stderr, every single night. Both existing copies are on the disk
  # this is supposed to protect, so without this the backup is theatre.
  echo "WARNING: OFFSITE_REMOTE is unset — this dump exists only on the VPS it protects." >&2
  echo "         Set it (e.g. OFFSITE_REMOTE=b2:planto3d-backups) or losing the box loses the job index." >&2
fi

echo "backup ${NAME} complete (${SIZE} bytes)"
