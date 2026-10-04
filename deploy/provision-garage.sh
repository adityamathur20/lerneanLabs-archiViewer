#!/usr/bin/env bash
# One-time Garage setup: layout, bucket, key, grant. Idempotent — safe to
# re-run. Nothing in the application creates its own bucket (spec §4.2).
set -euo pipefail

COMPOSE="${COMPOSE:-docker compose -f docker-compose.prod.yml}"
BUCKET="${BUCKET:-archiagent}"
KEY_NAME="${KEY_NAME:-archiagent-service}"
g() { $COMPOSE exec -T garage /garage "$@"; }

echo "==> waiting for garage to answer"
for _ in $(seq 1 30); do g status >/dev/null 2>&1 && break; sleep 2; done
g status >/dev/null || { echo "garage never came up"; exit 1; }

echo "==> assigning a single-node layout (no-op if already assigned)"
NODE_ID="$(g node id -q 2>/dev/null | cut -d@ -f1)"
if ! g layout show 2>/dev/null | grep -q "$NODE_ID"; then
  g layout assign "$NODE_ID" -z dc1 -c 90G
  g layout apply --version 1
fi

echo "==> bucket"
g bucket info "$BUCKET" >/dev/null 2>&1 || g bucket create "$BUCKET"

echo "==> key"
if ! g key info "$KEY_NAME" >/dev/null 2>&1; then
  g key create "$KEY_NAME"
fi
# --read --write only. NOT --owner: storage.py uses put/get/head/list/
# delete-object exclusively, while owner adds bucket-level authority
# (DeleteBucket, PutBucketWebsite) that would be reachable with a leaked
# key over the public s3 endpoint.
g bucket allow --read --write "$BUCKET" --key "$KEY_NAME"

echo
echo "==> put these in .env (shown once):"
g key info "$KEY_NAME" --show-secret | grep -Ei 'key id|secret'
