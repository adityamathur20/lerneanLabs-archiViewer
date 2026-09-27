"""Authentication, and the one place tenancy is enforced.

Spec §7.3: authorization is a prefix comparison in ONE function. Re-implementing
it per endpoint is how a tenant eventually reads another tenant's building.
"""
import hashlib
import secrets

from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from archiagent_service.db import session_scope
from archiagent_service.models import ApiKey, Job, Tenant, ulid


def hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def issue_key(session: Session, tenant_id: str) -> str:
    """Returns the raw key ONCE. Only its hash is persisted."""
    raw = f"ak_{secrets.token_urlsafe(32)}"
    session.add(ApiKey(id=ulid(), tenant_id=tenant_id, key_hash=hash_key(raw)))
    return raw


def db_session():
    with session_scope() as session:
        yield session


def current_tenant(
    authorization: str = Header(default=""),
    session: Session = Depends(db_session),
) -> Tenant:
    scheme, _, raw = authorization.partition(" ")
    if scheme.lower() != "bearer" or not raw:
        raise HTTPException(status_code=401, detail="missing bearer token")
    key = session.query(ApiKey).filter_by(key_hash=hash_key(raw)).one_or_none()
    if key is None:
        raise HTTPException(status_code=401, detail="unknown api key")
    return session.get(Tenant, key.tenant_id)


def owned_job(session: Session, tenant: Tenant, job_id: str) -> Job:
    """404 for both 'does not exist' and 'belongs to someone else'.

    A 403 would confirm the job exists, which tells the caller that some other
    tenant owns a job with exactly this id.
    """
    job = session.get(Job, job_id)
    if job is None or job.tenant_id != tenant.id:
        raise HTTPException(status_code=404, detail="job not found")
    return job
