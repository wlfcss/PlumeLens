"""Pydantic schemas for analysis endpoints."""

from __future__ import annotations

from pydantic import BaseModel, Field


class AnalysisBatchRequest(BaseModel):
    """Request body for POST /analysis/batch."""

    library_id: str = Field(..., description="Library to analyze")
    force_rerun: bool = Field(
        default=False,
        description="Ignore cache hits and rerun ONNX pipeline",
    )


class AnalysisBatchResponse(BaseModel):
    """Response from POST /analysis/batch."""

    library_id: str
    enqueued: int
    stats: dict[str, int]


class QueueStats(BaseModel):
    """Queue statistics per library."""

    library_id: str | None = None
    stats: dict[str, int]  # {status: count}


class TaskRow(BaseModel):
    """Projection of a task_queue row for UI."""

    id: str
    photo_id: str
    library_id: str
    status: str
    priority: int
    attempts: int
    error_message: str | None
    created_at: str
    started_at: str | None
    completed_at: str | None


class AnalysisProgressEvent(BaseModel):
    """SSE event payload for analysis progress."""

    library_id: str
    completed: int
    total: int
    pending: int
    processing: int
    failed: int
    dead: int
    current_photo_id: str | None = None
