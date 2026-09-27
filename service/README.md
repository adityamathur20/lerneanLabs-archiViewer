# archiagent-service

The HTTP tier. Upload a DXF, archiAgent runs, the artifacts are published.

It **never imports `archiagent`** — it shells out to the CLI, so an LLM timeout
or ifcopenshell's memory growth cannot take the API process with it (spec §5.2).

## Run it

```bash
docker compose up -d          # postgres:5433, redis:6380, s3mock:9090
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/alembic upgrade head            # schema; migrations, not create_all

.venv/bin/uvicorn archiagent_service.api:app --reload --port 8000
.venv/bin/rq worker archiagent --url redis://localhost:6380/0   # another shell
```

Issue yourself a tenant and key:

```bash
.venv/bin/python - <<'PY'
from archiagent_service.db import session_scope
from archiagent_service.auth import issue_key
from archiagent_service.models import Tenant, ulid
with session_scope() as s:
    t = Tenant(id=ulid(), name="dev"); s.add(t); s.flush()
    print("tenant", t.id); print("key", issue_key(s, t.id))
PY
```

## Endpoints

All routes require `Authorization: Bearer <api key>`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/uploads` | presigned PUT + a job row |
| POST | `/v1/jobs/{id}/start` | queue it |
| GET | `/v1/jobs/{id}` | status (spec §3.2) |
| GET | `/v1/jobs` | this tenant's jobs |
| GET | `/v1/jobs/{id}/artifacts/{name}` | 302 to a presigned URL |
| DELETE | `/v1/jobs/{id}` | delete the job and its whole prefix |

Artifacts live under `{tenant_id}/{job_id}/`, and authorization is a single
prefix check in `auth.owned_job` — which returns **404, never 403**, for another
tenant's job, because a 403 would confirm that the job exists.

## How work is paced

A tenant may submit as many jobs as it likes: `start` always queues. The
concurrency cap is enforced **worker-side**, where `claim_slot` takes the tenant
row lock, counts *running* jobs only, and re-queues with a delay when the tenant
is at its cap. Rejecting submissions with 429 instead would push the queue back
onto the client, which is the work this service exists to do.

A worker that dies rather than exiting nonzero still leaves a terminal job: the
run is wrapped so an S3 outage, an OOM or a container restart records `failed`
with the traceback and frees the cap slot, then re-raises so RQ marks its own
job failed too.

## Choices worth knowing

- **S3 is Adobe's S3Mock locally**, not MinIO: MinIO's images are no longer
  publicly pullable (Docker Hub and quay.io both 401 as of 2026-09-27), and
  `localstack:latest` is now a licensed build that exits 55 without a token.
- **boto3 checksums are set to `when_required`.** The default
  (`when_supported`) attaches CRC32 to multipart uploads and then demands the
  per-part checksum back on completion, which S3-compatible stores without
  flexible-checksum support reject. Genuine AWS S3 accepts `when_required` too.
- **Uploads are bound to their declared size.** The presigned PUT carries
  `ContentLength`, and `start` compares the stored object against the declared
  bytes. Without both, the 200 MB cap is decorative: a client declares 1 KB and
  PUTs 5 GB.
- **Artifacts are named `plan.*`.** The CLI derives its output stem from the
  input filename, so the worker writes its working copy as `plan.dxf` and the
  artifacts come out as the spec §3 contract names them.
- **`.dwg` is refused with a 400 until Phase 4.** Accepting it today would queue
  a job that fails minutes later inside the CLI.
- **The worker runs the CLI with the venv at
  `lerneanLabs-archiAgent/.venv/bin/python`.** Override with
  `ARCHIAGENT_SERVICE_ARCHIAGENT_PYTHON`.

## Tests

```bash
.venv/bin/pytest -q                       # needs docker compose up
ARCHIAGENT_DXF=/path/plan.dxf .venv/bin/pytest tests/test_end_to_end.py -q -s
```

Tests needing Postgres or S3 skip with instructions when the stack is down —
they never pass silently. The end-to-end test really runs archiAgent; with
`--walls WALLS --units-per-foot 12` it needs no LLM key and takes about a minute.

## Not in Phase 3

User accounts and login (tenants authenticate with API keys), LLM cost
attribution (the CLI does not report tokens parseably yet, and that is a Tier 1
change), the `.frag` precompute step in the worker, retries/dead-lettering, and
DWG (Phase 4).
