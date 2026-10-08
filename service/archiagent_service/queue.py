"""The work queue, and the fairness rule that keeps one tenant from eating it."""
from functools import lru_cache

from redis import Redis
from rq import Queue
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from archiagent_service.config import get_settings
from archiagent_service.models import Job, Tenant

#: Statuses that occupy a slot. Only work that is actually executing counts:
#: if queued jobs counted, the worker-side check would deadlock, since every
#: queued job would block every other queued job.
LIVE = ("running",)


@lru_cache
def get_redis() -> Redis:
    """One connection pool, shared by the queue and the rate limiter."""
    return Redis.from_url(get_settings().redis_url)


def get_queue() -> Queue:
    settings = get_settings()
    # Jobs are minutes long: vision escalation and LLM classification dominate.
    return Queue("archiagent", connection=Redis.from_url(settings.redis_url),
                 default_timeout=settings.queue_timeout_s)


def running_count(session: Session, tenant_id: str) -> int:
    return session.scalar(
        select(func.count(Job.id)).where(Job.tenant_id == tenant_id, Job.status.in_(LIVE))
    )


def admit(session: Session, tenant_id: str, max_concurrent: int) -> bool:
    """Whether this tenant may start another job right now.

    Callers that act on the answer must hold the tenant row lock — see
    `claim_slot`, which does both atomically.
    """
    return running_count(session, tenant_id) < max_concurrent


def claim_slot(session: Session, tenant_id: str, max_concurrent: int) -> bool:
    """Atomically check the cap and claim a slot.

    Check-then-act without a lock is advisory only: two workers both read
    count == 1 and both proceed. Locking the tenant row serialises the pair.
    """
    session.execute(
        select(Tenant.id).where(Tenant.id == tenant_id).with_for_update()
    ).one_or_none()
    return running_count(session, tenant_id) < max_concurrent


def on_failure():
    """Attached to every enqueue. RQ runs it in the parent worker, so it fires
    even when the work-horse process died (an OOM kill, a signal) and the job
    function's own error handling never ran."""
    from rq import Callback
    return Callback("archiagent_service.worker.mark_failed")
