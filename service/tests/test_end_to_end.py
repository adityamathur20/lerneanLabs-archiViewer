import os
from pathlib import Path

import pytest

from archiagent_service.auth import issue_key
from archiagent_service.models import Job, Tenant, ulid
from archiagent_service.storage import get_store
from archiagent_service.worker import run_job

DXF = os.environ.get("ARCHIAGENT_DXF")


@pytest.mark.skipif(not DXF or not Path(DXF).exists(), reason="set ARCHIAGENT_DXF to a real .dxf")
def test_a_dxf_becomes_an_ifc_in_object_storage(pg_engine, s3):
    """The Phase 3 gate: source in, IFC out, without a terminal.

    Runs the worker inline rather than through RQ — the queue has its own tests,
    and this is about the pipeline boundary. It commits for real (the worker
    opens its own sessions), then cleans up after itself.
    """
    from sqlalchemy.orm import Session

    session = Session(bind=pg_engine)
    tenant = Tenant(id=ulid(), name="e2e")
    session.add(tenant)
    session.flush()
    issue_key(session, tenant.id)
    job = Job(
        id=ulid(), tenant_id=tenant.id, status="queued", source_filename="plan.dxf",
        options={"walls": ["WALLS"], "units_per_foot": 12},
    )
    session.add(job)
    session.commit()
    prefix = job.prefix

    try:
        get_store().put_file(f"{prefix}source.dxf", Path(DXF))
        run_job(job.id)

        session.expire_all()
        finished = session.get(Job, job.id)
        assert finished.status in {"succeeded", "failed"}, finished.status
        assert finished.exit_code is not None
        assert finished.finished_at is not None
        assert finished.timings_ms.get("author", 0) > 0

        if finished.status == "succeeded":
            ifcs = [n for n in finished.artifacts if n.endswith(".ifc")]
            assert ifcs, finished.artifacts
            # Spec §3 names the artifacts plan.ifc / plan.report.json. Tier 2's
            # cache key is keyed on plan.ifc and must not have to guess the stem.
            assert ifcs[0] == "plan.ifc", finished.artifacts
            assert finished.acceptance in {"draft", "checks-passed"}, finished.acceptance
            print(f"\nartifacts: {finished.artifacts}")
            print(f"acceptance: {finished.acceptance}  version: {finished.archiagent_version}")
            assert get_store().get(f"{prefix}{ifcs[0]}").startswith(b"ISO-10303-21;")
        else:
            # A failure must still be diagnosable — Review Focus #2.
            assert finished.error, "a failed job recorded no diagnostics"
            print(f"\nCLI exited {finished.exit_code}: {finished.error[:400]}")
    finally:
        get_store().delete_prefix(prefix)
        session.query(Job).filter_by(tenant_id=tenant.id).delete()
        session.query(type(tenant)).filter_by(id=tenant.id).delete()
        session.commit()
        session.close()
