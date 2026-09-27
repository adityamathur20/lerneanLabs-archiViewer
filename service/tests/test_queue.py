from archiagent_service.models import Job, Tenant, ulid
from archiagent_service.queue import admit, running_count


def _tenant(session, name):
    tenant = Tenant(id=ulid(), name=name)
    session.add(tenant)
    session.flush()
    return tenant


def _job(session, tenant, status):
    job = Job(id=ulid(), tenant_id=tenant.id, status=status, source_filename="plan.dxf")
    session.add(job)
    session.flush()
    return job


def test_running_count_counts_only_live_jobs(pg_session):
    tenant = _tenant(pg_session, "acme")
    _job(pg_session, tenant, "running")
    _job(pg_session, tenant, "queued")
    _job(pg_session, tenant, "succeeded")
    _job(pg_session, tenant, "failed")

    assert running_count(pg_session, tenant.id) == 2


# Review Focus #4
def test_a_tenant_at_its_cap_is_not_admitted(pg_session):
    tenant = _tenant(pg_session, "acme")
    _job(pg_session, tenant, "running")
    _job(pg_session, tenant, "running")

    assert admit(pg_session, tenant.id, max_concurrent=2) is False


def test_one_tenants_backlog_does_not_block_another(pg_session):
    """LLM classification is the cost centre. Without a per-tenant cap one
    tenant's batch starves everyone else."""
    busy = _tenant(pg_session, "busy")
    quiet = _tenant(pg_session, "quiet")
    for _ in range(5):
        _job(pg_session, busy, "running")

    assert admit(pg_session, busy.id, max_concurrent=2) is False
    assert admit(pg_session, quiet.id, max_concurrent=2) is True
