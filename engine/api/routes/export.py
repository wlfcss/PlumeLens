# pyright: basic
"""Export endpoints."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from engine.api.schemas.export import ExportLibraryRequest, ExportLibraryResponse
from engine.core.database import Database
from engine.services.exporter import ExportError, export_library

router = APIRouter(prefix="/export", tags=["export"])


async def _db(request: Request) -> Database:
    db = getattr(request.app.state, "db", None)
    if db is None:
        raise HTTPException(status_code=503, detail="Database not initialized")
    return db


@router.post("/library/{library_id}", response_model=ExportLibraryResponse)
async def export_library_route(
    request: Request,
    library_id: str,
    body: ExportLibraryRequest,
) -> ExportLibraryResponse:
    db = await _db(request)
    try:
        return await export_library(db, library_id, body)
    except ExportError as exc:
        detail = str(exc)
        status_code = 404 if detail == "Library not found" else 400
        raise HTTPException(status_code=status_code, detail=detail) from exc
