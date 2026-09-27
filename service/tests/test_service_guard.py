import os

import pytest

from tests.conftest import require_services


def test_services_are_optional_by_default(monkeypatch):
    monkeypatch.delenv("ARCHIAGENT_REQUIRE_SERVICES", raising=False)
    assert require_services() is False


def test_services_can_be_made_mandatory(monkeypatch):
    monkeypatch.setenv("ARCHIAGENT_REQUIRE_SERVICES", "1")
    assert require_services() is True


@pytest.mark.skipif(
    os.environ.get("ARCHIAGENT_REQUIRE_SERVICES") != "1",
    reason="only meaningful when services are declared mandatory",
)
def test_the_stack_is_actually_up_when_required(pg_engine, s3):
    """With ARCHIAGENT_REQUIRE_SERVICES=1 this must run, not skip. If the stack
    is down the suite fails loudly instead of reporting a vacuous green."""
    assert pg_engine is not None and s3 is not None
