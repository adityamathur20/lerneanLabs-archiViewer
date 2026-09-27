import pytest
from fastapi.testclient import TestClient

from archiagent_service import auth
from archiagent_service.api import create_app
from archiagent_service.auth import issue_key
from archiagent_service.models import Job, Tenant, ulid


@pytest.fixture
def client(pg_session):
    """Reuses the rolled-back test session so API tests leave no rows behind."""
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


def test_unauthenticated_requests_are_rejected(client):
    assert client.get("/v1/jobs").status_code == 401


def test_an_unknown_api_key_is_rejected(client):
    assert client.get("/v1/jobs", headers=_auth("ak_nope")).status_code == 401


def test_a_job_reports_its_status(client, pg_session, alice):
    tenant, key = alice
    job = Job(id=ulid(), tenant_id=tenant.id, status="succeeded", source_filename="plan.dxf")
    pg_session.add(job)
    pg_session.flush()

    body = client.get(f"/v1/jobs/{job.id}", headers=_auth(key)).json()
    assert body["job_id"] == job.id
    assert body["status"] == "succeeded"
    assert body["tenant_id"] == tenant.id


# Review Focus #5
def test_an_unknown_job_is_404(client, alice):
    _, key = alice
    assert client.get(f"/v1/jobs/{ulid()}", headers=_auth(key)).status_code == 404


def test_an_artifact_the_job_never_produced_is_404(client, pg_session, alice):
    tenant, key = alice
    job = Job(id=ulid(), tenant_id=tenant.id, status="succeeded",
              source_filename="plan.dxf", artifacts=["source.ifc"])
    pg_session.add(job)
    pg_session.flush()

    response = client.get(f"/v1/jobs/{job.id}/artifacts/source.report.json", headers=_auth(key))
    assert response.status_code == 404


def test_an_artifact_redirects_rather_than_proxying(client, pg_session, alice, s3):
    """Spec §7.3: a 400 MB IFC must not traverse the app server."""
    tenant, key = alice
    job = Job(id=ulid(), tenant_id=tenant.id, status="succeeded",
              source_filename="plan.dxf", artifacts=["source.ifc"])
    pg_session.add(job)
    pg_session.flush()
    s3.put(f"{job.prefix}source.ifc", b"ISO-10303-21;")

    response = client.get(
        f"/v1/jobs/{job.id}/artifacts/source.ifc", headers=_auth(key), follow_redirects=False
    )
    assert response.status_code == 302
    assert "source.ifc" in response.headers["location"]


# Review Focus #1, at the HTTP boundary this time.
def test_a_tenant_cannot_read_another_tenants_job_over_http(client, pg_session, alice):
    _, key = alice
    bob = Tenant(id=ulid(), name="bob")
    pg_session.add(bob)
    pg_session.flush()
    theirs = Job(id=ulid(), tenant_id=bob.id, status="succeeded", source_filename="theirs.dxf")
    pg_session.add(theirs)
    pg_session.flush()

    assert client.get(f"/v1/jobs/{theirs.id}", headers=_auth(key)).status_code == 404


def test_listing_is_scoped_to_the_calling_tenant(client, pg_session, alice):
    tenant, key = alice
    other = Tenant(id=ulid(), name="bob")
    pg_session.add(other)
    pg_session.flush()
    pg_session.add(Job(id=ulid(), tenant_id=tenant.id, status="succeeded", source_filename="mine.dxf"))
    pg_session.add(Job(id=ulid(), tenant_id=other.id, status="succeeded", source_filename="theirs.dxf"))
    pg_session.flush()

    body = client.get("/v1/jobs", headers=_auth(key)).json()
    assert [j["source"]["filename"] for j in body["jobs"]] == ["mine.dxf"]


def test_upload_creates_a_job_and_a_presigned_put(client, alice, s3):
    _, key = alice
    body = client.post(
        "/v1/uploads", json={"filename": "plan.dxf", "size": 1000}, headers=_auth(key)
    ).json()

    assert body["key"].endswith("/source.dxf")
    assert body["key"].startswith(body["job_id"]) is False  # tenant comes first
    assert "http" in body["upload_url"]


def test_upload_rejects_an_unsupported_format(client, alice):
    _, key = alice
    response = client.post(
        "/v1/uploads", json={"filename": "plan.rvt", "size": 1000}, headers=_auth(key)
    )
    assert response.status_code == 400


def test_starting_a_job_whose_source_was_never_uploaded_is_409(client, pg_session, alice):
    tenant, key = alice
    job = Job(id=ulid(), tenant_id=tenant.id, status="pending", source_filename="plan.dxf")
    pg_session.add(job)
    pg_session.flush()

    response = client.post(f"/v1/jobs/{job.id}/start", json={}, headers=_auth(key))
    assert response.status_code == 409


def test_deleting_a_job_removes_its_whole_prefix(client, pg_session, alice, s3):
    tenant, key = alice
    job = Job(id=ulid(), tenant_id=tenant.id, status="succeeded", source_filename="plan.dxf")
    pg_session.add(job)
    pg_session.flush()
    s3.put(f"{job.prefix}source.dxf", b"x")
    s3.put(f"{job.prefix}source.ifc", b"y")

    body = client.delete(f"/v1/jobs/{job.id}", headers=_auth(key)).json()
    assert body["objects_removed"] == 2
    assert s3.list_prefix(job.prefix) == []
