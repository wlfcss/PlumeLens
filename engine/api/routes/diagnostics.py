# pyright: basic
"""Privacy-safe local diagnostics summary endpoints.

Returns aggregate SQLite statistics and cache sizes without exposing any
filesystem paths, filenames, folder aliases, or GPS coordinates.
"""

from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from engine.core.config import settings
from engine.core.database import SCHEMA_VERSION, Database
from engine.services.thumbnail import thumbnail_cache_root

router = APIRouter(prefix="/diagnostics", tags=["diagnostics"])


def _safe_file_size(path: Path) -> int:
    try:
        return path.stat().st_size if path.is_file() else 0
    except OSError:
        return 0


def _safe_dir_size(path: Path) -> int:
    if not path.is_dir():
        return 0
    total = 0
    try:
        for entry in path.rglob("*"):
            try:
                if entry.is_file():
                    total += entry.stat().st_size
            except OSError:
                continue
    except OSError:
        return total
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


async def _group_count(conn: Any, sql: str) -> dict[str, int]:
    out: dict[str, int] = {}
    async with conn.execute(sql) as cur:
        for row in await cur.fetchall():
            key = str(row[0]) if row[0] is not None else "unknown"
            out[key] = int(row[1])
    return out


async def _scalar_int(conn: Any, sql: str) -> int:
    async with conn.execute(sql) as cur:
        row = await cur.fetchone()
    return int(row[0]) if row and row[0] is not None else 0


@router.get("/db-summary")
async def diagnostics_db_summary(request: Request) -> dict[str, Any]:
    """Return an anonymized aggregate summary of local database & cache state."""
    db: Database | None = getattr(request.app.state, "db", None)
    if db is None:
        raise HTTPException(status_code=503, detail="Database not initialized")

    disk_sizes = await asyncio.to_thread(_collect_disk_sizes, settings.data_dir)

    async with db.read_snapshot() as conn:
        async with conn.execute("PRAGMA journal_mode") as cur:
            jm_row = await cur.fetchone()
            journal_mode = str(jm_row[0]).lower() if jm_row else "unknown"

        libs_total = await _scalar_int(conn, "SELECT COUNT(*) FROM libraries")
        libs_by_status = await _group_count(
            conn, "SELECT status, COUNT(*) FROM libraries GROUP BY status"
        )

        photos_total = await _scalar_int(conn, "SELECT COUNT(*) FROM photos")
        photos_hashed = await _scalar_int(
            conn, "SELECT COUNT(*) FROM photos WHERE file_hash IS NOT NULL AND file_hash != ''"
        )
        photos_with_companion = await _scalar_int(
            conn, "SELECT COUNT(*) FROM photos WHERE companion_path IS NOT NULL"
        )
        photos_with_exif = await _scalar_int(
            conn, "SELECT COUNT(*) FROM photos WHERE exif_json IS NOT NULL"
        )
        photos_with_gps = await _scalar_int(
            conn, "SELECT COUNT(*) FROM photos WHERE country IS NOT NULL"
        )
        photos_by_format = await _group_count(
            conn,
            "SELECT LOWER(COALESCE(format, 'unknown')), COUNT(*) "
            "FROM photos GROUP BY LOWER(COALESCE(format, 'unknown'))",
        )

        active_results = await _scalar_int(
            conn, "SELECT COUNT(*) FROM analysis_results WHERE is_active = 1"
        )
        total_results = await _scalar_int(conn, "SELECT COUNT(*) FROM analysis_results")
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
        no_bird_count = await _scalar_int(
            conn,
            "SELECT COUNT(*) FROM analysis_results WHERE is_active = 1 AND bird_count = 0",
        )

        decisions_count = await _scalar_int(conn, "SELECT COUNT(*) FROM photo_decisions")
        species_overrides_count = await _scalar_int(
            conn, "SELECT COUNT(*) FROM photo_species_overrides"
        )

        tasks_by_status = await _group_count(
            conn, "SELECT status, COUNT(*) FROM task_queue GROUP BY status"
        )
        top_error_codes: dict[str, int] = {}
        async with conn.execute(
            "SELECT error_message FROM task_queue WHERE status IN ('failed', 'dead')"
        ) as cur:
            for row in await cur.fetchall():
                msg = str(row[0] or "").lower()
                if "broken" in msg or "truncated" in msg:
                    code = "broken_image"
                elif "not found" in msg or "no such file" in msg:
                    code = "file_missing"
                elif "timeout" in msg or "timed out" in msg:
                    code = "timeout"
                elif "changed" in msg or "rescan" in msg:
                    code = "source_changed"
                elif "unidentified" in msg or "unsupported" in msg:
                    code = "invalid_image"
                else:
                    code = "other"
                top_error_codes[code] = top_error_codes.get(code, 0) + 1
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
