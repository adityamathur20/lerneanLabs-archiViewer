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

`start` and `retry` take the run's options. Scale is `trust_extracted_scale` or
`scale_from_wall`. Wall thicknesses are optional: `wall_thickness_in` (1–6
values in inches, above 0 up to 48) replaces the set archiAgent would infer from
the drawing, and `wall_thickness_exhaustive: true` says the set is complete, so a
candidate wall matching none of it is rejected. Exhaustive without a set is a 422.

Artifacts live under `{tenant_id}/{job_id}/`, and authorization is a single
prefix check in `auth.owned_job` — which returns **404, never 403**, for another
tenant's job, because a 403 would confirm that the job exists.

## DWG

`.dwg` uploads are converted to DXF by **Tier 1** using the ODA File Converter
and then follow the DXF path exactly; `converted_from_dwg` records it on the
job. The service never runs ODA itself — it only passes `--dwgFilePath`.

`.dwg` is **refused with a 400 at upload time** where no converter exists,
rather than queued and failed minutes later. Locally the API asks Tier 1; in
production the API container cannot see the worker, so the deployment states it
with `ARCHIAGENT_SERVICE_DWG_ENABLED=true` (set in `docker-compose.prod.yml`).

Every DXF and DWG job stores **`plan.dxf`**, the drawing the viewer opens: the
upload itself for a DXF, ODA's conversion for a DWG. For a DWG it is also the
only way to reproduce or debug the result (ODA's output is not
byte-deterministic), and it is what `--replay-manifest` must be replayed
against. The browser never receives a DWG.

The converter must be installed where the worker runs. The worker image
(`Dockerfile.worker`) installs ODA's Linux package, pinned by checksum, with
`xvfb`, and points `ARCHIAGENT_ODA_CONVERTER` at a wrapper that gives each
conversion a private X display. On macOS it is
`/Applications/ODAFileConverter.app/...`.
It **exits 0 even when conversion fails**, writing `<name>.dxf.err` instead, so
the return code is never trusted; failures surface the converter's own message.

> **Licence.** ODA File Converter is free to download. Running it inside the
> hosted service was decided on 2026-10-08; whether ODA's terms permit that for
> a commercial SaaS has not been confirmed in writing and should be, before
> launch. The image is on private GHCR, so the converter is not redistributed.

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
`--walls WALLS` it needs no LLM key and takes about a minute. It trusts the
fixture's own dimensions for scale; for a fixture without usable dimensions set
`ARCHIAGENT_SCALE_FROM_WALL="X1 Y1 X2 Y2 LENGTH"` to assert one wall instead.

## Not in Phase 3

User accounts and login (tenants authenticate with API keys), LLM cost
attribution (the CLI does not report tokens parseably yet, and that is a Tier 1
change), the `.frag` precompute step in the worker, retries/dead-lettering, and
DWG (Phase 4).
