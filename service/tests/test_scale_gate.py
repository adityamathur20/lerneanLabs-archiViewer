"""The scale gate: a job is prepared, waits in `ready` for its scale, then runs.

pending --prepare--> preparing --worker--> ready --start--> queued --> ...
A job that finished (say, refused for want of a scale) is retried with a new
scale from its stored drawing, never re-uploaded.
"""
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from archiagent_service import api as api_module
from archiagent_service import auth
from archiagent_service.api import create_app
from archiagent_service.auth import issue_key
from archiagent_service.models import Job, Tenant, ulid

SCALE = {"schema_version": 1, "header": {"insunits": 1, "units_per_foot": 12.0},
         "extracted": None, "dimensions": 0, "extents": {"min": [0, 0], "max": [10, 10]}}


class RecordingQueue:
    def __init__(self):
        self.calls = []

    def enqueue(self, name, *args, **kwargs):
        self.calls.append((name, args))


@pytest.fixture
def queue(monkeypatch):
    recorder = RecordingQueue()
    monkeypatch.setattr(api_module, "get_queue", lambda: recorder)
    return recorder


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


def _job(pg_session, tenant, status, filename="plan.dwg", artifacts=(), source=b"DWG", s3=None, size=None):
    job = Job(id=ulid(), tenant_id=tenant.id, status=status, source_filename=filename,
              source_bytes=size if size is not None else len(source), artifacts=list(artifacts))
    pg_session.add(job)
    pg_session.flush()
    if s3 is not None and source is not None:
        s3.put(f"{job.prefix}source{Path(filename).suffix}", source)
    return job


# --- prepare -------------------------------------------------------------------

def test_prepare_queues_the_conversion_and_marks_the_job_preparing(client, pg_session, alice, s3, queue):
    tenant, key = alice
    job = _job(pg_session, tenant, "pending", s3=s3)
    response = client.post(f"/v1/jobs/{job.id}/prepare", headers=_auth(key))
    assert response.status_code == 200, response.text
    assert response.json() == {"status": "preparing"}
    assert queue.calls == [("archiagent_service.worker.prepare_job", (job.id,))]


def test_prepare_refuses_a_job_whose_source_never_arrived(client, pg_session, alice, s3, queue):
    tenant, key = alice
    job = _job(pg_session, tenant, "pending", source=None, size=10)
    assert client.post(f"/v1/jobs/{job.id}/prepare", headers=_auth(key)).status_code == 409
    assert queue.calls == []


@pytest.mark.parametrize("status", ["preparing", "ready", "queued", "running", "succeeded", "failed"])
def test_prepare_is_only_for_a_pending_job(client, pg_session, alice, s3, queue, status):
    tenant, key = alice
    job = _job(pg_session, tenant, status, s3=s3)
    assert client.post(f"/v1/jobs/{job.id}/prepare", headers=_auth(key)).status_code == 409


def test_a_pdf_has_no_scale_to_prepare(client, pg_session, alice, s3, queue):
    tenant, key = alice
    job = _job(pg_session, tenant, "pending", filename="plan.pdf", source=b"%PDF", s3=s3)
    response = client.post(f"/v1/jobs/{job.id}/prepare", headers=_auth(key))
    assert response.status_code == 409
    assert "pdf" in response.json()["detail"].lower()


# --- start -----------------------------------------------------------------------

def test_a_ready_job_starts_with_the_chosen_scale(client, pg_session, alice, s3, queue):
    tenant, key = alice
    job = _job(pg_session, tenant, "ready", s3=s3, artifacts=["plan.dxf", "plan.scale.json"])
    body = {"scale_from_wall": [{"x1": 0, "y1": 0, "x2": 120, "y2": 0, "length": "10ft"}]}
    response = client.post(f"/v1/jobs/{job.id}/start", json=body, headers=_auth(key))
    assert response.status_code == 200, response.text
    pg_session.refresh(job)
    assert job.status == "queued"
    assert job.options["scale_from_wall"][0]["length"] == "10ft"
    assert queue.calls == [("archiagent_service.worker.run_job", (job.id,))]


def test_a_preparing_job_cannot_start(client, pg_session, alice, s3, queue):
    tenant, key = alice
    job = _job(pg_session, tenant, "preparing", s3=s3)
    assert client.post(f"/v1/jobs/{job.id}/start", json={}, headers=_auth(key)).status_code == 409


# --- retry -----------------------------------------------------------------------

def test_retry_builds_a_new_job_from_the_stored_drawing(client, pg_session, alice, s3, queue):
    tenant, key = alice
    old = _job(pg_session, tenant, "failed", s3=s3, artifacts=["plan.dxf", "plan.scale.json", "plan.report.json"])
    s3.put(f"{old.prefix}plan.dxf", b"0\nSECTION\n")
    s3.put(f"{old.prefix}plan.scale.json", json.dumps(SCALE).encode())
    s3.put(f"{old.prefix}plan.report.json", b"{}")

    body = {"scale_from_wall": [{"x1": 0, "y1": 0, "x2": 120, "y2": 0, "length": "10ft"}]}
    response = client.post(f"/v1/jobs/{old.id}/retry", json=body, headers=_auth(key))
    assert response.status_code == 200, response.text
    new_id = response.json()["job_id"]
    assert new_id != old.id

    new = pg_session.get(Job, new_id)
    assert (new.status, new.source_filename, new.source_bytes) == ("queued", old.source_filename, old.source_bytes)
    assert sorted(new.artifacts) == ["plan.dxf", "plan.scale.json"]
    # The drawing and its evidence are copied; the old run's results are not.
    assert sorted(s3.list_prefix(new.prefix)) == sorted(
        f"{new.prefix}{name}" for name in ("source.dwg", "plan.dxf", "plan.scale.json"))
    assert s3.get(f"{new.prefix}plan.dxf") == b"0\nSECTION\n"
    assert queue.calls == [("archiagent_service.worker.run_job", (new.id,))]
    pg_session.refresh(old)
    assert old.status == "failed"


def test_retry_needs_a_finished_job_with_a_drawing(client, pg_session, alice, s3, queue):
    tenant, key = alice
    running = _job(pg_session, tenant, "running", s3=s3, artifacts=["plan.dxf"])
    pdf = _job(pg_session, tenant, "failed", filename="plan.pdf", source=b"%PDF", s3=s3, artifacts=["plan.report.json"])
    for job in (running, pdf):
        assert client.post(f"/v1/jobs/{job.id}/retry", json={}, headers=_auth(key)).status_code == 409


def test_retry_of_another_tenants_job_is_404(client, pg_session, alice, s3, queue):
    _, key = alice
    other = Tenant(id=ulid(), name="mallory")
    pg_session.add(other)
    pg_session.flush()
    job = _job(pg_session, other, "failed", s3=s3, artifacts=["plan.dxf"])
    assert client.post(f"/v1/jobs/{job.id}/retry", json={}, headers=_auth(key)).status_code == 404


# --- the worker ------------------------------------------------------------------

@pytest.fixture
def committed(pg_engine):
    """The worker opens its own sessions, so its rows must be committed."""
    from sqlalchemy.orm import Session
    session = Session(bind=pg_engine)
    tenant = Tenant(id=ulid(), name="worker")
    session.add(tenant)
    session.commit()
    yield session, tenant
    session.query(Job).filter_by(tenant_id=tenant.id).delete()
    session.query(Tenant).filter_by(id=tenant.id).delete()
    session.commit()
    session.close()


def _committed_job(session, tenant, status, filename, artifacts=()):
    job = Job(id=ulid(), tenant_id=tenant.id, status=status, source_filename=filename,
              artifacts=list(artifacts))
    session.add(job)
    session.commit()
    return job


def test_prepare_job_stores_the_drawing_and_its_scale_evidence(committed, s3, monkeypatch):
    from archiagent_service import pipeline, worker
    session, tenant = committed
    job = _committed_job(session, tenant, "preparing", "plan.dwg")
    s3.put(f"{job.prefix}source.dwg", b"DWG")
    seen = {}

    def fake_prepare(source, out_dir, timeout_s=None):
        seen["source"] = source
        (out_dir / "plan.dxf").write_bytes(b"converted")
        (out_dir / "plan.scale.json").write_text(json.dumps(SCALE))
        return pipeline.CliResult(0, "", "", 1234)

    monkeypatch.setattr(worker, "run_prepare", fake_prepare)
    worker.prepare_job(job.id)
    session.expire_all()
    done = session.get(Job, job.id)
    assert done.status == "ready", done.error
    assert sorted(done.artifacts) == ["plan.dxf", "plan.scale.json"]
    assert done.converted_from_dwg is True
    assert done.timings_ms["prepare"] == 1234
    assert seen["source"].name == "plan.dwg"
    assert s3.get(f"{job.prefix}plan.dxf") == b"converted"
    s3.delete_prefix(job.prefix)


def test_a_failed_conversion_leaves_a_failed_job_with_odas_message(committed, s3, monkeypatch):
    from archiagent_service import pipeline, worker
    session, tenant = committed
    job = _committed_job(session, tenant, "preparing", "plan.dwg")
    s3.put(f"{job.prefix}source.dwg", b"junk")
    monkeypatch.setattr(worker, "run_prepare", lambda *a, **k: pipeline.CliResult(
        1, "", "error: ODA could not read plan.dwg: bad header", 10))
    worker.prepare_job(job.id)
    session.expire_all()
    done = session.get(Job, job.id)
    assert done.status == "failed"
    assert "ODA could not read" in done.error
    s3.delete_prefix(job.prefix)


def test_a_prepared_job_runs_from_its_stored_dxf_not_the_dwg(committed, s3, monkeypatch):
    """A DWG is converted once, at prepare; the run reads the DXF the user saw."""
    from archiagent_service import pipeline, worker
    session, tenant = committed
    job = _committed_job(session, tenant, "queued", "plan.dwg", ["plan.dxf", "plan.scale.json"])
    s3.put(f"{job.prefix}source.dwg", b"DWG")
    s3.put(f"{job.prefix}plan.dxf", b"the drawing")
    s3.put(f"{job.prefix}plan.scale.json", b"{}")
    seen = {}

    def fake_cli(source, out_dir, options, timeout_s=None):
        seen["source"], seen["bytes"] = source, source.read_bytes()
        return pipeline.CliResult(0, "", "", 5)

    monkeypatch.setattr(worker, "run_cli", fake_cli)
    worker.run_job(job.id)
    session.expire_all()
    done = session.get(Job, job.id)
    assert seen["source"].name == "plan.dxf" and seen["bytes"] == b"the drawing"
    assert done.converted_from_dwg is True
    assert {"plan.dxf", "plan.scale.json"} <= set(done.artifacts)
    s3.delete_prefix(job.prefix)


# --- a dead work-horse --------------------------------------------------------------

def test_a_job_whose_process_died_is_marked_failed_not_left_running(committed, s3):
    """An OOM kill or a signal ends the work-horse before run_job's own
    handler can run, which left the job 'preparing' or 'running' forever and
    the UI polling forever. RQ's on_failure runs in the parent worker."""
    from archiagent_service import worker
    session, tenant = committed
    for status in ("preparing", "running", "queued"):
        job = _committed_job(session, tenant, status, "plan.dwg")

        class RqJob:
            args = (job.id,)

        worker.mark_failed(RqJob(), None, RuntimeError, RuntimeError("Work-horse terminated unexpectedly"), None)
        session.expire_all()
        done = session.get(Job, job.id)
        assert done.status == "failed", status
        assert "worker process ended" in done.error and "Work-horse terminated" in done.error
        assert done.finished_at is not None


def test_a_finished_job_is_not_rewritten_by_a_late_failure_callback(committed, s3):
    from archiagent_service import worker
    session, tenant = committed
    job = _committed_job(session, tenant, "succeeded", "plan.dxf")

    class RqJob:
        args = (job.id,)

    worker.mark_failed(RqJob(), None, RuntimeError, RuntimeError("late"), None)
    session.expire_all()
    assert session.get(Job, job.id).status == "succeeded"


def test_every_enqueue_carries_the_failure_callback(client, pg_session, alice, s3, monkeypatch):
    calls = []

    class Queue:
        def enqueue(self, name, *args, **kwargs):
            calls.append(kwargs.get("on_failure"))

    monkeypatch.setattr(api_module, "get_queue", lambda: Queue())
    tenant, key = alice
    pending = _job(pg_session, tenant, "pending", s3=s3)
    client.post(f"/v1/jobs/{pending.id}/prepare", headers=_auth(key))
    ready = _job(pg_session, tenant, "ready", s3=s3, artifacts=["plan.dxf"])
    client.post(f"/v1/jobs/{ready.id}/start", json={}, headers=_auth(key))
    assert len(calls) == 2 and all(c is not None for c in calls)
    assert all(c.func.endswith("worker.mark_failed") for c in calls)
