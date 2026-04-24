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
    # Analysis fields (nullable if analysis not yet run)
    pipeline_version: str | None = None
    grade: str | None = None
    quality_score: float | None = None
    bird_count: int | None = None
    species: str | None = None


class LibraryDetail(BaseModel):
    """Library detail with summary + embedded photo rows."""

    library: LibrarySummary
    photos: list[PhotoRow]
