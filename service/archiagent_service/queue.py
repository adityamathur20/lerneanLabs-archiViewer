"""The work queue, and the fairness rule that keeps one tenant from eating it."""
from functools import lru_cache

from redis import Redis
from rq import Queue
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from archiagent_service.config import get_settings
from archiagent_service.models import Job

#: Statuses that occupy a slot.
LIVE = ("queued", "running")


@lru_cache
def get_queue() -> Queue:
    settings = get_settings()
    # Jobs are minutes long: vision escalation and LLM classification dominate.
    return Queue("archiagent", connection=Redis.from_url(settings.redis_url), default_timeout=3600)


def running_count(session: Session, tenant_id: str) -> int:
    return session.scalar(
        select(func.count(Job.id)).where(Job.tenant_id == tenant_id, Job.status.in_(LIVE))
    )


def admit(session: Session, tenant_id: str, max_concurrent: int) -> bool:
    """Whether this tenant may start another job right now."""
    return running_count(session, tenant_id) < max_concurrent
