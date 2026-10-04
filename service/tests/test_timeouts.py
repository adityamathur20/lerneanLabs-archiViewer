"""Conversion timeouts must outlast a real conversion.

Measured on 2026-10-04: an 8 MB / 79-layer DXF took 31m42s on a laptop, with
the CLI timeout at 3000s (50 min) and RQ's at 3600s. On two shared vCPUs that
drawing plausibly exceeds 50 minutes, so the limit that exists to catch a hung
run would instead kill a working one.
"""
from archiagent_service.config import get_settings
from archiagent_service.queue import get_queue
from archiagent_service.pipeline import run_cli
import inspect


def test_the_cli_timeout_is_configurable_not_hardcoded():
    # An operator on slower hardware must be able to raise this without a
    # code change.
    assert "cli_timeout_s" in get_settings().model_fields


def test_the_cli_timeout_outlasts_a_measured_conversion():
    # 31m42s measured; a limit below that would kill a drawing that works.
    assert get_settings().cli_timeout_s >= 3600, "must exceed the 31m42s measured run with headroom"


def test_run_cli_defaults_to_the_configured_timeout():
    default = inspect.signature(run_cli).parameters["timeout_s"].default
    assert default is None, "run_cli must read the setting, not carry its own number"


def test_the_queue_timeout_exceeds_the_cli_timeout():
    """If RQ kills the job first, the CLI's own timeout never applies and the
    job dies without the traceback that explains why."""
    settings = get_settings()
    assert get_queue()._default_timeout > settings.cli_timeout_s
