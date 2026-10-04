"""The viewer is a different origin in production; curl never notices.

Mirrors tests/test_api.py: `create_app()` is a factory, so the app is built
AFTER the CORS env var is set and the settings cache is cleared.
"""
import pytest
from fastapi.testclient import TestClient

from archiagent_service import auth
from archiagent_service.api import create_app
from archiagent_service.auth import issue_key
from archiagent_service.config import get_settings
from archiagent_service.models import Tenant, ulid

VIEWER = "https://planto3d.in"


@pytest.fixture
def cors_client(pg_session, monkeypatch):
    monkeypatch.setenv(
        "ARCHIAGENT_SERVICE_CORS_ORIGINS", f'["{VIEWER}","http://localhost:5173"]'
    )
    get_settings.cache_clear()
    app = create_app()
    app.dependency_overrides[auth.db_session] = lambda: pg_session
    yield TestClient(app)
    get_settings.cache_clear()


@pytest.fixture
def alice(pg_session):
    tenant = Tenant(id=ulid(), name="alice")
    pg_session.add(tenant)
    pg_session.flush()
    return tenant, issue_key(pg_session, tenant.id)


def test_preflight_is_answered_for_the_viewer_origin(cors_client):
    response = cors_client.options(
        "/v1/jobs",
        headers={
            "Origin": VIEWER,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == VIEWER
    assert "authorization" in response.headers["access-control-allow-headers"].lower()


def test_actual_request_carries_allow_origin(cors_client, alice):
    _, key = alice
    response = cors_client.get(
        "/v1/jobs", headers={"Origin": VIEWER, "authorization": f"Bearer {key}"}
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == VIEWER


def test_an_unlisted_origin_gets_no_allow_header(cors_client, alice):
    _, key = alice
    response = cors_client.get(
        "/v1/jobs",
        headers={"Origin": "https://evil.example", "authorization": f"Bearer {key}"},
    )
    # The request still succeeds — the bearer token authorizes it — but the
    # browser refuses to hand the body to that origin's script.
    assert response.status_code == 200
    assert "access-control-allow-origin" not in response.headers
