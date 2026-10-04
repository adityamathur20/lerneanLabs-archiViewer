"""config.py must import wherever it is installed, including a container.

It derived REPO_ROOT from `parents[3]`, which assumes the development checkout's
depth. Installed at /app/archiagent_service/config.py there are only three
parents, so importing the module raised IndexError and the image could not boot.
"""
from pathlib import Path

from archiagent_service.config import repo_root_from


def test_a_development_checkout_resolves_to_the_repo_parent():
    deep = Path("/Users/x/work/blender/archiagent-viewer/service/archiagent_service/config.py")
    assert repo_root_from(deep) == Path("/Users/x/work/blender")


def test_a_container_path_does_not_raise():
    # /app/archiagent_service/config.py -> parents are [/app/archiagent_service, /app, /]
    assert repo_root_from(Path("/app/archiagent_service/config.py"))


def test_the_container_fallback_is_a_sentinel_that_fails_loudly_if_used():
    # Silently returning "/" would make ARCHIAGENT_PYTHON default to something
    # plausible-looking. A nonexistent path makes a missing override obvious.
    root = repo_root_from(Path("/app/archiagent_service/config.py"))
    assert not root.exists()
