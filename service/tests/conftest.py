import socket

import pytest

from archiagent_service.config import get_settings


def _reachable(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except OSError:
        return False


@pytest.fixture(scope="session")
def settings():
    return get_settings()


@pytest.fixture(scope="session")
def s3(settings):
    """Skips rather than fails when the stack is down — but never passes
    silently: the skip message says exactly how to start it."""
    if not _reachable("localhost", 9090):
        pytest.skip("S3Mock not reachable on :9090 — run `docker compose up -d` in service/")
    from archiagent_service.storage import get_store

    store = get_store()
    store.ensure_bucket()
    return store


@pytest.fixture(scope="session")
def pg_engine(settings):
    if not _reachable("localhost", 5433):
        pytest.skip("Postgres not reachable on :5433 — run `docker compose up -d` in service/")
    from sqlalchemy import create_engine

    from archiagent_service.models import Base

    engine = create_engine(settings.database_url)
    Base.metadata.create_all(engine)
    return engine


@pytest.fixture
def pg_session(pg_engine):
    """Each test runs in a transaction that is rolled back, so tests never see
    each other's rows and the database needs no cleanup between runs."""
    from sqlalchemy.orm import Session

    connection = pg_engine.connect()
    transaction = connection.begin()
    session = Session(bind=connection)
    try:
        yield session
    finally:
        session.close()
        transaction.rollback()
        connection.close()
