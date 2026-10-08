# Deploying planto3d

One Hostinger KVM 2, Ubuntu 24.04 LTS, Bangalore. Spec:
`lerneanLabs-archiAgent/docs/superpowers/specs/2026-10-04-phase6-public-deployment-design.md`

Every command below was run against this compose file locally before being
written down, except the ones that need real DNS (marked).

## 1. The VPS

| Setting | Value |
|---|---|
| Plan | KVM 2 — 2 vCPU / 8 GB / 100 GB NVMe |
| Location | Bangalore |
| OS | Ubuntu 24.04 LTS (the "with Docker" image if offered) |
| Control panel | **None.** A panel template binds :80/:443 and fights Caddy |
| Auth | Upload an SSH public key at creation |

Hostinger's Docker Manager is fine as a read-only log view. Do not deploy
through it — see spec §7.4.

## 2. DNS — before the first `up`

**Five** A records at the registrar, all to the VPS IPv4:

| Host | Type | Value |
|---|---|---|
| `planto3d.in` | A | VPS IP |
| `www.planto3d.in` | A | VPS IP |
| `api.planto3d.in` | A | VPS IP |
| `s3.planto3d.in` | A | VPS IP |
| `planto3d.si` | A | VPS IP |

- Delete the registrar's parking records.
- Add **no** AAAA unless Hostinger assigned IPv6 — an AAAA pointing nowhere
  gives intermittent IPv6-only failures that read as random downtime.
- `s3.planto3d.in` is **not optional**: presigned URLs sign the host, so the
  browser must reach the same name the signature was made for (spec §4.3).
- There is deliberately **no `www.planto3d.si`**. Caddy serves exactly these
  five names; a sixth name with no record would be retried forever, spending
  Let's Encrypt failed-validation attempts and filling the log with
  "obtaining certificate" — which is the signal section 9 uses to confirm
  certificate state persisted.

```bash
for h in planto3d.in www.planto3d.in api.planto3d.in s3.planto3d.in planto3d.si; do
  echo -n "$h -> "; dig +short "$h" | tail -1
done
```

Caddy orders certificates at boot. Deploying before DNS resolves spends
Let's Encrypt rate limit on failures, so do this first.

## 3. Harden the box

**Everything in this section is as `root`. From section 4 onward you are
`deploy`** — that boundary matters, because files created by root inside a
deploy-owned tree make every later `git pull` fail.

```bash
ssh root@VPS_IP
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/
chown deploy:deploy /home/deploy/.ssh/authorized_keys

# Everything deploy needs to own, created now so deploy never needs sudo.
install -d -o deploy -g deploy /srv/planto3d
install -d -o deploy -g deploy /srv/planto3d/backups
install -o deploy -g deploy /dev/null /var/log/planto3d-backup.log

# SSH hardening goes in a drop-in, NOT sshd_config: Ubuntu cloud images ship
# /etc/ssh/sshd_config.d/50-cloud-init.conf with `PasswordAuthentication yes`,
# Include files are parsed first, and FIRST MATCH WINS — so editing
# sshd_config alone can leave password auth on while printing no error.
cat > /etc/ssh/sshd_config.d/01-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
# Key-only root, not `no`: the deploy user deliberately has no sudo, so this
# keeps one administrative path rather than leaving the provider's recovery
# console as the only way back in.
PermitRootLogin prohibit-password
EOF
systemctl reload ssh

# Verify it took, rather than assuming. These must print "no".
sshd -T | grep -E '^(passwordauthentication|permitrootlogin|kbdinteractiveauthentication) '

ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw --force enable

apt-get update && apt-get install -y unattended-upgrades fail2ban rclone
systemctl enable --now fail2ban
fail2ban-client status sshd   # confirm the jail actually resolved
```

**Open a second SSH session as `deploy` and confirm it works before closing the
root one.** Locking yourself out here costs a VPS rebuild.

Note on `ufw`: Docker writes its own iptables rules and bypasses ufw's INPUT
chain for published ports. Only 80/443 are published and both are allowed
anyway, so there is no gap today — but ufw is not what is protecting the
container ports, the absence of port publishing is.

If Docker was not preinstalled: `curl -fsSL https://get.docker.com | sh`

## 4. Clone

```bash
# /srv/planto3d was created in section 3; deploy owns it and needs no sudo.
cd /srv/planto3d
git clone https://github.com/adityamathur20/lerneanLabs-archiAgent.git
git clone https://github.com/adityamathur20/lerneanLabs-archiViewer.git archiagent-viewer
```

`lerneanLabs-archiAgent` is public, so it needs no key. If the viewer repo is
private, give the box a read-only deploy key first:

```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/viewer_deploy -C "planto3d-vps"
cat ~/.ssh/viewer_deploy.pub   # add at repo -> Settings -> Deploy keys (read-only)
cat >> ~/.ssh/config <<'EOF'
Host github-viewer
  HostName github.com
  User git
  IdentityFile ~/.ssh/viewer_deploy
EOF
git clone git@github-viewer:adityamathur20/lerneanLabs-archiViewer.git archiagent-viewer
```

## 5. Secrets — all of them, before the first `up`

```bash
cd /srv/planto3d/archiagent-viewer
cp .env.example .env && chmod 600 .env
for k in POSTGRES_PASSWORD GARAGE_RPC_SECRET GARAGE_ADMIN_TOKEN; do
  sed -i "s|^${k}=.*|${k}=$(openssl rand -hex 32)|" .env
done
```

Two things that will waste an hour if ignored:

- **`-hex 32`, not 24.** Garage requires its RPC secret to be exactly 32 bytes
  of hex and *exits* otherwise ("Invalid RPC secret key"), so the whole stack
  crash-loops.
- **`POSTGRES_PASSWORD` only applies to an empty data directory.** Changing it
  after the first `up` leaves the old password in the volume and every
  connection fails with "password authentication failed". Generate it now.

Then edit `.env` and paste your `ANTHROPIC_API_KEY`.

**Start on Let's Encrypt staging** while you are still shaking out DNS:

```bash
sed -i 's|^ACME_CA=.*|ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory|' .env
```

Staging certificates are untrusted by browsers *by design* — that is how you
know you are still on staging, not a failure. Switch to production (`ACME_CA=`)
only once everything else works, then `docker compose up -d caddy`.

## 6. Start storage, then provision it

```bash
cd /srv/planto3d/archiagent-viewer
docker compose -f docker-compose.prod.yml up -d garage
./deploy/provision-garage.sh        # writes the keys into .env for you
```

The script writes both keys straight into `.env` and deliberately does **not**
print the secret: a secret echoed to a terminal ends up in scrollback, in CI
logs and in any transcript of the session. If you ever need it, read it with
`docker compose -f docker-compose.prod.yml exec -T garage /garage key info
archiagent-service --show-secret` — and rotate it afterwards.

Leave `ARCHIAGENT_SERVICE_S3_ENDPOINT=https://s3.planto3d.in`. Pointing it at
`http://garage:3900` makes every browser download fail while `curl` on the box
still works — see spec §4.3.

## 7. Build the viewer, migrate, start

```bash
cd /srv/planto3d/archiagent-viewer
docker run --rm -v "$PWD":/app -w /app -e VITE_API_BASE=https://api.planto3d.in \
  node:22-alpine sh -c "npm ci && npm run build"

docker compose -f docker-compose.prod.yml build          # ~10 min, once
docker compose -f docker-compose.prod.yml run --rm api alembic upgrade head
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml logs -f caddy   # watch certificates issue
```

Migrations are a separate step on purpose: an app that migrates on boot cannot
be rolled back without rolling back the database.

## 8. Issue yourself a tenant and key

```bash
docker compose -f docker-compose.prod.yml exec -T api python - <<'EOF'
from archiagent_service.db import session_scope
from archiagent_service.auth import issue_key
from archiagent_service.models import Tenant, ulid
with session_scope() as s:
    t = Tenant(id=ulid(), name="founder"); s.add(t); s.flush()
    print("tenant", t.id); print("key", issue_key(s, t.id))
EOF
```

Save the key — only its hash is stored. Paste it into the viewer's key field at
`https://planto3d.in`.

### 8a. Confirm the worker can actually validate an IFC

```bash
docker compose -f docker-compose.prod.yml cp deploy/validate-image-check.py worker:/tmp/vc.py
docker compose -f docker-compose.prod.yml exec -T worker /opt/agent/bin/python /tmp/vc.py
```

Must print `OK`. If it reports a missing module, every conversion will still
produce a geometrically correct IFC but be reported as **`failed` /
`acceptance: draft`**, because `ifcopenshell.validate(..., express_rules=True)`
could not run. That happened on the first live deployment: `pytest` is a
runtime dependency of the EXPRESS rules, and it was absent from the image while
present in the dev venv.

## 9. Verify (spec §12)

```bash
KEY=ak_...   # from step 8

curl -fsS https://api.planto3d.in/healthz && echo " <- healthz ok"
curl -sI https://planto3d.si | grep -i '^location'       # -> https://planto3d.in

# Another tenant's job id must 404, never 403 — a 403 would confirm it exists.
curl -s -o /dev/null -w 'unknown job -> %{http_code}\n' \
  https://api.planto3d.in/v1/jobs/ZZZZZZZZZZZZZZZZZZZZZZZZZZ -H "Authorization: Bearer $KEY"

# A DXF, end to end. NOTE the field is "size", and start needs a body ({} at
# minimum) even though every field in it is optional.
SIZE=$(wc -c < plan.dxf | tr -d ' ')
UP=$(curl -fsS -X POST https://api.planto3d.in/v1/uploads \
      -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
      -d "{\"filename\":\"plan.dxf\",\"size\":${SIZE}}")
JOB=$(echo "$UP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["job_id"])')
URL=$(echo "$UP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["upload_url"])')

curl -fsS -X PUT --upload-file plan.dxf -H "content-length: ${SIZE}" "$URL"
# archiAgent will not guess a scale. Either trust the drawing's own
# dimensions, or assert one wall in source coordinates:
#   {"scale_from_wall": [{"x1": 0, "y1": 0, "x2": 120, "y2": 0, "length": "10ft"}]}
curl -fsS -X POST "https://api.planto3d.in/v1/jobs/${JOB}/start" \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"trust_extracted_scale": true}'
curl -fsS "https://api.planto3d.in/v1/jobs/${JOB}" -H "Authorization: Bearer $KEY"
```

A `.dwg` upload must return **400**, not 500 — the worker ships no ODA
converter by design.

Then, **in a browser** — this is the step that proves §4.3 and §4.4, and
nothing else does: open `https://planto3d.in`, enter the key, and confirm the
job lists and renders. A download that works under `curl` on the box but fails
in a browser is the presign-host or CORS failure, not a storage fault.

Finally:

```bash
./deploy/backup.sh && ./deploy/restore-check.sh
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml up -d
# jobs survive, and caddy must NOT re-request certificates:
docker compose -f docker-compose.prod.yml logs caddy | grep -ci "obtaining certificate"
```

That last count should be `0` on the second boot. If it is not, `caddy_data`
is not persisting and you are on the path to a rate-limit lockout.

## 10. Backups

`crontab -e` as `deploy`:

```
17 2 * * * cd /srv/planto3d/archiagent-viewer && OFFSITE_REMOTE=b2:planto3d-backups ./deploy/backup.sh >> /var/log/planto3d-backup.log 2>&1
23 3 * * 0 cd /srv/planto3d/archiagent-viewer && ./deploy/restore-check.sh >> /var/log/planto3d-backup.log 2>&1
```

`backup.sh` writes to `/srv/planto3d/backups` (which `deploy` owns, created in
section 3) and into the object store — **both on the same disk**. The offsite
copy is what survives losing the VPS, so the script takes it directly:

```bash
rclone config          # add a remote, e.g. Backblaze B2 named "b2"
# then add OFFSITE_REMOTE to the cron lines above:
#   OFFSITE_REMOTE=b2:planto3d-backups ./deploy/backup.sh
```

Until `OFFSITE_REMOTE` is set, every run prints a warning to stderr and the
backup protects you against nothing but a bad migration. Spec §12.7 is not
satisfied until this is configured.

Artifacts are regenerable from the source upload; the job index is not. If you
only protect one thing, protect Postgres.

## 11. Updating

```bash
cd /srv/planto3d/archiagent-viewer && git pull
cd ../lerneanLabs-archiAgent && git pull && cd -
docker run --rm -v "$PWD":/app -w /app -e VITE_API_BASE=https://api.planto3d.in \
  node:22-alpine sh -c "npm ci && npm run build"
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml run --rm api alembic upgrade head
docker compose -f docker-compose.prod.yml up -d
```

GHCR packages are **private by default**, so authenticate once before the
first `pull` — otherwise it 401s:

```bash
# A classic PAT with read:packages only.
echo "$GHCR_TOKEN" | docker login ghcr.io -u adityamathur20 --password-stdin
```

There is deliberately no `|| build` fallback: it swallowed the 401 and silently
recompiled ifcopenshell on the box for ten minutes, which is the cost GHCR
exists to remove. If `pull` fails, fix the login or run `build` on purpose.

The workflow publishes on pushes to `main` and on tags, so no image exists
until this branch is merged — until then, use `docker compose build`.

Rollback: `IMAGE_TAG=<previous-sha> docker compose -f docker-compose.prod.yml up -d`

## Known limitations

- **DXF and PDF only.** `.dwg` returns 400: the ODA converter is a macOS
  bundle, and its terms restrict hosted use.
- **Multi-page PDFs convert page 0.** `build_command` plumbs no `page` option.
- **No signup.** There is no self-serve registration: you issue keys by hand
  with the script in section 8. The viewer has an upload form, which uses the
  same `localStorage` key it already needs to list jobs — so it adds no
  credential exposure that listing did not already have. A browser-held key
  still grants that whole tenant, which is why keys are hand-issued and
  revocable (delete the `api_keys` row) rather than self-served. Phase 7.
- **The LLM is NVIDIA-hosted `moonshotai/kimi-k3`**, reached
  with `provider=openai` plus a base URL. Provider, base URL and model are
  **pinned in `docker-compose.prod.yml`, not `.env`** — compose lets the host
  shell override `.env`, so a stray `ARCHIAGENT_LLM_MODEL` in a profile would
  silently change the deployed model. Only `OPENAI_API_KEY` (the `nvapi-…`
  key) comes from the environment. To change model, edit compose — and
  re-verify against a REAL drawing, because `llama-3.2-11b` passed a toy
  json_schema test and then emitted 2600 tokens of invalid JSON on the actual
  classification prompt.
- **A per-call LLM timeout is mandatory, and set to 900s.** Left unset it is
  unbounded in practice: a two-token completion against NVIDIA's
  `llama-3.2-90b-vision-instruct` was measured hanging **4h15m** before
  returning a 504. With one worker at concurrency 1, that is the whole service
  stopped by someone else's capacity problem. It sits below the CLI timeout on
  purpose, so the failure records *which provider failed* rather than just
  "archiagent timed out".
- **A conversion can take 30+ minutes.** Measured: an 8 MB / 79-layer DXF took
  31m42s. `ARCHIAGENT_SERVICE_CLI_TIMEOUT_S` is 5400 and the queue timeout
  7200; the queue's must stay the larger of the two or RQ kills the job before
  the CLI's own timeout can record why. One worker at concurrency 1 means
  roughly 48 drawings/day.
- **Artifacts are large.** 215 MB for an 8 MB drawing (overlay 77 MB, report
  116 MB). A 100 GB volume holds about 440 conversions; decide what to retain.
- **Rate limits are per API key, 120 req/min, and per IP for anyone without a
  key, 20 req/min** (`ARCHIAGENT_SERVICE_RATE_LIMIT_PER_MINUTE` /
  `_RATE_LIMIT_ANON_PER_MINUTE`). `/healthz` and CORS preflights are exempt.
  This is abuse control, not a billing quota — a key holder can still queue as
  many jobs as the limit allows, and LLM spend caps belong with billing.
- **No interactive docs.** `/docs`, `/redoc` and `/openapi.json` return 404 on
  purpose; the endpoints are documented in section 9 above.
- **One worker, concurrency 1.** Conversions queue rather than contend for the
  2 vCPUs. A second worker is a KVM 4 decision.
