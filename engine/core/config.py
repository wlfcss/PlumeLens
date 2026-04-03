"""Application configuration via Pydantic Settings."""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="PLUMELENS_")

    host: str = "127.0.0.1"
    port: int = 0
    log_level: str = "INFO"
    data_dir: Path = Path.home() / ".plumelens"


settings = Settings()
