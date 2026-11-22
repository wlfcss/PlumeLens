"""Input identity and invalidation shared by scanners and asynchronous publishers."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from stat import S_ISREG

import aiosqlite

from engine.core.database import Database
from engine.core.file_identity import file_change_time_ns


class StalePhotoInputError(RuntimeError):
    """The source changed while derived data was being produced."""


@dataclass(frozen=True, slots=True)
class SourceStamp:
    """Metadata for comparing a file before and after reading it."""

    size: int
    mtime: str
    mtime_ns: int
    change_time_ns: int
    inode: int
    device: int
    regular: bool

    def fingerprint_fields(self) -> tuple[int, int, int, int]:
        # Keep the persisted fingerprint compatible with existing databases.
        return self.size, self.mtime_ns, self.change_time_ns, self.inode


def source_stamp(path: Path) -> SourceStamp | None:
    try:
        info = path.stat()
        return SourceStamp(
            size=info.st_size,
            mtime=datetime.fromtimestamp(info.st_mtime, tz=UTC).isoformat(),
            mtime_ns=info.st_mtime_ns,
            change_time_ns=file_change_time_ns(path, info),
            inode=info.st_ino,
            device=info.st_dev,
            regular=S_ISREG(info.st_mode),
        )
    except (FileNotFoundError, NotADirectoryError):
        return None


def encode_source_fingerprint(
    primary: Path,
    primary_stamp: SourceStamp | None,
    companion: Path | None,
    companion_stamp: SourceStamp | None,
) -> str:
    def fields(path: Path, stamp: SourceStamp | None) -> tuple[object, ...]:
        return (str(path), *stamp.fingerprint_fields()) if stamp else (str(path), None)

    return json.dumps(
        (fields(primary, primary_stamp), fields(companion, companion_stamp) if companion else None),
        separators=(",", ":"),
    )


def source_fingerprint(primary: Path, companion: Path | None = None) -> str:
    """Cheap physical identity, including the optional RAW fallback source.

    ctime detects replacements that preserve mtime; the full source SHA is
    recorded separately for analysis provenance.
    """
    return encode_source_fingerprint(
        primary, source_stamp(primary), companion, source_stamp(companion) if companion else None
    )


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    """Compute the content identity without loading the whole photo into memory."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


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
