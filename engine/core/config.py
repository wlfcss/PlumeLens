"""Application configuration via Pydantic Settings."""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="PLUMELENS_")

    # Server
    host: str = "127.0.0.1"
    port: int = 0
    log_level: str = "INFO"
    data_dir: Path = Path.home() / ".plumelens"

    # Pipeline — model files
    models_dir: Path = Path(__file__).resolve().parent.parent / "models"

    # Pipeline — execution providers ("auto" / "coreml" / "cuda" / "cpu")
    yolo_provider: str = "auto"
    iqa_provider: str = "cpu"  # CoreML has bug in onnxruntime 1.24

    # Pipeline — detection
    yolo_confidence: float = 0.35
    yolo_input_size: int = 1440

    # Pipeline — IQA fusion weights
    clipiqa_weight: float = 0.35
    hyperiqa_weight: float = 0.65

    # Pipeline — grading thresholds (reject_max, record_max, usable_max)
    grade_thresholds: tuple[float, float, float] = (0.33, 0.43, 0.60)

    # Pipeline — concurrency
    analysis_concurrency: int = 2


settings = Settings()
