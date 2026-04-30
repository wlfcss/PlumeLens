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


class SpeciesOverrideBBox(BaseModel):
    """该 detection 当前的原图 bbox（写入 manual species 时记下）— read-time 用 IoU 匹配
    新一轮 detections，让用户人工标注的归属随鸟的位置稳定，不被 IoU dedup / pipeline_version
    bump 时 detections 数组重排错配。"""

    x1: float
    y1: float
    x2: float
    y2: float


class SpeciesOverrideUpdate(BaseModel):
    """Body for setting or clearing one detected bird's manual species."""

    canonical_sci: str | None = Field(
        ...,
        description="Canonical scientific name, or null to clear manual species override",
    )
    canonical_zh: str | None = Field(default=None, description="Canonical Chinese name")
    canonical_en: str | None = Field(default=None, description="Canonical English name")
    bbox: SpeciesOverrideBBox | None = Field(
        default=None,
        description=(
            "Detection bbox at write-time (原图坐标) — 用于 read-time IoU 匹配新 "
            "detections，稳定语义。老 client 不传 → bird_index fallback。"
        ),
    )


class SpeciesOverrideRow(BaseModel):
    photo_id: str
    bird_index: int
    canonical_sci: str | None
    canonical_zh: str | None = None
    canonical_en: str | None = None
