#!/usr/bin/env bash
# Nightly: dump Postgres, keep it in Garage AND off the box. A dump that only
# exists on the disk it protects is not a backup (spec §10).
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE="${COMPOSE:-docker compose -f docker-compose.prod.yml}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="pg-${STAMP}.sql.gz"
LOCAL="${BACKUP_DIR:-/var/backups/planto3d}"
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
echo "backup ${NAME} complete (${SIZE} bytes)"
echo "REMINDER: the offsite copy is a separate step — see deploy/README.md section 10"
