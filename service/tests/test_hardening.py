"""Tests for the final-review findings. Each reproduces a defect first."""
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from archiagent_service import auth
from archiagent_service.api import create_app
from archiagent_service.auth import issue_key
from archiagent_service.models import Job, Tenant, ulid


@pytest.fixture
def client(pg_session):
    app = create_app()
    app.dependency_overrides[auth.db_session] = lambda: pg_session
    return TestClient(app)


@pytest.fixture
def alice(pg_session):
    tenant = Tenant(id=ulid(), name="alice")
    pg_session.add(tenant)
    pg_session.flush()
    return tenant, issue_key(pg_session, tenant.id)


def _auth(key):
    return {"authorization": f"Bearer {key}"}


# --- Critical 1: the size cap was enforced on a number the client made up ----

def test_presigned_put_is_bound_to_the_declared_size(s3):
    """Signing a bare put_object lets a client declare 1 KB and upload 5 GB.
    The signature must carry ContentLength so S3 rejects the mismatch."""
    url = s3.presign_put("t/j/source.dxf", size=1000)
    assert "content-length" in url.lower() or "Content-Length" in url


def test_starting_a_job_whose_upload_does_not_match_its_declaration_is_409(
    client, pg_session, alice, s3
):
    tenant, key = alice
    job = Job(id=ulid(), tenant_id=tenant.id, status="pending",
              source_filename="plan.dxf", source_bytes=10)
    pg_session.add(job)
    pg_session.flush()
    # Declared 10 bytes, actually uploaded far more.
    s3.put(f"{job.prefix}source.dxf", b"x" * 5000)

    response = client.post(f"/v1/jobs/{job.id}/start", json={}, headers=_auth(key))
    assert response.status_code == 409
    assert "size" in response.json()["detail"].lower()


# --- Critical 2: a crashing worker left the job running forever -------------

def test_a_worker_that_raises_marks_the_job_failed(pg_engine, s3, monkeypatch):
    """Anything that is not 'the CLI exited nonzero' — an S3 outage, OOM, a
    container restart — must still leave a job a user can see and a cap slot
    that frees. Otherwise two crashes permanently 429 the tenant."""
    from sqlalchemy.orm import Session

    from archiagent_service import worker

    session = Session(bind=pg_engine)
    tenant = Tenant(id=ulid(), name="crash")
    session.add(tenant)
    session.flush()
    job = Job(id=ulid(), tenant_id=tenant.id, status="queued", source_filename="plan.dxf")
    session.add(job)
    session.commit()

    def explode(*args, **kwargs):
        raise RuntimeError("object storage went away")

    monkeypatch.setattr(worker.get_store(), "download", explode)
    try:
        # The exception is re-raised on purpose: RQ needs it to mark its own
        # job failed. What matters is that the DB row is terminal FIRST.
        with pytest.raises(RuntimeError):
            worker.run_job(job.id)

        session.expire_all()
        finished = session.get(Job, job.id)
        assert finished.status == "failed", f"left as {finished.status}"
        assert "object storage went away" in (finished.error or "")
        assert finished.finished_at is not None
    finally:
        session.query(Job).filter_by(tenant_id=tenant.id).delete()
        session.query(Tenant).filter_by(id=tenant.id).delete()
        session.commit()
        session.close()


def test_a_worker_whose_job_row_vanished_does_not_crash(pg_engine, s3):
    """DELETE during a run removes the row; the worker's final write must
    no-op rather than AttributeError on None."""
    from archiagent_service import worker

    worker.run_job(ulid())  # no such job; must return quietly


# --- Important 1 + 2: the cap must queue, not reject, and must not race -----

def test_submitting_beyond_the_cap_queues_rather_than_429(client, pg_session, alice, s3):
    """Review Focus #4: 'excess must queue, not run'. Rejecting a submission
    makes the client re-implement the queue the service exists to provide."""
    tenant, key = alice
    for _ in range(3):
        running = Job(id=ulid(), tenant_id=tenant.id, status="running", source_filename="x.dxf")
        pg_session.add(running)
    job = Job(id=ulid(), tenant_id=tenant.id, status="pending",
              source_filename="plan.dxf", source_bytes=5)
    pg_session.add(job)
    pg_session.flush()
    s3.put(f"{job.prefix}source.dxf", b"xxxxx")

    response = client.post(f"/v1/jobs/{job.id}/start", json={}, headers=_auth(key))
    assert response.status_code == 200
    assert response.json()["status"] == "queued"


def test_the_cap_counts_only_running_work(pg_session):
    """Queued jobs must not count toward the cap, or the worker-side check
    deadlocks: every queued job would block every other queued job."""
    from archiagent_service.queue import running_count

    tenant = Tenant(id=ulid(), name="acme")
    pg_session.add(tenant)
    pg_session.flush()
    for status in ("running", "queued", "queued", "succeeded"):
        pg_session.add(Job(id=ulid(), tenant_id=tenant.id, status=status, source_filename="x.dxf"))
    pg_session.flush()

    assert running_count(pg_session, tenant.id) == 1


# --- Important 4: acceptance was permanently null ---------------------------

def test_acceptance_is_read_from_the_report(tmp_path):
    from archiagent_service.pipeline import read_acceptance

    # The real shape: one status per plan region.
    (tmp_path / "plan.report.json").write_text(
        '{"schema_version": 1, "regions": [{"status": "checks-passed"}, {"status": "draft"}]}'
    )
    # Any draft region makes the job a draft: a user must not read
    # "checks-passed" while part of the model failed validation.
    assert read_acceptance(tmp_path) == "draft"


def test_acceptance_is_checks_passed_when_every_region_passed(tmp_path):
    from archiagent_service.pipeline import read_acceptance

    (tmp_path / "plan.report.json").write_text(
        '{"schema_version": 1, "regions": [{"status": "checks-passed"}]}'
    )
    assert read_acceptance(tmp_path) == "checks-passed"


def test_acceptance_is_none_when_no_report_was_written(tmp_path):
    from archiagent_service.pipeline import read_acceptance

    assert read_acceptance(tmp_path) is None


# --- Important 5: DELETE during a run orphaned objects ----------------------

def test_deleting_a_running_job_is_refused(client, pg_session, alice):
    tenant, key = alice
    job = Job(id=ulid(), tenant_id=tenant.id, status="running", source_filename="plan.dxf")
    pg_session.add(job)
    pg_session.flush()

    response = client.delete(f"/v1/jobs/{job.id}", headers=_auth(key))
    assert response.status_code == 409


# --- Important 8: artifact names must match the spec's contract -------------

def test_the_working_file_is_named_so_artifacts_match_the_contract():
    """Spec §3 names plan.ifc / plan.report.json. The CLI derives the output
    stem from the input filename, so the working copy must be plan.dxf —
    otherwise Tier 2's cache key, which is keyed on plan.ifc, has to guess."""
    from archiagent_service.worker import WORKING_STEM

    assert WORKING_STEM == "plan"


# --- Important 9: pagination and a hostile limit ----------------------------

def test_a_negative_limit_does_not_reach_the_database(client, alice):
    _, key = alice
    response = client.get("/v1/jobs?limit=-1", headers=_auth(key))
    assert response.status_code == 200


def test_listing_pages_with_a_cursor(client, pg_session, alice):
    tenant, key = alice
    ids = sorted(ulid() for _ in range(5))
    for job_id in ids:
        pg_session.add(Job(id=job_id, tenant_id=tenant.id, status="succeeded",
                           source_filename=f"{job_id}.dxf"))
    pg_session.flush()

    first = client.get("/v1/jobs?limit=2", headers=_auth(key)).json()
    assert len(first["jobs"]) == 2
    assert first["next_cursor"]

    second = client.get(
        f"/v1/jobs?limit=2&cursor={first['next_cursor']}", headers=_auth(key)
    ).json()
    assert len(second["jobs"]) == 2
    assert {j["job_id"] for j in first["jobs"]} & {j["job_id"] for j in second["jobs"]} == set()


# --- Phase 4 review, Important 4: do not accept what this worker cannot convert

def test_dwg_is_refused_when_no_converter_is_available(monkeypatch):
    """Accepting a DWG on a worker without ODA reinstates exactly the failure
    the Phase 3 refusal existed to prevent: a job queued now and failing
    minutes later with a generic error."""
    from archiagent_service import uploads

    monkeypatch.setattr(uploads, "dwg_supported", lambda: False)
    with pytest.raises(HTTPException) as caught:
        uploads.validate_upload("plan.dwg", 1000, 10_000)
    assert caught.value.status_code == 400
    assert "convert" in caught.value.detail.lower()


def test_dwg_is_accepted_when_a_converter_is_available(monkeypatch):
    from archiagent_service import uploads

    monkeypatch.setattr(uploads, "dwg_supported", lambda: True)
    assert uploads.validate_upload("plan.dwg", 1000, 10_000) == ".dwg"


def test_the_deployment_setting_decides_when_set(monkeypatch):
    """The production API container has no archiAgent to ask, so the probe
    would always refuse DWG there. dwg_enabled overrides it either way."""
    from archiagent_service import uploads
    from archiagent_service.config import get_settings

    uploads.dwg_supported.cache_clear()
    monkeypatch.setattr(get_settings(), "archiagent_python", Path("/nonexistent/python"))
    monkeypatch.setattr(get_settings(), "dwg_enabled", True)
    assert uploads.dwg_supported() is True
    uploads.dwg_supported.cache_clear()
    monkeypatch.setattr(get_settings(), "dwg_enabled", False)
    assert uploads.dwg_supported() is False
    uploads.dwg_supported.cache_clear()
    # Unset: fall back to asking Tier 1, which is absent here.
    monkeypatch.setattr(get_settings(), "dwg_enabled", None)
    assert uploads.dwg_supported() is False
    uploads.dwg_supported.cache_clear()


# --- Phase 4 review, Important 10: provenance on the failure path too --------

def test_a_failed_dwg_job_still_records_that_it_was_a_dwg(pg_engine, s3, monkeypatch):
    from sqlalchemy.orm import Session

    from archiagent_service import worker

    session = Session(bind=pg_engine)
    tenant = Tenant(id=ulid(), name="dwg-fail")
    session.add(tenant)
    session.flush()
    job = Job(id=ulid(), tenant_id=tenant.id, status="queued", source_filename="plan.dwg")
    session.add(job)
    session.commit()

    monkeypatch.setattr(worker.get_store(), "download",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("storage gone")))
    try:
        with pytest.raises(RuntimeError):
            worker.run_job(job.id)
        session.expire_all()
        finished = session.get(Job, job.id)
        assert finished.status == "failed"
        assert finished.converted_from_dwg is True
    finally:
        session.query(Job).filter_by(tenant_id=tenant.id).delete()
        session.query(Tenant).filter_by(id=tenant.id).delete()
        session.commit()
        session.close()
