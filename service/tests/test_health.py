from fastapi.testclient import TestClient

from archiagent_service.api import create_app


def test_healthz_reports_ok():
    client = TestClient(create_app())
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_archiagent_cli_is_reachable():
    """The worker shells out to this; a missing venv is a deploy error worth
    catching at the service boundary rather than inside a queued job."""
    from archiagent_service.config import get_settings

    settings = get_settings()
    assert settings.archiagent_python.exists(), (
        f"archiagent python not found at {settings.archiagent_python}; "
        "set ARCHIAGENT_SERVICE_ARCHIAGENT_PYTHON"
    )
