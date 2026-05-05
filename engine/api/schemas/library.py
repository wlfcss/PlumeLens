"""Pydantic schemas for library endpoints."""

from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field

# 共用 species_source union：避免 typo 静默通过（schema audit C 修复）
SpeciesSource = Literal[
    "none",
    "model",
    "model_unconfirmed",
    "manual",
    "group_consensus",
    "conflict",
]


def _empty_species_candidates() -> list[dict[str, Any]]:
    return []


class LibraryStatus(StrEnum):
    """Library status enum (matches mock-workspace FolderStatus on frontend)."""

    IDLE = "idle"
    SCANNING = "scanning"
    HASHING = "hashing"
    ANALYZING_PARTIAL = "analyzing_partial"
    READY = "ready"
    UPDATING = "updating"
    PATH_MISSING = "path_missing"
    EXPORTING = "exporting"
    ERROR = "error"


class ImportLibraryRequest(BaseModel):
    """Request body for POST /library/import."""

    root_path: str = Field(..., description="Absolute path to the folder to import")
    display_name: str | None = Field(
        default=None,
        description="Optional display name; defaults to the folder's base name",
    )
    recursive: bool = Field(default=True, description="Whether to recurse into subdirectories")


class UpdateLibraryRequest(BaseModel):
    """Request body for PATCH /library/{id}."""

    display_name: str = Field(
        ...,
        min_length=1,
        max_length=120,
        description="User-facing folder alias used in the UI and export output folder",
    )


class LibrarySummary(BaseModel):
    """A single library entry as returned by GET /library list."""

    id: str
    display_name: str
    parent_path: str
    root_path: str
    status: LibraryStatus
    total_count: int
    analyzed_count: int
    recursive: bool
    last_opened_at: str
    last_scanned_at: str | None
    last_analyzed_at: str | None


class BBox(BaseModel):
    """Bounding box in original image coordinates."""

    x1: float
    y1: float
    x2: float
    y2: float
    confidence: float


class Keypoint(BaseModel):
    """Pose keypoint (in original image space)."""

    x: float
    y: float
    confidence: float


class PoseDetail(BaseModel):
    """5 pose keypoints + visibility booleans."""

    bill: Keypoint
    crown: Keypoint
    nape: Keypoint
    left_eye: Keypoint
    right_eye: Keypoint
    head_visible: bool
    eye_visible: bool


class BestDetection(BaseModel):
    """Top bird in the photo: bbox + pose + species."""

    index: int = 0
    bbox: BBox
    pose: PoseDetail | None = None
    quality: dict[str, float] | None = None  # clipiqa/hyperiqa/combined
    species: str | None = None
    species_latin: str | None = None
    manual_species: bool = False
    species_candidates: list[dict[str, Any]] = Field(default_factory=_empty_species_candidates)
    # 每个 detection 独立的 species_source（多鸟图混合可见性的关键 — 见 routes/library.py
    # 的 _compute_detection_species_source）。photo-level species_source 由 best
    # detection 的 species_source 决定。
    species_source: SpeciesSource = "none"


class BirdDetectionDetail(BestDetection):
    """One detected bird, including model candidates and manual species override."""

    is_best: bool = False


class PhotoRow(BaseModel):
    """A single photo row (for library detail / list pages)."""

    id: str
    file_path: str
    file_name: str
    format: str | None
    width: int | None
    height: int | None
    thumb_grid: str | None
    thumb_preview: str | None
    # JPG/RAW 同名 pair 的 RAW 同伴文件信息(scanner v7 起识别)。无 pair 时全 None。
    # 主 entry 走 file_path,companion 不入 photos 单独 entry,避免重复分析/重复决策。
    companion_path: str | None = None
    companion_format: str | None = None
    companion_size: int | None = None
    country: str | None = None
    province: str | None = None
    city: str | None = None
    district: str | None = None
    place: str | None = None
    created_at: str
    # 拍摄时间 ISO8601，优先级：EXIF DateTimeOriginal > file_mtime > created_at；
    # 用于前端按时间窗口分组（连拍/同场景照片聚合）
    shot_at: str
    # 场景分组 id（同 library 内连续整数）；null 表示尚未跑过场景分组
    scene_id: int | None = None
    # Analysis fields (nullable if analysis not yet run)
    pipeline_version: str | None = None
    grade: str | None = None
    quality_score: float | None = None
    bird_count: int | None = None
    species: str | None = None
    species_latin: str | None = None
    manual_species: bool = False
    # Effective species display source. Raw model output is preserved below so
    # group consensus can stabilize the UI without destroying auditability.
    # photo-level species_source = best detection 的 species_source（见 BestDetection）。
    # model_unconfirmed: head 不可见但模型给了识别 → UI 显示"不全 · 待审"，
    # 用户在深度复核确认后升级为 manual；group consensus 可覆盖为 group_consensus。
    species_source: SpeciesSource = "none"
    model_species: str | None = None
    model_species_latin: str | None = None
    group_species: str | None = None
    group_species_latin: str | None = None
    group_species_confidence: float | None = None
    group_species_support: int | None = None
    group_species_evidence: int | None = None
    group_species_total: int | None = None
    species_conflict: bool = False
    # Manual layer：人工评级覆盖；null 表示使用系统自动 grade。
    decision: str | None = None
    # 分析任务状态(从 task_queue join)。done = 有 active analysis_results,
    # failed = task DEAD/FAILED(图损坏 / 模型错误,attempts 用尽),pending = 排队中或
    # 处理中或还没 enqueue。UI 用此区分"失败"与"等待"——前者明确告诉用户文件有问题。
    analysis_status: str = "pending"
    # 失败原因的语义 code(供前端 i18n 映射): broken_image / invalid_image /
    # file_missing / timeout / unknown。仅在 analysis_status=failed 时有意义。
    analysis_error_code: str | None = None
    # 原始 error message(英文,来自底层库如 PIL),前端 fallback 显示用。
    analysis_error: str | None = None
    # 完整 EXIF（whitelist 字段：相机/镜头/快门/光圈/ISO/焦距/...）
    exif: dict[str, Any] | None = None
    # 最佳鸟的检测细节（深度复核要画 bbox / 关键点）
    best_detection: BestDetection | None = None
    detections: list[BirdDetectionDetail] | None = None


class LibraryDetail(BaseModel):
    """Library detail with summary + embedded photo rows."""

    library: LibrarySummary
    photos: list[PhotoRow]
