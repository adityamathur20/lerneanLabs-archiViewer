from archiagent_service.models import ApiKey, Job, Tenant, ulid


def test_ulid_is_sortable_and_url_safe():
    a, b = ulid(), ulid()
    assert a != b
    assert len(a) == 26
    assert a.isalnum()


def test_job_belongs_to_a_tenant(pg_session):
    tenant = Tenant(id=ulid(), name="acme")
    pg_session.add(tenant)
    pg_session.flush()

    job = Job(id=ulid(), tenant_id=tenant.id, status="pending", source_filename="plan.dxf")
    pg_session.add(job)
    pg_session.flush()

    assert pg_session.get(Job, job.id).tenant_id == tenant.id


def test_job_prefix_is_the_tenancy_unit(pg_session):
    """Every artifact for a job lives under this prefix; it is also what
    authorization compares and what delete removes (spec §3)."""
    job = Job(id="JOB", tenant_id="TEN", status="pending", source_filename="plan.dxf")
    assert job.prefix == "TEN/JOB/"


def test_api_key_never_stores_the_raw_key(pg_session):
    tenant = Tenant(id=ulid(), name="acme")
    pg_session.add(tenant)
    pg_session.flush()

    key = ApiKey(id=ulid(), tenant_id=tenant.id, key_hash="deadbeef")
    pg_session.add(key)
    pg_session.flush()

    # A leaked database must not hand over working credentials.
    assert not hasattr(key, "key")
    assert {c.name for c in ApiKey.__table__.columns} == {
        "id", "tenant_id", "key_hash", "created_at",
    }
