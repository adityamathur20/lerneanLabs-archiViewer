import pytest
from fastapi import HTTPException

from archiagent_service.auth import hash_key, issue_key, owned_job
from archiagent_service.models import ApiKey, Job, Tenant, ulid


def _tenant(session, name):
    tenant = Tenant(id=ulid(), name=name)
    session.add(tenant)
    session.flush()
    return tenant


def test_issue_key_returns_a_raw_key_but_stores_only_its_hash(pg_session):
    tenant = _tenant(pg_session, "acme")
    raw = issue_key(pg_session, tenant.id)
    pg_session.flush()

    stored = pg_session.query(ApiKey).filter_by(tenant_id=tenant.id).one()
    assert stored.key_hash == hash_key(raw)
    assert raw not in stored.key_hash


# Review Focus #1 — the whole security model is this one function.
def test_a_tenant_cannot_reach_another_tenants_job(pg_session):
    alice = _tenant(pg_session, "alice")
    bob = _tenant(pg_session, "bob")
    job = Job(id=ulid(), tenant_id=alice.id, status="succeeded", source_filename="plan.dxf")
    pg_session.add(job)
    pg_session.flush()

    with pytest.raises(HTTPException) as caught:
        owned_job(pg_session, bob, job.id)

    # 404, never 403: a 403 confirms the job exists, which leaks that Alice has
    # a job with this id.
    assert caught.value.status_code == 404


def test_a_tenant_can_reach_its_own_job(pg_session):
    alice = _tenant(pg_session, "alice")
    job = Job(id=ulid(), tenant_id=alice.id, status="succeeded", source_filename="plan.dxf")
    pg_session.add(job)
    pg_session.flush()

    assert owned_job(pg_session, alice, job.id).id == job.id


def test_a_missing_job_is_also_404(pg_session):
    alice = _tenant(pg_session, "alice")
    with pytest.raises(HTTPException) as caught:
        owned_job(pg_session, alice, ulid())
    assert caught.value.status_code == 404
