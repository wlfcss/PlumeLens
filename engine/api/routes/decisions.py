# pyright: basic
"""Manual grade endpoints."""

from __future__ import annotations

import structlog
from fastapi import APIRouter, HTTPException, Request

from engine.api.schemas.decisions import (
    BatchDecisionUpdate,
    DecisionCounts,
    DecisionRow,
    DecisionUpdate,
    SpeciesOverrideRow,
    SpeciesOverrideUpdate,
)
from engine.core.database import Database
from engine.services.decisions import (
    Decision,
    SpeciesOverride,
    count_by_decision,
    get_decision,
    list_decisions,
    set_decision,
    set_decisions_batch,
    set_species_override,
)

logger = structlog.stdlib.get_logger()

router = APIRouter(prefix="/decisions", tags=["decisions"])


async def _db(request: Request) -> Database:
    db = getattr(request.app.state, "db", None)
    if db is None:
        raise HTTPException(status_code=503, detail="Database not initialized")
    return db


def _parse_decision(value: str | None) -> Decision | None:
    if value is None:
        return None
    try:
        return Decision(value)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid decision: {value}. Must be one of {[d.value for d in Decision]}",
        ) from None


@router.get("/library/{library_id}", response_model=list[DecisionRow])
async def list_library_decisions(
    request: Request,
    library_id: str,
) -> list[DecisionRow]:
    """GET /decisions/library/{id} — all non-default decisions."""
    db = await _db(request)
    decisions = await list_decisions(db, library_id)
    return [DecisionRow(photo_id=pid, decision=d.value) for pid, d in decisions.items()]


@router.get("/library/{library_id}/counts", response_model=DecisionCounts)
async def library_decision_counts(
    request: Request,
    library_id: str,
) -> DecisionCounts:
    db = await _db(request)
    counts = await count_by_decision(db, library_id)
    return DecisionCounts(library_id=library_id, counts=counts)


@router.get("/photo/{photo_id}", response_model=DecisionRow)
async def get_photo_decision(request: Request, photo_id: str) -> DecisionRow:
    db = await _db(request)
    d = await get_decision(db, photo_id)
    return DecisionRow(photo_id=photo_id, decision=d.value if d is not None else None)


@router.put("/photo/{photo_id}", response_model=DecisionRow)
async def put_photo_decision(
    request: Request,
    photo_id: str,
    body: DecisionUpdate,
) -> DecisionRow:
    """PUT /decisions/photo/{id} — set or clear one photo's manual grade."""
    db = await _db(request)
    decision = _parse_decision(body.decision)
    try:
        await set_decision(db, photo_id, decision)
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    return DecisionRow(photo_id=photo_id, decision=decision.value if decision is not None else None)


@router.post("/batch", response_model=dict)
async def batch_set_decisions(
    request: Request,
    body: BatchDecisionUpdate,
) -> dict:
    """POST /decisions/batch — bulk update (for keep-best-one / bulk actions)."""
    db = await _db(request)
    parsed: list[tuple[str, Decision | None]] = []
    for pid, val in body.updates:
        parsed.append((pid, _parse_decision(val)))
    try:
        n = await set_decisions_batch(db, parsed)
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    return {"updated": n}


@router.put("/photo/{photo_id}/species/{bird_index}", response_model=SpeciesOverrideRow)
async def put_photo_species_override(
    request: Request,
    photo_id: str,
    bird_index: int,
    body: SpeciesOverrideUpdate,
) -> SpeciesOverrideRow:
    """PUT /decisions/photo/{id}/species/{index} — set/clear manual species."""
    if bird_index < 0:
        raise HTTPException(status_code=400, detail="bird_index must be >= 0")

    db = await _db(request)
    species: SpeciesOverride | None = (
        {
            "canonical_sci": body.canonical_sci.strip(),
            "canonical_zh": body.canonical_zh,
            "canonical_en": body.canonical_en,
        }
        if body.canonical_sci is not None and body.canonical_sci.strip()
        else None
    )
    bbox: tuple[float, float, float, float] | None = (
        (body.bbox.x1, body.bbox.y1, body.bbox.x2, body.bbox.y2) if body.bbox else None
    )
    try:
        saved = await set_species_override(db, photo_id, bird_index, species, bbox=bbox)
    except RuntimeError as e:
        detail = str(e)
        code = 400 if "Invalid bird index" in detail else 404
        raise HTTPException(status_code=code, detail=detail) from e

    return SpeciesOverrideRow(
        photo_id=photo_id,
        bird_index=bird_index,
        canonical_sci=saved["canonical_sci"] if saved else None,
        canonical_zh=saved.get("canonical_zh") if saved else None,
        canonical_en=saved.get("canonical_en") if saved else None,
    )
