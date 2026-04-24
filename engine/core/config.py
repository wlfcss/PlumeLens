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
    pose_provider: str = "cpu"  # CoreML coverage poor for YOLO26-pose
    species_provider: str = "cpu"  # CoreML ViT coverage ~30%, fallback to CPU

    # Pipeline — detection (yolo26l-bird v1.0: imgsz=1280, conf=0.5 for photography)
    yolo_confidence: float = 0.5
    yolo_input_size: int = 1280

    # Pipeline — crop strategy
    crop_expand_ratio: float = 1.0  # YOLO det bbox expand for IQA/pose input
    crop_padding_ratio: float = 0.10  # extra padding around bbox for downstream models

    # Pipeline — IQA fusion weights
    clipiqa_weight: float = 0.35
    hyperiqa_weight: float = 0.65

    # Pipeline — grading thresholds (reject_max, record_max, usable_max)
    grade_thresholds: tuple[float, float, float] = (0.33, 0.43, 0.60)

    # Pipeline — pose / visibility (bird_visibility v1.0)
    # box_threshold 作用于 crop 输入下取最高置信度检测，不作过滤
    pose_input_size: int = 640
    pose_box_threshold: float = 0.05
    pose_eye_threshold: float = 0.45
    pose_head_threshold: float = 0.35
    pose_head_eye_threshold: float = 0.10
    pose_expanded_margin: float = 0.15

    # Pipeline — species classification (DINOv3 ViT-L + 7-head ensemble)
    species_top_k: int = 5
    species_min_confidence: float = 0.01  # 过滤 1018 训练种之外的噪声命中
    species_crop_margin: float = 0.15  # 方形 bbox 扩展比例（见 MODEL_DELIVERY §6.3）
    species_crop_min_side_frac: float = 0.30  # 方形最小边长占原图短边的比例
    # 只对 head+eye 可见且综合分达到该分级（或更高）的鸟触发物种分类
    species_min_grade: str = "usable"  # "reject" / "record" / "usable" / "select"

    # Pipeline — preprocess code version (bump manually when resize/normalize/color changes)
    # v2: letterbox fill 0.5 → 114/255 (YOLO standard, matches training)
    preprocess_version: int = 2

    # Pipeline — concurrency
    analysis_concurrency: int = 2


settings = Settings()
