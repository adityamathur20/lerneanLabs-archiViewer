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

# Written straight into .env rather than printed. A secret echoed to a
# terminal ends up in scrollback, in CI logs, and in any transcript of the
# session — which happened once and cost a key rotation.
echo "==> writing the access key into .env"
python3 - "$KEY_NAME" <<'PYEOF'
import re, subprocess, sys
from pathlib import Path
name = sys.argv[1]
out = subprocess.run(
    ["docker", "compose", "-f", "docker-compose.prod.yml", "exec", "-T", "garage",
     "/garage", "key", "info", name, "--show-secret"],
    capture_output=True, text=True, check=False).stdout
ak = re.search(r"Key ID:\s*(\S+)", out)
sk = re.search(r"Secret key:\s*(\S+)", out)
if not (ak and sk):
    sys.exit("could not read the key; run `garage key info` by hand")
env = Path(".env")
if not env.exists():
    sys.exit(".env does not exist yet; copy it from .env.example first")
s = env.read_text()
s = re.sub(r"^ARCHIAGENT_SERVICE_S3_ACCESS_KEY=.*$",
           f"ARCHIAGENT_SERVICE_S3_ACCESS_KEY={ak.group(1)}", s, flags=re.M)
s = re.sub(r"^ARCHIAGENT_SERVICE_S3_SECRET_KEY=.*$",
           f"ARCHIAGENT_SERVICE_S3_SECRET_KEY={sk.group(1)}", s, flags=re.M)
env.write_text(s)
print(f"   access key {ak.group(1)[:12]}… written; secret not printed")
PYEOF
