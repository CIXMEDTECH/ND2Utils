from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ND2UTILS_", extra="ignore")

    data_dir: Path = repo_root() / "data"
    max_upload_bytes: int = 8 * 1024 * 1024 * 1024
    ttl_hours: int = 24
    bind_host: str = "127.0.0.1"
    port: int = 8080
    in_memory_limit_bytes: int = 256 * 1024 * 1024
    purge_interval_seconds: int = 600

    @property
    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def cache_dir(self) -> Path:
        return self.data_dir / "cache"

    @property
    def exports_dir(self) -> Path:
        return self.data_dir / "exports"

    @property
    def staging_dir(self) -> Path:
        return self.data_dir / "staging"

    @property
    def index_path(self) -> Path:
        return self.data_dir / "index.json"

    @property
    def jobs_path(self) -> Path:
        return self.data_dir / "jobs.json"

    @property
    def auth_path(self) -> Path:
        return self.data_dir / "auth.json"

    @property
    def folders_path(self) -> Path:
        return self.data_dir / "folders.json"

    @property
    def projects_path(self) -> Path:
        return self.data_dir / "projects.json"


settings = Settings()


def ensure_dirs() -> None:
    for p in (
        settings.data_dir,
        settings.uploads_dir,
        settings.cache_dir,
        settings.exports_dir,
        settings.staging_dir,
    ):
        p.mkdir(parents=True, exist_ok=True)
