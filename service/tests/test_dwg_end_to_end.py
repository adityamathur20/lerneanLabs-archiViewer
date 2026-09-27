import os
from pathlib import Path

import pytest

from archiagent_service.models import Job, Tenant, ulid
from archiagent_service.storage import get_store
from archiagent_service.worker import run_job

DWG = os.environ.get("ARCHIAGENT_DWG")


@pytest.mark.skipif(not DWG or not Path(DWG).exists(), reason="set ARCHIAGENT_DWG to a real .dwg")
def test_a_dwg_upload_produces_an_ifc(pg_engine, s3):
    """The Phase 4 gate: a DWG goes in and the same artifacts come out that a
    DXF export would have produced, with the conversion recorded on the job."""
    from sqlalchemy.orm import Session

    session = Session(bind=pg_engine)
    tenant = Tenant(id=ulid(), name="dwg-e2e")
    session.add(tenant)
    session.flush()
    job = Job(
        id=ulid(), tenant_id=tenant.id, status="queued", source_filename="plan.dwg",
        options={"walls": ["WALLS"], "units_per_foot": 12},
    )
    session.add(job)
    session.commit()
    prefix = job.prefix

    try:
        get_store().put_file(f"{prefix}source.dwg", Path(DWG))
        run_job(job.id)

        session.expire_all()
        finished = session.get(Job, job.id)
        assert finished.status == "succeeded", finished.error
        assert finished.converted_from_dwg is True
        assert "plan.ifc" in finished.artifacts, finished.artifacts
        assert get_store().get(f"{prefix}plan.ifc").startswith(b"ISO-10303-21;")
        print(f"\nartifacts: {finished.artifacts}  acceptance: {finished.acceptance}")
    finally:
        get_store().delete_prefix(prefix)
        session.query(Job).filter_by(tenant_id=tenant.id).delete()
        session.query(Tenant).filter_by(id=tenant.id).delete()
        session.commit()
        session.close()
