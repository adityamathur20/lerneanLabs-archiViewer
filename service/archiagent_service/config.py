"""Settings, from the environment. Defaults target the local docker-compose."""
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

def repo_root_from(path: Path) -> Path:
    """The checkout root that the sibling-repo defaults below hang off.

    A development checkout is `<root>/archiagent-viewer/service/archiagent_service/`,
    so the root is four levels up. Installed in a container it is
    `/app/archiagent_service/`, which has no fourth level — and importing this
    module must not fail there. The container sets the three paths below
    explicitly, so the fallback only has to be harmless; it is a nonexistent
    path rather than "/" so that a MISSING override fails loudly at use time
    instead of resolving to something plausible.
    """
    parents = path.resolve().parents
    return parents[3] if len(parents) > 3 else Path("/nonexistent")


REPO_ROOT = repo_root_from(Path(__file__))


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ARCHIAGENT_SERVICE_", extra="ignore")

    database_url: str = "postgresql+psycopg://archiagent:archiagent@localhost:5433/archiagent"
    redis_url: str = "redis://localhost:6380/0"

    # Adobe S3Mock by default; see docker-compose.yml for why not MinIO.
    s3_endpoint: str = "http://localhost:9090"
    s3_bucket: str = "archiagent"
    s3_access_key: str = "test"
    s3_secret_key: str = "test"

    # The service shells out to the CLI; it never imports archiagent (spec §5.2).
    archiagent_python: Path = REPO_ROOT / "lerneanLabs-archiAgent" / ".venv" / "bin" / "python"
    archiagent_cwd: Path = REPO_ROOT / "lerneanLabs-archiAgent"
    viewer_dir: Path = REPO_ROOT / "archiagent-viewer"

    max_upload_bytes: int = 200 * 1024 * 1024
    tenant_max_concurrent: int = 2

    # Rate limits, per bucket, per minute. Authenticated callers are bucketed
    # by API key; everyone else by IP, which is what limits key guessing. The
    # anonymous limit is deliberately much lower — no legitimate caller reaches
    # this API without a key.
    rate_limit_per_minute: int = 120
    rate_limit_anon_per_minute: int = 20

    # The viewer is a different origin in production (spec §4.4). The default
    # is the dev server, which is where it was same-origin until now.
    cors_origins: list[str] = ["http://localhost:5173"]


@lru_cache
def get_settings() -> Settings:
    return Settings()
