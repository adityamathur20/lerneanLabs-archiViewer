#!/usr/bin/env bash
# Proves the newest dump restores. An untested backup is a belief.
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE="${COMPOSE:-docker compose -f docker-compose.prod.yml}"
LOCAL="${BACKUP_DIR:-/var/backups/planto3d}"
NEWEST="$(ls -t "$LOCAL"/pg-*.sql.gz | head -1)"
echo "==> restoring ${NEWEST} into a scratch database"

$COMPOSE exec -T postgres psql -U archiagent -q -c 'DROP DATABASE IF EXISTS restore_check;'
$COMPOSE exec -T postgres psql -U archiagent -q -c 'CREATE DATABASE restore_check;'
gunzip -c "$NEWEST" | $COMPOSE exec -T postgres psql -U archiagent -q -d restore_check

COUNT="$($COMPOSE exec -T postgres psql -U archiagent -d restore_check -tAc \
  "select count(*) from information_schema.tables where table_schema='public'" | tr -d ' \r')"
$COMPOSE exec -T postgres psql -U archiagent -q -c 'DROP DATABASE restore_check;'

[ "$COUNT" -ge 3 ] || { echo "restored only ${COUNT} tables; expected tenants, api_keys, jobs"; exit 1; }
echo "restore verified: ${COUNT} tables"
