"""Pydantic schemas for photo decision endpoints."""

from __future__ import annotations

from pydantic import BaseModel, Field


class DecisionUpdate(BaseModel):
    """PATCH body for setting a single photo's decision."""

    decision: str = Field(
        ..., description="One of: unreviewed / selected / maybe / rejected",
    )


class BatchDecisionUpdate(BaseModel):
    """Body for POST /decisions/batch (keep-best-one / bulk-reject workflows)."""

    updates: list[tuple[str, str]] = Field(
        ...,
        description="List of (photo_id, decision) pairs",
    )


class DecisionRow(BaseModel):
    photo_id: str
    decision: str


class DecisionCounts(BaseModel):
    """Per-library decision count summary."""

    library_id: str
    counts: dict[str, int]  # {decision: count}
