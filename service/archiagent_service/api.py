"""HTTP surface. Thin: it validates, authorizes, enqueues and redirects.

It never does geometry, never imports archiagent, and never proxies artifact
bytes — a 400 MB IFC goes straight from object storage to the client.
"""
from pathlib import PurePosixPath

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from archiagent_service.auth import current_tenant, db_session, owned_job
from archiagent_service.config import get_settings
from archiagent_service.models import Job, Tenant, ulid
from archiagent_service.queue import get_queue, get_redis
from archiagent_service.ratelimit import RateLimiter, client_bucket
from archiagent_service.storage import get_store
from archiagent_service.uploads import validate_upload


class UploadRequest(BaseModel):
    filename: str
    size: int


class StartRequest(BaseModel):
    units_per_foot: float | None = None
    height_ft: float | None = None
    walls: list[str] | None = None


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
        settings = get_settings()
        job = owned_job(session, tenant, job_id)
        if job.status != "pending":
            raise HTTPException(status_code=409, detail=f"job is already {job.status}")

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

        job.options = body.model_dump(exclude_none=True)
        job.status = "queued"
        # Commit BEFORE enqueueing: a worker that dequeues while the row is
        # still uncommitted finds no job and strands it. The cap is enforced
        # worker-side, so submission is never refused (Review Focus #4).
        session.commit()
        get_queue().enqueue("archiagent_service.worker.run_job", job.id)
        return {"status": job.status}

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
