"""Pydantic schemas for library endpoints."""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field


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

    bbox: BBox
    pose: PoseDetail | None = None
    quality: dict | None = None  # clipiqa/hyperiqa/combined
    species_candidates: list[dict] = []


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
    # User layer：当前用户决定（默认 unreviewed）
    decision: str = "unreviewed"
    # 完整 EXIF（whitelist 字段：相机/镜头/快门/光圈/ISO/焦距/...）
    exif: dict | None = None
    # 最佳鸟的检测细节（深度复核要画 bbox / 关键点）
    best_detection: BestDetection | None = None


class LibraryDetail(BaseModel):
    """Library detail with summary + embedded photo rows."""

    library: LibrarySummary
    photos: list[PhotoRow]
