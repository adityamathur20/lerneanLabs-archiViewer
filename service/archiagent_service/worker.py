"""The RQ entry point: object storage in, object storage out.

Tier 1 reads a directory and writes a directory; this does the I/O around it so
the CLI stays exactly as testable as it is today (spec §5.3).
"""
import tempfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from archiagent_service.db import session_scope
from archiagent_service.models import Job
from archiagent_service.pipeline import EXIT_MEANING, collect_artifacts, run_cli
from archiagent_service.storage import get_store


def run_job(job_id: str) -> None:
    store = get_store()
    with session_scope() as session:
        job = session.get(Job, job_id)
        job.status = "running"
        job.started_at = datetime.now(timezone.utc)
        prefix, filename, options = job.prefix, job.source_filename, dict(job.options)

    suffix = PurePosixPath(filename).suffix.lower()
    with tempfile.TemporaryDirectory() as raw:
        work = Path(raw)
        source = work / f"source{suffix}"
        store.download(f"{prefix}source{suffix}", source)

        result = run_cli(source, work, options)
        artifacts = []
        for path in collect_artifacts(work):
            store.put_file(f"{prefix}{path.name}", path)
            artifacts.append(path.name)

    with session_scope() as session:
        job = session.get(Job, job_id)
        job.exit_code = result.exit_code
        job.status = "succeeded" if result.exit_code == 0 else "failed"
        # A failed run is exactly when the diagnostics matter, so they are kept
        # and the job stays retrievable rather than vanishing.
        job.error = None if result.exit_code == 0 else (
            f"{EXIT_MEANING.get(result.exit_code, 'unknown')}: {result.stderr[-4000:]}"
        )
        job.artifacts = artifacts
        job.timings_ms = {**job.timings_ms, "author": result.duration_ms}
        job.finished_at = datetime.now(timezone.utc)
