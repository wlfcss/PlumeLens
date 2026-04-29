"""Pydantic schemas for photo decision endpoints."""

from __future__ import annotations

from pydantic import BaseModel, Field


class DecisionUpdate(BaseModel):
    """Body for setting or clearing a manual grade override."""

    decision: str | None = Field(
        ...,
        description="One of: select / usable / record / reject, or null to clear manual override",
    )


class BatchDecisionUpdate(BaseModel):
    """Body for POST /decisions/batch (keep-best-one / bulk-reject workflows)."""

    updates: list[tuple[str, str | None]] = Field(
        ...,
        description="List of (photo_id, decision) pairs; decision may be null to clear override",
    )


class DecisionRow(BaseModel):
    photo_id: str
    decision: str | None


class DecisionCounts(BaseModel):
    """Per-library decision count summary."""

    library_id: str
    counts: dict[str, int]  # {decision: count}


class SpeciesOverrideUpdate(BaseModel):
    """Body for setting or clearing one detected bird's manual species."""

    canonical_sci: str | None = Field(
        ...,
        description="Canonical scientific name, or null to clear manual species override",
    )
    canonical_zh: str | None = Field(default=None, description="Canonical Chinese name")
    canonical_en: str | None = Field(default=None, description="Canonical English name")


class SpeciesOverrideRow(BaseModel):
    photo_id: str
    bird_index: int
    canonical_sci: str | None
    canonical_zh: str | None = None
    canonical_en: str | None = None
