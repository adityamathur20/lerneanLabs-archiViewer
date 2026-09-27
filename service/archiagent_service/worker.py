"""The RQ entry point: object storage in, object storage out.

Tier 1 reads a directory and writes a directory; this does the I/O around it so
the CLI stays exactly as testable as it is today (spec §5.3).
"""
import tempfile
import traceback
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from archiagent_service.config import get_settings
from archiagent_service.db import session_scope
from archiagent_service.models import Job
from archiagent_service.pipeline import (
    EXIT_MEANING,
    archiagent_version,
    collect_artifacts,
    read_acceptance,
)
from archiagent_service.pipeline import run_cli
from archiagent_service.queue import claim_slot, get_queue
from archiagent_service.storage import get_store

#: The CLI derives its output stem from the input filename, so the working copy
#: is named `plan.dxf` to make the artifacts `plan.ifc`, `plan.report.json` …
#: exactly as the spec §3 contract names them. Tier 2's cache key is keyed on
#: `plan.ifc`; it should not have to guess the stem.
WORKING_STEM = "plan"

#: How long to wait before re-checking when the tenant is at its cap.
REQUEUE_DELAY_S = 30


def _finish(job_id: str, **fields) -> None:
    """Write the terminal state, tolerating a job row that was deleted mid-run."""
    with session_scope() as session:
        job = session.get(Job, job_id)
        if job is None:
            return
        for key, value in fields.items():
            setattr(job, key, value)
        job.finished_at = datetime.now(timezone.utc)


def run_job(job_id: str) -> None:
    settings = get_settings()
    store = get_store()

    with session_scope() as session:
        job = session.get(Job, job_id)
        if job is None:
            # DELETE removed it while it sat in the queue. Nothing to do, and
            # nothing to crash on.
            return
        # The cap is enforced here, not at submission: a tenant may submit a
        # batch freely, and the queue paces it (Review Focus #4).
        if not claim_slot(session, job.tenant_id, settings.tenant_max_concurrent):
            get_queue().enqueue_in(
                __import__("datetime").timedelta(seconds=REQUEUE_DELAY_S),
                "archiagent_service.worker.run_job",
                job_id,
            )
            return
        job.status = "running"
        job.started_at = datetime.now(timezone.utc)
        prefix, filename, options = job.prefix, job.source_filename, dict(job.options)

    suffix = PurePosixPath(filename).suffix.lower()
    try:
        with tempfile.TemporaryDirectory() as raw:
            work = Path(raw)
            source = work / f"{WORKING_STEM}{suffix}"
            store.download(f"{prefix}source{suffix}", source)

            result = run_cli(source, work, options)
            acceptance = read_acceptance(work)
            artifacts = []
            for path in collect_artifacts(work):
                store.put_file(f"{prefix}{path.name}", path)
                artifacts.append(path.name)
    except Exception as error:
        # Anything that is not "the CLI exited nonzero" — an S3 outage, OOM, a
        # container restart — must still leave a job the user can see and a cap
        # slot that frees. Otherwise two crashes permanently block the tenant.
        _finish(
            job_id,
            status="failed",
            error=f"{type(error).__name__}: {error}\n{traceback.format_exc()[-2000:]}",
        )
        raise

    _finish(
        job_id,
        exit_code=result.exit_code,
        status="succeeded" if result.exit_code == 0 else "failed",
        # A failed run is exactly when the diagnostics matter, so they are kept
        # and the job stays retrievable rather than vanishing.
        error=None if result.exit_code == 0 else (
            f"{EXIT_MEANING.get(result.exit_code, 'unknown')}: {result.stderr[-4000:]}"
        ),
        acceptance=acceptance,
        artifacts=artifacts,
        timings_ms={"author": result.duration_ms},
        archiagent_version=archiagent_version(),
    )
