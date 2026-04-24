# pyright: basic
"""Photo review decision endpoints (user layer; independent from model grade)."""

from __future__ import annotations

import structlog
from fastapi import APIRouter, HTTPException, Request

from engine.api.schemas.decisions import (
    BatchDecisionUpdate,
    DecisionCounts,
    DecisionRow,
    DecisionUpdate,
)
from engine.core.database import Database
from engine.services.decisions import (
    Decision,
    count_by_decision,
    get_decision,
    list_decisions,
    set_decision,
    set_decisions_batch,
)

logger = structlog.stdlib.get_logger()

router = APIRouter(prefix="/decisions", tags=["decisions"])


async def _db(request: Request) -> Database:
    db = getattr(request.app.state, "db", None)
    if db is None:
        raise HTTPException(status_code=503, detail="Database not initialized")
    return db


def _parse_decision(value: str) -> Decision:
    try:
        return Decision(value)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid decision: {value}. Must be one of "
            f"{[d.value for d in Decision]}",
        ) from None


@router.get("/library/{library_id}", response_model=list[DecisionRow])
async def list_library_decisions(
    request: Request, library_id: str,
) -> list[DecisionRow]:
    """GET /decisions/library/{id} — all non-default decisions."""
    db = await _db(request)
    decisions = await list_decisions(db, library_id)
    return [
        DecisionRow(photo_id=pid, decision=d.value)
        for pid, d in decisions.items()
    ]


@router.get("/library/{library_id}/counts", response_model=DecisionCounts)
async def library_decision_counts(
    request: Request, library_id: str,
) -> DecisionCounts:
    db = await _db(request)
    counts = await count_by_decision(db, library_id)
    return DecisionCounts(library_id=library_id, counts=counts)


@router.get("/photo/{photo_id}", response_model=DecisionRow)
async def get_photo_decision(request: Request, photo_id: str) -> DecisionRow:
    db = await _db(request)
    d = await get_decision(db, photo_id)
    return DecisionRow(photo_id=photo_id, decision=d.value)


@router.put("/photo/{photo_id}", response_model=DecisionRow)
async def put_photo_decision(
    request: Request, photo_id: str, body: DecisionUpdate,
) -> DecisionRow:
    """PUT /decisions/photo/{id} — set one photo's decision."""
    db = await _db(request)
    decision = _parse_decision(body.decision)
    try:
        await set_decision(db, photo_id, decision)
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    return DecisionRow(photo_id=photo_id, decision=decision.value)


@router.post("/batch", response_model=dict)
async def batch_set_decisions(
    request: Request, body: BatchDecisionUpdate,
) -> dict:
    """POST /decisions/batch — bulk update (for keep-best-one / bulk actions)."""
    db = await _db(request)
    parsed: list[tuple[str, Decision]] = []
    for pid, val in body.updates:
        parsed.append((pid, _parse_decision(val)))
    n = await set_decisions_batch(db, parsed)
    return {"updated": n}
