# pyright: basic
"""Privacy-safe local diagnostics summary endpoints.

Returns aggregate SQLite statistics and cache sizes without exposing any
filesystem paths, filenames, folder aliases, or GPS coordinates.
"""

from __future__ import annotations

import asyncio
import os
import sqlite3
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from engine.core.config import settings
from engine.core.database import SCHEMA_VERSION, Database
from engine.services.thumbnail import thumbnail_cache_root

router = APIRouter(prefix="/diagnostics", tags=["diagnostics"])

_DISK_SIZE_CACHE_TTL_S = 10.0
_disk_size_cache: dict[str, tuple[float, dict[str, int]]] = {}
_disk_size_lock = asyncio.Lock()


def _safe_file_size(path: Path) -> int:
    try:
        return path.stat().st_size if path.is_file() else 0
    except OSError:
        return 0


def _safe_dir_size(path: Path) -> int:
    if not path.is_dir():
        return 0
    total = 0
    stack = [str(path)]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as it:
                for entry in it:
                    try:
                        if entry.is_file(follow_symlinks=False):
                            total += entry.stat(follow_symlinks=False).st_size
                        elif entry.is_dir(follow_symlinks=False):
                            stack.append(entry.path)
                    except OSError:
                        continue
        except OSError:
            continue
    return total


def _collect_disk_sizes(data_dir: Path) -> dict[str, int]:
    thumbs = thumbnail_cache_root(data_dir)
    return {
        "db_size_bytes": _safe_file_size(data_dir / "plumelens.db"),
        "wal_size_bytes": _safe_file_size(data_dir / "plumelens.db-wal"),
        "thumbnails_grid_bytes": _safe_dir_size(thumbs / "grid"),
        "thumbnails_preview_bytes": _safe_dir_size(thumbs / "preview"),
        "coreml_cache_bytes": _safe_dir_size(data_dir / "cache" / "coreml"),
    }


async def _get_disk_sizes_cached(data_dir: Path) -> dict[str, int]:
    key = str(data_dir)
    now = time.monotonic()
    cached = _disk_size_cache.get(key)
    if cached is not None and now - cached[0] < _DISK_SIZE_CACHE_TTL_S:
        return dict(cached[1])
    async with _disk_size_lock:
        now = time.monotonic()
        cached = _disk_size_cache.get(key)
        if cached is not None and now - cached[0] < _DISK_SIZE_CACHE_TTL_S:
            return dict(cached[1])
        sizes = await asyncio.to_thread(_collect_disk_sizes, data_dir)
        _disk_size_cache[key] = (time.monotonic(), sizes)
        return dict(sizes)


async def _group_count(conn: Any, sql: str) -> dict[str, int]:
    out: dict[str, int] = {}
    async with conn.execute(sql) as cur:
        for row in await cur.fetchall():
            key = str(row[0]) if row[0] is not None else "unknown"
            out[key] = int(row[1])
    return out


@router.get("/db-summary")
async def diagnostics_db_summary(request: Request) -> dict[str, Any]:
    """Return an anonymized aggregate summary of local database & cache state."""
    db: Database | None = getattr(request.app.state, "db", None)
    if db is None:
        raise HTTPException(status_code=503, detail="Database not initialized")

    disk_sizes = await _get_disk_sizes_cached(settings.data_dir)

    async with db.read_snapshot() as conn:
        async with conn.execute("PRAGMA journal_mode") as cur:
            jm_row = await cur.fetchone()
            journal_mode = str(jm_row[0]).lower() if jm_row else "unknown"

        libs_by_status = await _group_count(
            conn, "SELECT status, COUNT(*) FROM libraries GROUP BY status"
        )
        libs_total = sum(libs_by_status.values())

        async with conn.execute(
            "SELECT COUNT(*), "
            "COALESCE(SUM(CASE WHEN file_hash IS NOT NULL AND file_hash != '' "
            "THEN 1 ELSE 0 END), 0), "
            "COALESCE(SUM(CASE WHEN companion_path IS NOT NULL THEN 1 ELSE 0 END), 0), "
            "COALESCE(SUM(CASE WHEN exif_json IS NOT NULL THEN 1 ELSE 0 END), 0), "
            "COALESCE(SUM(CASE WHEN country IS NOT NULL THEN 1 ELSE 0 END), 0) "
            "FROM photos"
        ) as cur:
            p_row = await cur.fetchone()
        photos_total = int(p_row[0]) if p_row else 0
        photos_hashed = int(p_row[1]) if p_row else 0
        photos_with_companion = int(p_row[2]) if p_row else 0
        photos_with_exif = int(p_row[3]) if p_row else 0
        photos_with_gps = int(p_row[4]) if p_row else 0

        photos_by_format = await _group_count(
            conn,
            "SELECT LOWER(COALESCE(format, 'unknown')), COUNT(*) "
            "FROM photos GROUP BY LOWER(COALESCE(format, 'unknown'))",
        )

        async with conn.execute(
            "SELECT COUNT(*), "
            "COALESCE(SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END), 0), "
            "COALESCE(SUM(CASE WHEN is_active = 1 AND bird_count = 0 THEN 1 ELSE 0 END), 0) "
            "FROM analysis_results"
        ) as cur:
            ar_row = await cur.fetchone()
        total_results = int(ar_row[0]) if ar_row else 0
        active_results = int(ar_row[1]) if ar_row else 0
        no_bird_count = int(ar_row[2]) if ar_row else 0

        results_by_pipeline = await _group_count(
            conn,
            "SELECT pipeline_version, COUNT(*) FROM analysis_results "
            "WHERE is_active = 1 GROUP BY pipeline_version",
        )
        results_by_grade = await _group_count(
            conn,
            "SELECT COALESCE(grade, 'none'), COUNT(*) FROM analysis_results "
            "WHERE is_active = 1 GROUP BY COALESCE(grade, 'none')",
        )

        async with conn.execute(
            "SELECT (SELECT COUNT(*) FROM photo_decisions), "
            "(SELECT COUNT(*) FROM photo_species_overrides)"
        ) as cur:
            ov_row = await cur.fetchone()
        decisions_count = int(ov_row[0]) if ov_row else 0
        species_overrides_count = int(ov_row[1]) if ov_row else 0

        tasks_by_status = await _group_count(
            conn, "SELECT status, COUNT(*) FROM task_queue GROUP BY status"
        )
        top_error_codes = await _group_count(
            conn,
            "SELECT CASE "
            "WHEN LOWER(COALESCE(error_message, '')) LIKE '%broken%' "
            "  OR LOWER(COALESCE(error_message, '')) LIKE '%truncated%' THEN 'broken_image' "
            "WHEN LOWER(COALESCE(error_message, '')) LIKE '%not found%' "
            "  OR LOWER(COALESCE(error_message, '')) LIKE '%no such file%' THEN 'file_missing' "
            "WHEN LOWER(COALESCE(error_message, '')) LIKE '%timeout%' "
            "  OR LOWER(COALESCE(error_message, '')) LIKE '%timed out%' THEN 'timeout' "
            "WHEN LOWER(COALESCE(error_message, '')) LIKE '%changed%' "
            "  OR LOWER(COALESCE(error_message, '')) LIKE '%rescan%' THEN 'source_changed' "
            "WHEN LOWER(COALESCE(error_message, '')) LIKE '%unidentified%' "
            "  OR LOWER(COALESCE(error_message, '')) LIKE '%unsupported%' THEN 'invalid_image' "
            "ELSE 'other' END AS code, COUNT(*) "
            "FROM task_queue WHERE status IN ('failed', 'dead') GROUP BY code",
        )
        runs_by_state = await _group_count(
            conn, "SELECT desired_state, COUNT(*) FROM analysis_runs GROUP BY desired_state"
        )

    return {
        "sqlite_version": sqlite3.sqlite_version,
        "schema_version": SCHEMA_VERSION,
        "journal_mode": journal_mode,
        "db_size_bytes": disk_sizes["db_size_bytes"],
        "wal_size_bytes": disk_sizes["wal_size_bytes"],
        "libraries": {
            "total": libs_total,
            "by_status": libs_by_status,
        },
        "photos": {
            "total": photos_total,
            "hashed_count": photos_hashed,
            "with_companion": photos_with_companion,
            "with_exif": photos_with_exif,
            "with_gps": photos_with_gps,
            "by_format": photos_by_format,
        },
        "analysis": {
            "total_results": total_results,
            "active_results": active_results,
            "no_bird_count": no_bird_count,
            "by_pipeline_version": results_by_pipeline,
            "by_grade": results_by_grade,
            "manual_decisions": decisions_count,
            "manual_species_overrides": species_overrides_count,
        },
        "task_queue": {
            "by_status": tasks_by_status,
            "top_error_codes": top_error_codes,
            "runs_by_state": runs_by_state,
        },
        "cache_bytes": {
            "thumbnails_grid": disk_sizes["thumbnails_grid_bytes"],
            "thumbnails_preview": disk_sizes["thumbnails_preview_bytes"],
            "coreml_cache": disk_sizes["coreml_cache_bytes"],
        },
    }
