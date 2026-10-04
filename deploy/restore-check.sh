#!/usr/bin/env bash
# Proves the newest dump restores. An untested backup is a belief.
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE="${COMPOSE:-docker compose -f docker-compose.prod.yml}"
LOCAL="${BACKUP_DIR:-/srv/planto3d/backups}"
# Explicit, because `ls` of an empty glob under `pipefail` aborts with a
# message about a missing file rather than "there is no dump to check".
NEWEST="$(find "$LOCAL" -name 'pg-*.sql.gz' -type f | sort | tail -1)"
[ -n "$NEWEST" ] || { echo "no dump in ${LOCAL}; run deploy/backup.sh first"; exit 1; }
echo "==> restoring ${NEWEST} into a scratch database"

$COMPOSE exec -T postgres psql -U archiagent -q -c 'DROP DATABASE IF EXISTS restore_check;'
$COMPOSE exec -T postgres psql -U archiagent -q -c 'CREATE DATABASE restore_check;'
gunzip -c "$NEWEST" | $COMPOSE exec -T postgres psql -U archiagent -q -v ON_ERROR_STOP=1 -d restore_check

COUNT="$($COMPOSE exec -T postgres psql -U archiagent -d restore_check -tAc \
  "select count(*) from information_schema.tables where table_schema='public'" | tr -d ' \r')"
$COMPOSE exec -T postgres psql -U archiagent -q -c 'DROP DATABASE restore_check;'

# The schema has four tables (tenants, api_keys, jobs, alembic_version), so
# ">= 3" passed a three-of-four restore — false confidence about the one asset
# that cannot be regenerated.
EXPECTED=4
[ "$COUNT" -ge "$EXPECTED" ] || { echo "restored ${COUNT} tables, expected ${EXPECTED}"; exit 1; }
echo "restore verified: ${COUNT} tables"
