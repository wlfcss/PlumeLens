"""Prepare native library summary frames without retaining the full model graph."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from sqlite3 import Row
from typing import Any

from pydantic import TypeAdapter

from engine.api.schemas.library import PhotoSummary
from engine.core.budgets import SUMMARY_ROWS_PER_CHUNK
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
_SCENE_BATCH_SIZE = SUMMARY_ROWS_PER_CHUNK
_COMPACT_JSON_ENCODER = json.JSONEncoder(ensure_ascii=False, separators=(",", ":"))


@dataclass(frozen=True, slots=True)
class PreparedLibrarySummary:
    rows: list[bytes]
    revision: str
    selection: SelectionProjection | None


def normalize_root_prefix(root_path: str) -> str:
    """Return root_path with a single trailing path separator for prefix stripping."""
    if not root_path:
        return ""
    sep = "\\" if "\\" in root_path and "/" not in root_path else "/"
    return root_path if root_path.endswith(("/", "\\")) else f"{root_path}{sep}"


def dump_compact_summary_row(photo: PhotoSummary, root_prefix: str = "") -> bytes:
    """Serialize a PhotoSummary in compact-v1 wire format for NDJSON streaming.

    Drops null/default fields, strips repeated library root prefixes, and omits
    the redundant top-level `best_detection` object whenever `detections` already
    contains the `is_best=True` entry. The Electron client losslessly hydrates
    this back into a full `PhotoRow` before structural sharing.
    """
    payload: dict[str, Any] = photo.model_dump(
        mode="json",
        exclude_none=True,
        exclude_defaults=True,
    )
    if root_prefix:
        file_path = payload.get("file_path")
        if isinstance(file_path, str) and file_path.startswith(root_prefix):
            del payload["file_path"]
            payload["rel_path"] = file_path[len(root_prefix) :]
        companion_path = payload.get("companion_path")
        if isinstance(companion_path, str) and companion_path.startswith(root_prefix):
            del payload["companion_path"]
            payload["rel_companion_path"] = companion_path[len(root_prefix) :]

    detections = payload.get("detections")
    if isinstance(detections, list) and detections:
        # `detections` already carries the best detection (`is_best: true`).
        # Dropping `best_detection` removes ~35-45% of per-photo JSON bloat.
        payload.pop("best_detection", None)

    return _COMPACT_JSON_ENCODER.encode(payload).encode("utf-8")


def prepare_summary_rows(
    library_id: str,
    rows: list[Row],
    overrides: dict[str, list[SpeciesOverrideRecord]],
    include_selection: bool,
    previous: SelectionProjection | None,
    *,
    root_path: str = "",
    compact: bool = True,
) -> PreparedLibrarySummary:
    serialized = [b""] * len(rows)
    fingerprints: list[tuple[object, ...]] = [()] * len(rows)
    selected: dict[int, SelectionPhoto] = {}
    previous_by_id = {photo.id: photo for photo in previous.photos} if previous else {}
    root_prefix = normalize_root_prefix(root_path) if compact else ""
    for indices, photos in project_summary_scenes(rows, overrides, _SCENE_BATCH_SIZE):
        for index, photo in zip(indices, photos, strict=True):
            serialized[index] = (
                dump_compact_summary_row(photo, root_prefix)
                if compact
                else _PHOTO_SUMMARY.dump_json(photo)
            )
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
    db: Database,
    library_id: str,
    include_selection: bool,
    previous: SelectionProjection | None,
    *,
    root_path: str = "",
    compact: bool = True,
) -> PreparedLibrarySummary:
    rows, _, overrides = await read_library_projection_inputs(db, library_id)
    return await asyncio.to_thread(
        prepare_summary_rows,
        library_id,
        rows,
        overrides,
        include_selection,
        previous,
        root_path=root_path,
        compact=compact,
    )
