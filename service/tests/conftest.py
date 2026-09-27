import os
import socket
from pathlib import Path

import pytest

from archiagent_service.config import get_settings


def require_services() -> bool:
    """When set, an unreachable service is a FAILURE, not a skip.

    Skipping is right for a developer without Docker running. It is wrong for
    CI, where "39 skipped, exit 0" is indistinguishable from a green suite —
    which is exactly how one merge here verified nothing at all.
    """
    return os.environ.get("ARCHIAGENT_REQUIRE_SERVICES") == "1"


def _reachable(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except OSError:
        return False


def _need(name: str, host: str, port: int) -> None:
    if _reachable(host, port):
        return
    message = f"{name} not reachable on :{port} — run `docker compose up -d` in service/"
    if require_services():
        pytest.fail(f"ARCHIAGENT_REQUIRE_SERVICES=1 but {message}")
    pytest.skip(message)


@pytest.fixture(scope="session")
def settings():
    return get_settings()


@pytest.fixture(scope="session")
def s3(settings):
    """Skips rather than fails when the stack is down — but never passes
    silently: the skip message says exactly how to start it."""
    _need("S3Mock", "localhost", 9090)
    from archiagent_service.storage import get_store

    store = get_store()
    store.ensure_bucket()
    return store


@pytest.fixture(scope="session")
def pg_engine(settings):
    _need("Postgres", "localhost", 5433)
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import create_engine

    # Run the real migrations, not create_all: otherwise the migration path is
    # never exercised and the first deployed schema change has no story.
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    command.upgrade(config, "head")

    return create_engine(settings.database_url)


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
