"""A drawing with several floors: detect, decide per floor, run each, assemble one building."""
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from archiagent_service import auth, worker
from archiagent_service.api import StartRequest, create_app
from archiagent_service.auth import issue_key
from archiagent_service.models import Job, Tenant, ulid
from archiagent_service.pipeline import build_command
from archiagent_service.storage import get_store

SCALE = {"scale_from_wall": [{"x1": 0, "y1": 0, "x2": 720, "y2": 0, "length": "60ft"}]}


# -- request ---------------------------------------------------------------------------------

@pytest.mark.parametrize("bad", [0, 0.99, 50.5, -3, float("nan")])
def test_wall_height_is_between_one_and_fifty_feet(bad):
    with pytest.raises(ValidationError):
        StartRequest(height_ft=bad)


@pytest.mark.parametrize("ok", [1, 10, 12.5, 50])
def test_wall_height_in_range_is_accepted(ok):
    assert StartRequest(height_ft=ok).height_ft == ok


def test_floors_detection_is_opt_in_and_closed_to_other_values():
    assert StartRequest().floors is None
    assert StartRequest(floors="detect").floors == "detect"
    with pytest.raises(ValidationError):
        StartRequest(floors="maybe")


def test_wall_adjudication_can_be_switched_off_and_becomes_a_flag():
    command = build_command(Path("/p"), Path("/w/plan.dxf"), Path("/w"), {"wall_adjudication": False})
    assert "--no-wall-adjudication" in command
    assert "--no-wall-adjudication" not in build_command(Path("/p"), Path("/w/plan.dxf"), Path("/w"), {})


def test_a_classification_file_option_is_passed_through_as_a_flag():
    command = build_command(Path("/p"), Path("/w/plan.dxf"), Path("/w"),
                            {"classification_file": "/w/plan.classification.json"})
    assert command[command.index("--classification-file") + 1] == "/w/plan.classification.json"


# -- API ---------------------------------------------------------------------------------------

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


FLOORS = {"units_per_foot": 12.0, "wall_height_ft": 10.0, "floors": [
    {"id": "floor-01", "name": "Ground floor", "bounds": [0, 0, 10, 10], "elevation_ft": 0.0,
     "elevation_source": "assumed", "label_text": "GROUND FLOOR", "label_center": None, "confidence": 0.9},
    {"id": "floor-02", "name": "First floor", "bounds": [20, 0, 30, 10], "elevation_ft": 10.0,
     "elevation_source": "assumed", "label_text": "FIRST FLOOR", "label_center": None, "confidence": 0.9}]}


@pytest.fixture
def awaiting(pg_session, alice, s3):
    tenant, key = alice
    job = Job(id=ulid(), tenant_id=tenant.id, status="awaiting_floors", source_filename="plan.dxf",
              options={"floors": "detect", **SCALE},
              artifacts=["plan.dxf", "plan.floors.json", "plan.classification.json"])
    pg_session.add(job)
    pg_session.flush()
    s3.put(f"{job.prefix}plan.floors.json", json.dumps(FLOORS).encode())
    yield job, key
    s3.delete_prefix(job.prefix)


def test_a_job_reports_its_kind_and_floor(client, pg_session, alice):
    tenant, key = alice
    parent = Job(id=ulid(), tenant_id=tenant.id, status="building", kind="building", source_filename="plan.dxf")
    pg_session.add(parent)
    pg_session.flush()
    child = Job(id=ulid(), tenant_id=tenant.id, status="queued", kind="floor", parent_job_id=parent.id,
                floor={"id": "floor-01", "name": "Ground floor"}, source_filename="floor-01.dxf")
    pg_session.add(child)
    pg_session.flush()
    body = client.get(f"/v1/jobs/{child.id}", headers=_auth(key)).json()
    assert body["kind"] == "floor" and body["parent_job_id"] == parent.id
    assert body["floor"]["name"] == "Ground floor"
    top = client.get(f"/v1/jobs/{parent.id}", headers=_auth(key)).json()
    assert top["kind"] == "building"
    assert [f["job_id"] for f in top["floors"]] == [child.id]


def test_the_detected_floors_are_listed(client, awaiting):
    job, key = awaiting
    body = client.get(f"/v1/jobs/{job.id}/floors", headers=_auth(key)).json()
    assert [f["name"] for f in body["floors"]] == ["Ground floor", "First floor"]
    assert body["status"] == "awaiting_floors"


def test_floors_are_only_listed_for_a_job_waiting_for_them(client, pg_session, alice):
    tenant, key = alice
    job = Job(id=ulid(), tenant_id=tenant.id, status="ready", source_filename="plan.dxf")
    pg_session.add(job)
    pg_session.flush()
    assert client.get(f"/v1/jobs/{job.id}/floors", headers=_auth(key)).status_code == 409


def test_every_detected_floor_needs_a_decision(client, awaiting):
    job, key = awaiting
    one = {"floors": [{"id": "floor-01", "approved": True}]}
    answer = client.post(f"/v1/jobs/{job.id}/floors/start", json=one, headers=_auth(key))
    assert answer.status_code == 409 and "floor-02" in answer.json()["detail"]


def test_at_least_one_floor_must_be_approved(client, awaiting):
    job, key = awaiting
    none = {"floors": [{"id": "floor-01", "approved": False}, {"id": "floor-02", "approved": False}]}
    assert client.post(f"/v1/jobs/{job.id}/floors/start", json=none, headers=_auth(key)).status_code == 409


def test_a_floor_the_drawing_does_not_have_is_refused(client, awaiting):
    job, key = awaiting
    odd = {"floors": [{"id": "floor-01", "approved": True}, {"id": "floor-02", "approved": True},
                      {"id": "floor-99", "approved": True}]}
    assert client.post(f"/v1/jobs/{job.id}/floors/start", json=odd, headers=_auth(key)).status_code == 409


@pytest.mark.parametrize("bad", [{"elevation_ft": 99999}, {"elevation_ft": -500}, {"name": ""}, {"name": "x" * 81}])
def test_an_edited_name_or_elevation_must_be_sane(client, awaiting, bad):
    job, key = awaiting
    body = {"floors": [{"id": "floor-01", "approved": True, **bad}, {"id": "floor-02", "approved": True}]}
    assert client.post(f"/v1/jobs/{job.id}/floors/start", json=body, headers=_auth(key)).status_code == 422


def test_deciding_every_floor_starts_the_building(client, pg_session, awaiting, monkeypatch):
    job, key = awaiting
    queued = []

    class Queue:
        def enqueue(self, name, *args, **kwargs):
            queued.append((name, args))

    monkeypatch.setattr("archiagent_service.api.get_queue", lambda: Queue())
    body = {"floors": [{"id": "floor-01", "approved": True, "name": "Stilt", "elevation_ft": -1.5},
                       {"id": "floor-02", "approved": False}]}
    answer = client.post(f"/v1/jobs/{job.id}/floors/start", json=body, headers=_auth(key))
    assert answer.status_code == 200, answer.text
    pg_session.expire_all()
    assert pg_session.get(Job, job.id).status == "building"
    assert pg_session.get(Job, job.id).kind == "building"
    assert queued == [("archiagent_service.worker.start_floors", (job.id,))]
    decided = json.loads(get_store().get(f"{job.prefix}floors.decided.json"))
    first = decided["floors"][0]
    assert (first["name"], first["elevation_ft"], first["elevation_source"], first["approved"]) == \
        ("Stilt", -1.5, "edited", True)
    assert decided["floors"][1]["approved"] is False


def test_a_decided_job_cannot_be_decided_again(client, awaiting, pg_session):
    job, key = awaiting
    job.status = "building"
    pg_session.flush()
    body = {"floors": [{"id": "floor-01", "approved": True}, {"id": "floor-02", "approved": True}]}
    assert client.post(f"/v1/jobs/{job.id}/floors/start", json=body, headers=_auth(key)).status_code == 409


# -- the worker, end to end on a real two-plan sheet -------------------------------------------

@pytest.fixture
def two_floor_job(pg_engine, s3):
    from sqlalchemy.orm import Session
    from tests._floorsheet import two_floor_sheet

    session = Session(bind=pg_engine)
    tenant = Tenant(id=ulid(), name="floors-e2e")
    session.add(tenant)
    session.flush()
    issue_key(session, tenant.id)
    job = Job(id=ulid(), tenant_id=tenant.id, status="queued", source_filename="plan.dxf",
              options={"floors": "detect", "walls": ["WALL"], "wall_adjudication": False, **SCALE})
    session.add(job)
    session.commit()
    get_store().put(f"{job.prefix}source.dxf", two_floor_sheet())
    yield session, job
    session.expire_all()
    for row in session.query(Job).filter_by(tenant_id=tenant.id).all():
        get_store().delete_prefix(row.prefix)
    session.query(Job).filter_by(tenant_id=tenant.id).delete()
    session.query(Tenant).filter_by(id=tenant.id).delete()
    session.commit()
    session.close()


class RecordingQueue:
    def __init__(self):
        self.calls = []

    def enqueue(self, name, *args, **kwargs):
        self.calls.append((name, args))

    def enqueue_in(self, *args, **kwargs):
        self.calls.append(("enqueue_in", args))


def test_a_sheet_with_two_plans_waits_for_the_user_then_becomes_one_building(two_floor_job, monkeypatch):
    session, job = two_floor_job
    queue = RecordingQueue()
    monkeypatch.setattr(worker, "get_queue", lambda: queue)

    # 1. detection runs inside the job; the job stops and waits.
    worker.run_job(job.id)
    session.expire_all()
    parent = session.get(Job, job.id)
    assert parent.status == "awaiting_floors", (parent.status, parent.error)
    assert {"plan.floors.json", "plan.classification.json"} <= set(parent.artifacts)
    detected = json.loads(get_store().get(f"{parent.prefix}plan.floors.json"))
    assert [f["name"] for f in detected["floors"]] == ["Ground floor", "First floor"]

    # 2. the user decides (what POST /floors/start stores), then the worker cuts and fans out.
    decided = {**detected, "floors": [{**f, "approved": True} for f in detected["floors"]]}
    get_store().put(f"{parent.prefix}floors.decided.json", json.dumps(decided).encode())
    parent.kind, parent.status = "building", "building"
    parent.artifacts = [*parent.artifacts, "floors.decided.json"]
    session.commit()
    worker.start_floors(parent.id)
    session.expire_all()
    children = session.query(Job).filter_by(parent_job_id=parent.id).order_by(Job.id).all()
    assert [c.floor["name"] for c in children] == ["Ground floor", "First floor"]
    assert all(c.kind == "floor" and c.status == "queued" for c in children)
    assert [name for name, _ in queue.calls].count("archiagent_service.worker.run_job") == 2

    # 3. each floor runs as an ordinary job on only its own drawing.
    for child in children:
        worker.run_job(child.id)
    session.expire_all()
    done = session.query(Job).filter_by(parent_job_id=parent.id).all()
    assert all(c.status == "succeeded" for c in done), [(c.status, c.error) for c in done]
    assert all("plan.ifc" in c.artifacts for c in done)
    # only the last to finish asks for the assembly, and only once
    assert [name for name, _ in queue.calls].count("archiagent_service.worker.assemble_building") == 1

    # 4. one building, with a storey per floor.
    worker.assemble_building(parent.id)
    session.expire_all()
    parent = session.get(Job, parent.id)
    assert parent.status == "succeeded", (parent.status, parent.error)
    assert {"building.ifc", "building.report.json"} <= set(parent.artifacts)
    ifc = get_store().get(f"{parent.prefix}building.ifc")
    assert ifc.count(b"IFCBUILDINGSTOREY(") == 2
    report = json.loads(get_store().get(f"{parent.prefix}building.report.json"))
    assert [f["name"] for f in report["floors"]] == ["Ground floor", "First floor"]


def test_a_failed_floor_leaves_the_building_partial_and_can_be_retried(two_floor_job, monkeypatch):
    session, job = two_floor_job
    queue = RecordingQueue()
    monkeypatch.setattr(worker, "get_queue", lambda: queue)
    worker.run_job(job.id)
    session.expire_all()
    parent = session.get(Job, job.id)
    detected = json.loads(get_store().get(f"{parent.prefix}plan.floors.json"))
    get_store().put(f"{parent.prefix}floors.decided.json",
                    json.dumps({**detected, "floors": [{**f, "approved": True} for f in detected["floors"]]}).encode())
    parent.kind, parent.status = "building", "building"
    session.commit()
    worker.start_floors(parent.id)
    session.expire_all()
    first, second = session.query(Job).filter_by(parent_job_id=parent.id).order_by(Job.id).all()
    worker.run_job(first.id)
    # the second floor's drawing is damaged
    get_store().put(f"{second.prefix}plan.dxf", b"not a drawing")
    worker.run_job(second.id)
    session.expire_all()
    assert session.get(Job, second.id).status == "failed"
    worker.assemble_building(parent.id)
    session.expire_all()
    parent = session.get(Job, parent.id)
    assert parent.status == "partial", (parent.status, parent.error)
    assert "building.ifc" in parent.artifacts


# -- retry one floor, and delete --------------------------------------------------------------

@pytest.fixture
def partial_building(pg_session, alice, s3):
    tenant, key = alice
    parent = Job(id=ulid(), tenant_id=tenant.id, status="partial", kind="building", source_filename="plan.dxf",
                 options={"floors": "detect"}, artifacts=["plan.dxf", "building.ifc"])
    pg_session.add(parent)
    pg_session.flush()
    ok = Job(id=ulid(), tenant_id=tenant.id, status="succeeded", kind="floor", parent_job_id=parent.id,
             floor={"id": "floor-01", "name": "Ground floor"}, source_filename="floor-01.dxf",
             artifacts=["plan.dxf", "plan.ifc"])
    bad = Job(id=ulid(), tenant_id=tenant.id, status="failed", kind="floor", parent_job_id=parent.id,
              floor={"id": "floor-02", "name": "First floor"}, source_filename="floor-02.dxf",
              artifacts=["plan.dxf"], error="boom", exit_code=1)
    pg_session.add_all([ok, bad])
    pg_session.flush()
    return parent, ok, bad, key


def test_one_failed_floor_is_retried_alone(client, pg_session, partial_building, monkeypatch):
    parent, ok, bad, key = partial_building
    queued = []

    class Queue:
        def enqueue(self, name, *args, **kwargs):
            queued.append((name, args))

    monkeypatch.setattr("archiagent_service.api.get_queue", lambda: Queue())
    answer = client.post(f"/v1/jobs/{parent.id}/floors/floor-02/retry", headers=_auth(key))
    assert answer.status_code == 200, answer.text
    pg_session.expire_all()
    assert pg_session.get(Job, bad.id).status == "queued"
    assert pg_session.get(Job, bad.id).error is None
    assert pg_session.get(Job, ok.id).status == "succeeded"          # untouched
    assert pg_session.get(Job, parent.id).status == "building"
    assert queued == [("archiagent_service.worker.run_job", (bad.id,))]


def test_a_floor_that_succeeded_is_not_retried(client, partial_building):
    parent, ok, bad, key = partial_building
    assert client.post(f"/v1/jobs/{parent.id}/floors/floor-01/retry", headers=_auth(key)).status_code == 409


def test_retrying_a_floor_the_building_does_not_have_is_404(client, partial_building):
    parent, ok, bad, key = partial_building
    assert client.post(f"/v1/jobs/{parent.id}/floors/floor-77/retry", headers=_auth(key)).status_code == 404


def test_a_building_that_is_still_working_cannot_be_deleted(client, pg_session, partial_building):
    parent, ok, bad, key = partial_building
    for status in ("building", "assembling"):
        parent.status = status
        pg_session.flush()
        assert client.delete(f"/v1/jobs/{parent.id}", headers=_auth(key)).status_code == 409


def test_deleting_a_building_removes_its_floors_and_their_files(client, pg_session, partial_building, s3):
    parent, ok, bad, key = partial_building
    s3.put(f"{ok.prefix}plan.ifc", b"ISO-10303-21;")
    s3.put(f"{parent.prefix}building.ifc", b"ISO-10303-21;")
    child_id, child_prefix = ok.id, ok.prefix
    answer = client.delete(f"/v1/jobs/{parent.id}", headers=_auth(key))
    assert answer.status_code == 200
    assert s3.list_prefix(child_prefix) == [] and s3.list_prefix(parent.prefix) == []
    pg_session.flush()                       # the API deletes in the shared session
    pg_session.expunge_all()
    assert pg_session.query(Job).filter_by(id=child_id).count() == 0
