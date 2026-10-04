"""Settings, from the environment. Defaults target the local docker-compose."""
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[3]


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

    # The viewer is a different origin in production (spec §4.4). The default
    # is the dev server, which is where it was same-origin until now.
    cors_origins: list[str] = ["http://localhost:5173"]


@lru_cache
def get_settings() -> Settings:
    return Settings()
