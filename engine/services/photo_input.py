"""Input identity and invalidation shared by scanners and asynchronous publishers."""

from __future__ import annotations

import json
from pathlib import Path

import aiosqlite

from engine.core.database import Database
from engine.core.file_identity import file_change_time_ns


class StalePhotoInputError(RuntimeError):
    """The source changed while derived data was being produced."""


def source_fingerprint(primary: Path, companion: Path | None = None) -> str:
    """Cheap physical identity, including the optional RAW fallback source.

    ctime detects replacements that preserve mtime; the full source SHA is
    recorded separately for analysis provenance.
    """
    values: list[object] = []
    for path in (primary, companion):
        if path is None:
            values.append(None)
            continue
        try:
            stat = path.stat()
            values.append(
                (
                    str(path),
                    stat.st_size,
                    stat.st_mtime_ns,
                    file_change_time_ns(path, stat),
                    stat.st_ino,
                )
            )
        except FileNotFoundError:
            values.append((str(path), None))
    return json.dumps(values, separators=(",", ":"))


class SourceChangedError(StalePhotoInputError):
    """A changed physical source needs an explicit folder rescan before inference."""

    def __init__(self, photo_id: str, input_revision: int, detail: str) -> None:
        super().__init__(f"source_changed: {detail}; update the folder before retrying")
        self.photo_id = photo_id
        self.input_revision = input_revision


async def mark_source_changed(db: Database, photo_id: str, input_revision: int) -> None:
    from engine.services import archive_cache

    async with db.transaction() as conn:
        async with conn.execute(
            "UPDATE photos SET input_revision=input_revision+1,input_needs_scan=1,file_hash=NULL "
            "WHERE id=? AND input_revision=? AND input_needs_scan=0 RETURNING id",
            (photo_id, input_revision),
        ) as cur:
            changed = await cur.fetchone()
        if changed is not None:
            await invalidate_derived_input(conn, photo_id, cancel_processing=False)
    archive_cache.invalidate()


async def invalidate_derived_input(
    conn: aiosqlite.Connection,
    photo_id: str,
    *,
    cancel_processing: bool = True,
) -> None:
    """Invalidate app-owned derivatives without removing analysis/manual history.

    The caller already owns a transaction and increments photos.input_revision.
    Overrides retain their old revision and are ignored until the user reviews
    them against the new input; manual quality decisions remain effective.
    """
    await conn.execute(
        "UPDATE photos SET thumb_grid=NULL, thumb_preview=NULL, scene_id=NULL, "
        "country=NULL, province=NULL, city=NULL, district=NULL, place=NULL WHERE id=?",
        (photo_id,),
    )
    await conn.execute("UPDATE analysis_results SET is_active=0 WHERE photo_id=?", (photo_id,))
    statuses = "('pending','processing','paused')" if cancel_processing else "('pending','paused')"
    await conn.execute(
        "UPDATE task_queue SET status='cancelled', completed_at=datetime('now') "
        f"WHERE photo_id=? AND status IN {statuses}",
        (photo_id,),
    )
