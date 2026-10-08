"""HTTP surface. Thin: it validates, authorizes, enqueues and redirects.

It never does geometry, never imports archiagent, and never proxies artifact
bytes — a 400 MB IFC goes straight from object storage to the client.
"""
import re
from pathlib import PurePosixPath

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.orm import Session

from archiagent_service.auth import current_tenant, db_session, owned_job
from archiagent_service.config import get_settings
from archiagent_service.models import Job, Tenant, ulid
from archiagent_service.queue import get_queue, get_redis, on_failure
from archiagent_service.ratelimit import RateLimiter, client_bucket
from archiagent_service.storage import get_store
from archiagent_service.uploads import validate_upload


class UploadRequest(BaseModel):
    filename: str
    size: int


class ScaleFromWall(BaseModel):
    """One `--scale-from-wall X1 Y1 X2 Y2 LENGTH`: two source-coordinate points
    along one wall, and its true length as archiAgent parses it (10, 10ft,
    10'-6", 3.05m, 3050mm, 120in)."""

    model_config = ConfigDict(extra="forbid")

    x1: float = Field(allow_inf_nan=False)
    y1: float = Field(allow_inf_nan=False)
    x2: float = Field(allow_inf_nan=False)
    y2: float = Field(allow_inf_nan=False)
    # Must start with a digit: the value lands in argv, and one starting with
    # "-" would be read by argparse as another flag.
    length: str = Field(min_length=1, max_length=32, pattern=r"^[0-9][0-9 .,'\"a-zA-Z/½¼¾⅛⅜⅝⅞-]*$")

    @field_validator("length")
    @classmethod
    def _has_a_unit(cls, value):
        # archiAgent refuses a bare number (exit 3, minutes later in the
        # worker); say so now. A foot mark or a unit is required.
        if "'" not in value and not re.search(r"(mm|cm|m|ft|in)\s*$", value, re.IGNORECASE):
            raise ValueError("a length needs a unit or a foot mark: 10'-6\", 12ft, 3.05m, 3050mm, 120in")
        return value


class StartRequest(BaseModel):
    height_ft: float | None = None
    walls: list[str] | None = None
    # archiAgent refuses a DXF whose scale is not established, so a DXF job
    # needs one of these two (or it fails with the CLI's own explanation).
    trust_extracted_scale: bool | None = None
    scale_from_wall: list[ScaleFromWall] | None = Field(default=None, max_length=8)
    # Removed from archiAgent's CLI; kept here only to refuse it by name rather
    # than silently dropping a scale the client thinks it set.
    units_per_foot: float | None = Field(default=None, exclude=True)

    @field_validator("units_per_foot")
    @classmethod
    def _units_per_foot_is_gone(cls, value):
        if value is not None:
            raise ValueError(
                "units_per_foot is no longer accepted: archiAgent resolves scale from "
                "the drawing. Send trust_extracted_scale: true to use the drawing's own "
                "dimensions, or scale_from_wall: [{x1, y1, x2, y2, length}] to assert one wall"
            )
        return value


def job_json(job: Job) -> dict:
    """Spec §3.2."""
    return {
        "schema_version": 1,
        "job_id": job.id,
        "tenant_id": job.tenant_id,
        "status": job.status,
        "source": {
            "filename": job.source_filename,
            "bytes": job.source_bytes,
            "converted_from_dwg": job.converted_from_dwg,
        },
        "options": job.options,
        "exit_code": job.exit_code,
        "acceptance": job.acceptance,
        "archiagent_version": job.archiagent_version,
        "artifacts": job.artifacts,
        "timings_ms": job.timings_ms,
        "error": job.error,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
    }


def _source_key(job: Job) -> str:
    return f"{job.prefix}source{PurePosixPath(job.source_filename).suffix.lower()}"


def _require_uploaded_source(job: Job) -> None:
    """The bytes the job will read are in the store, at the size declared."""
    settings = get_settings()
    stored = get_store().size_of(_source_key(job))
    if stored is None:
        raise HTTPException(status_code=409, detail="source was never uploaded")
    if job.source_bytes is not None and stored != job.source_bytes:
        # The declared size gated the upload; if the bytes disagree, the
        # declaration was a fiction and the cap never applied.
        raise HTTPException(
            status_code=409,
            detail=f"uploaded size {stored} does not match the declared size {job.source_bytes}",
        )
    if stored > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail=f"upload exceeds {settings.max_upload_bytes} bytes")


#: What a prepared job carries before it runs: the drawing the user sees and
#: measures on, and the scale evidence read from it.
PREPARED = ("plan.dxf", "plan.scale.json")


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="archiAgent",
        version="0.1.0",
        # No interactive docs or schema on a public host. The only interface is
        # an API key issued by hand, the endpoints are documented in
        # deploy/README.md, and a published schema is free reconnaissance.
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @app.middleware("http")
    async def rate_limit(request: Request, call_next):
        """Refuses floods before they reach auth or the database.

        Added BEFORE CORSMiddleware so CORS ends up outermost: a 429 emitted
        outside CORS carries no allow-origin header, and the browser then
        reports a CORS failure instead of a rate limit.
        """
        if request.url.path == "/healthz" or request.method == "OPTIONS":
            # An uptime check must not be able to lock itself out, and a
            # preflight 429 is indistinguishable from a CORS misconfiguration.
            return await call_next(request)

        authorization = request.headers.get("authorization")
        bucket = client_bucket(authorization, request.client.host if request.client else "unknown")
        limit = (
            settings.rate_limit_per_minute
            if bucket.startswith("key:")
            else settings.rate_limit_anon_per_minute
        )
        verdict = RateLimiter(get_redis(), limit=limit, window_s=60).check(bucket)
        if not verdict.allowed:
            return JSONResponse(
                {"detail": "rate limit exceeded"},
                status_code=429,
                headers={"Retry-After": str(verdict.retry_after_s)},
            )
        return await call_next(request)

    # Spec §4.4: planto3d.in -> api.planto3d.in is cross-origin, and the bearer
    # token makes every request non-simple, so the preflight must be answered.
    # allow_credentials stays False: the credential is a bearer header, not a
    # cookie, and True would forbid the wildcard we never use anyway.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["authorization", "content-type"],
    )

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/v1/uploads")
    def create_upload(
        body: UploadRequest,
        tenant: Tenant = Depends(current_tenant),
        session: Session = Depends(db_session),
    ) -> dict:
        settings = get_settings()
        suffix = validate_upload(body.filename, body.size, settings.max_upload_bytes)

        job = Job(
            id=ulid(),
            tenant_id=tenant.id,
            status="pending",
            source_filename=body.filename,
            source_bytes=body.size,
        )
        session.add(job)
        session.flush()

        key = f"{job.prefix}source{suffix}"
        # Presigned PUT: the bytes go straight to object storage (spec §7.3),
        # bound to the declared size so the cap is not merely advisory.
        return {
            "job_id": job.id,
            "key": key,
            "upload_url": get_store().presign_put(key, size=body.size),
        }

    @app.post("/v1/jobs/{job_id}/start")
    def start_job(
        job_id: str,
        body: StartRequest,
        tenant: Tenant = Depends(current_tenant),
        session: Session = Depends(db_session),
    ) -> dict:
        job = owned_job(session, tenant, job_id)
        # `pending`: started straight after upload (API callers, PDFs).
        # `ready`: prepared, and the user has now chosen a scale.
        if job.status not in ("pending", "ready"):
            raise HTTPException(status_code=409, detail=f"job is already {job.status}")
        _require_uploaded_source(job)

        job.options = body.model_dump(exclude_none=True)
        job.status = "queued"
        # Commit BEFORE enqueueing: a worker that dequeues while the row is
        # still uncommitted finds no job and strands it. The cap is enforced
        # worker-side, so submission is never refused (Review Focus #4).
        session.commit()
        get_queue().enqueue("archiagent_service.worker.run_job", job.id, on_failure=on_failure())
        return {"status": job.status}

    @app.post("/v1/jobs/{job_id}/prepare")
    def prepare_job(
        job_id: str,
        tenant: Tenant = Depends(current_tenant),
        session: Session = Depends(db_session),
    ) -> dict:
        """Convert a DWG and read the drawing's scale evidence, then wait in
        `ready` for the user to choose a scale. Nothing is classified or built."""
        job = owned_job(session, tenant, job_id)
        if job.status != "pending":
            raise HTTPException(status_code=409, detail=f"job is already {job.status}")
        if PurePosixPath(job.source_filename).suffix.lower() not in (".dxf", ".dwg"):
            raise HTTPException(status_code=409, detail="a PDF has no drawing scale to prepare; start it directly")
        _require_uploaded_source(job)
        job.status = "preparing"
        session.commit()
        get_queue().enqueue("archiagent_service.worker.prepare_job", job.id, on_failure=on_failure())
        return {"status": job.status}

    @app.post("/v1/jobs/{job_id}/retry")
    def retry_job(
        job_id: str,
        body: StartRequest,
        tenant: Tenant = Depends(current_tenant),
        session: Session = Depends(db_session),
    ) -> dict:
        """A new job from a finished one's stored drawing, with new options:
        a job refused for want of a scale is re-run with a measured wall, not
        re-uploaded. The old job and its results are left as they were."""
        old = owned_job(session, tenant, job_id)
        if old.status not in ("succeeded", "failed"):
            raise HTTPException(status_code=409, detail=f"job is {old.status}; only a finished job can be retried")
        if "plan.dxf" not in (old.artifacts or []):
            raise HTTPException(status_code=409, detail="this job has no drawing to retry from")
        store = get_store()
        new = Job(id=ulid(), tenant_id=tenant.id, status="queued",
                  source_filename=old.source_filename, source_bytes=old.source_bytes,
                  converted_from_dwg=old.converted_from_dwg,
                  options=body.model_dump(exclude_none=True))
        store.copy(_source_key(old), _source_key(new))
        new.artifacts = []
        for name in PREPARED:
            if name in old.artifacts:
                store.copy(f"{old.prefix}{name}", f"{new.prefix}{name}")
                new.artifacts.append(name)
        session.add(new)
        session.commit()
        get_queue().enqueue("archiagent_service.worker.run_job", new.id, on_failure=on_failure())
        return {"job_id": new.id, "status": new.status}

    @app.get("/v1/jobs/{job_id}")
    def get_job(
        job_id: str,
        tenant: Tenant = Depends(current_tenant),
        session: Session = Depends(db_session),
    ) -> dict:
        return job_json(owned_job(session, tenant, job_id))

    @app.get("/v1/jobs")
    def list_jobs(
        limit: int = 50,
        cursor: str | None = None,
        tenant: Tenant = Depends(current_tenant),
        session: Session = Depends(db_session),
    ) -> dict:
        # Ids are ULIDs, so id ordering IS creation ordering and the cursor is
        # just the last id seen — no offset scan, stable under inserts.
        limit = max(1, min(limit, 200))
        query = session.query(Job).filter_by(tenant_id=tenant.id)
        if cursor:
            query = query.filter(Job.id < cursor)
        rows = query.order_by(Job.id.desc()).limit(limit).all()
        return {
            "jobs": [job_json(job) for job in rows],
            "next_cursor": rows[-1].id if len(rows) == limit else None,
        }

    @app.get("/v1/jobs/{job_id}/artifacts/{name}")
    def get_artifact(
        job_id: str,
        name: str,
        tenant: Tenant = Depends(current_tenant),
        session: Session = Depends(db_session),
    ):
        job = owned_job(session, tenant, job_id)
        if name not in job.artifacts:
            raise HTTPException(status_code=404, detail=f"no artifact {name} for this job")
        # 302, never a proxy.
        return RedirectResponse(get_store().presign_get(f"{job.prefix}{name}"), status_code=302)

    @app.delete("/v1/jobs/{job_id}")
    def delete_job(
        job_id: str,
        tenant: Tenant = Depends(current_tenant),
        session: Session = Depends(db_session),
    ) -> dict:
        job = owned_job(session, tenant, job_id)
        if job.status in ("queued", "running"):
            # Deleting under a live worker orphans whatever it uploads next:
            # billed forever and invisible to delete_prefix.
            raise HTTPException(status_code=409, detail=f"job is {job.status}; wait for it to finish")
        removed = get_store().delete_prefix(job.prefix)
        session.delete(job)
        return {"deleted": True, "objects_removed": removed}

    return app


app = create_app()
