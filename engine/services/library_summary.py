"""Prepare native library summary frames without retaining the full model graph."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from sqlite3 import Row

from pydantic import TypeAdapter

from engine.api.schemas.library import PhotoSummary
from engine.core.database import Database
from engine.services.decisions import SpeciesOverrideRecord
from engine.services.library_projection import (
    project_summary_scenes,
    projection_revision_from_rows,
    projection_revision_row,
    read_library_projection_inputs,
)
from engine.services.selection import (
    SelectionPhoto,
    SelectionProjection,
    selection_photo_for_snapshot,
)

_PHOTO_SUMMARY = TypeAdapter(PhotoSummary)
_SCENE_BATCH_SIZE = 256


@dataclass(frozen=True, slots=True)
class PreparedLibrarySummary:
    rows: list[bytes]
    revision: str
    selection: SelectionProjection | None


def prepare_summary_rows(
    library_id: str,
    rows: list[Row],
    overrides: dict[str, list[SpeciesOverrideRecord]],
    include_selection: bool,
    previous: SelectionProjection | None,
) -> PreparedLibrarySummary:
    serialized = [b""] * len(rows)
    fingerprints: list[tuple[object, ...]] = [()] * len(rows)
    selected: dict[int, SelectionPhoto] = {}
    previous_by_id = {photo.id: photo for photo in previous.photos} if previous else {}
    for indices, photos in project_summary_scenes(rows, overrides, _SCENE_BATCH_SIZE):
        for index, photo in zip(indices, photos, strict=True):
            serialized[index] = _PHOTO_SUMMARY.dump_json(photo)
            fingerprints[index] = projection_revision_row(photo)
            if include_selection:
                selected[index] = selection_photo_for_snapshot(photo, previous_by_id)
        # Drop this scene batch before building the next Pydantic object graph.
        photo = None
        del photos

    revision = projection_revision_from_rows(library_id, fingerprints)
    selection = (
        SelectionProjection(revision, tuple(selected[index] for index in range(len(rows))))
        if include_selection
        else None
    )
    return PreparedLibrarySummary(serialized, revision, selection)


async def prepare_library_summary(
    db: Database, library_id: str, include_selection: bool, previous: SelectionProjection | None
) -> PreparedLibrarySummary:
    rows, _, overrides = await read_library_projection_inputs(db, library_id)
    return await asyncio.to_thread(
        prepare_summary_rows, library_id, rows, overrides, include_selection, previous
    )
