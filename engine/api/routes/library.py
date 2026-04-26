# pyright: basic
"""Library management endpoints (import / list / detail / delete / scan)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from pathlib import Path

import structlog
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request

from engine.api.schemas.library import (
    ImportLibraryRequest,
    LibraryDetail,
    LibraryStatus,
    LibrarySummary,
    PhotoRow,
)
from engine.core.config import settings as app_settings
from engine.core.database import Database
from engine.services.scanner import backfill_hashes, scan_library
from engine.services.thumbnail import generate_library_thumbnails

logger = structlog.stdlib.get_logger()

router = APIRouter(prefix="/library", tags=["library"])


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


async def _backfill_then_thumbnails(db: Database, library_id: str) -> None:
    """阶段 2 + 3：补 SHA-256 + 异步生成缩略图（让 UI 能看到真照片，不是渐变占位）。"""
    await backfill_hashes(db, library_id)
    cache_root = app_settings.data_dir / "cache" / "thumbnails"
    await generate_library_thumbnails(db, library_id, cache_root)


async def _db(request: Request) -> Database:
    db = getattr(request.app.state, "db", None)
    if db is None:
        raise HTTPException(status_code=503, detail="Database not initialized")
    return db


async def _fetch_library_summary(db: Database, library_id: str) -> LibrarySummary | None:
    async with db.conn.execute(
        "SELECT * FROM libraries WHERE id = ?", (library_id,),
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        return None
    # Counts
    async with db.conn.execute(
        "SELECT COUNT(*) AS c FROM photos WHERE library_id = ?", (library_id,),
    ) as cur:
        total_row = await cur.fetchone()
    total = int(total_row["c"]) if total_row else 0
    async with db.conn.execute(
        "SELECT COUNT(*) AS c FROM analysis_results ar "
        "JOIN photos p ON ar.photo_id = p.id "
        "WHERE p.library_id = ? AND ar.is_active = 1",
        (library_id,),
    ) as cur:
        analyzed_row = await cur.fetchone()
    analyzed = int(analyzed_row["c"]) if analyzed_row else 0

    return LibrarySummary(
        id=str(row["id"]),
        display_name=str(row["display_name"]),
        parent_path=str(row["parent_path"]),
        root_path=str(row["root_path"]),
        status=LibraryStatus(str(row["status"])),
        total_count=total,
        analyzed_count=analyzed,
        recursive=bool(int(row["recursive"])),
        last_opened_at=str(row["last_opened_at"]),
        last_scanned_at=(
            str(row["last_scanned_at"]) if row["last_scanned_at"] is not None else None
        ),
        last_analyzed_at=(
            str(row["last_analyzed_at"]) if row["last_analyzed_at"] is not None else None
        ),
    )


@router.get("", response_model=list[LibrarySummary])
async def list_libraries(request: Request) -> list[LibrarySummary]:
    """GET /library — all libraries, most recently opened first."""
    db = await _db(request)
    async with db.conn.execute(
        "SELECT id FROM libraries ORDER BY last_opened_at DESC",
    ) as cur:
        ids = [str(r["id"]) async for r in cur]
    out: list[LibrarySummary] = []
    for lid in ids:
        summary = await _fetch_library_summary(db, lid)
        if summary is not None:
            out.append(summary)
    return out


@router.post("/import", response_model=LibrarySummary, status_code=201)
async def import_library(
    request: Request,
    body: ImportLibraryRequest,
    background_tasks: BackgroundTasks,
) -> LibrarySummary:
    """POST /library/import — register a folder and run phase-1 scan.

    阶段 2（SHA-256 backfill）通过 BackgroundTasks 异步进行：
    导入立刻返回，用户可浏览缩略图；哈希在后台补齐，分析任务依赖此哈希就绪。
    """
    db = await _db(request)
    # 纯同步路径操作耗时可忽略，不值得额外 asyncio.to_thread 包装
    root = Path(body.root_path).expanduser().resolve()  # noqa: ASYNC240
    if not root.exists():  # noqa: ASYNC240
        raise HTTPException(status_code=400, detail=f"Path does not exist: {root}")
    if not root.is_dir():  # noqa: ASYNC240
        raise HTTPException(status_code=400, detail=f"Not a directory: {root}")

    display = body.display_name or root.name or "未命名文件夹"
    parent = str(root.parent)
    root_str = str(root)
    now = _now_iso()

    # 如果已存在同 root_path，直接返回（幂等）
    async with db.conn.execute(
        "SELECT id FROM libraries WHERE root_path = ?", (root_str,),
    ) as cur:
        existing = await cur.fetchone()

    if existing is not None:
        library_id = str(existing["id"])
        await db.conn.execute(
            "UPDATE libraries SET last_opened_at = ?, status = ? WHERE id = ?",
            (now, LibraryStatus.SCANNING.value, library_id),
        )
    else:
        library_id = str(uuid.uuid4())
        await db.conn.execute(
            "INSERT INTO libraries (id, display_name, parent_path, root_path, "
            "status, recursive, created_at, last_opened_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (library_id, display, parent, root_str,
             LibraryStatus.SCANNING.value, 1 if body.recursive else 0, now, now),
        )
    await db.conn.commit()

    # Phase 1 scan (同步执行，完成后回转 READY；大库可在此处 kick off 异步任务)
    try:
        report = await scan_library(
            db, library_id=library_id, root=root, recursive=body.recursive,
        )
        await db.conn.execute(
            "UPDATE libraries SET status = ?, last_scanned_at = ? WHERE id = ?",
            (LibraryStatus.READY.value, _now_iso(), library_id),
        )
        await db.conn.commit()
        await logger.ainfo(
            "Library imported",
            library_id=library_id,
            root=root_str,
            added=report.added, unchanged=report.unchanged, updated=report.updated,
        )
        # 阶段 2/3：后台补 SHA-256 + 生成缩略图（不阻塞 import 响应）
        background_tasks.add_task(_backfill_then_thumbnails, db, library_id)
    except Exception:
        await db.conn.execute(
            "UPDATE libraries SET status = ? WHERE id = ?",
            (LibraryStatus.ERROR.value, library_id),
        )
        await db.conn.commit()
        await logger.aexception("Library import scan failed", library_id=library_id)
        raise HTTPException(status_code=500, detail="Scan failed") from None

    summary = await _fetch_library_summary(db, library_id)
    assert summary is not None
    return summary


@router.get("/{library_id}", response_model=LibraryDetail)
async def library_detail(request: Request, library_id: str) -> LibraryDetail:
    """GET /library/{id} — summary + photos."""
    db = await _db(request)
    summary = await _fetch_library_summary(db, library_id)
    if summary is None:
        raise HTTPException(status_code=404, detail="Library not found")

    async with db.conn.execute(
        "SELECT p.id, p.file_path, p.file_name, p.format, p.width, p.height, "
        "p.thumb_grid, p.thumb_preview, p.created_at, p.file_mtime, p.exif_json, "
        "ar.pipeline_version, ar.grade, ar.quality_score, ar.bird_count, ar.species, "
        "pd.decision "
        "FROM photos p "
        "LEFT JOIN analysis_results ar ON ar.photo_id = p.id AND ar.is_active = 1 "
        "LEFT JOIN photo_decisions pd ON pd.photo_id = p.id "
        "WHERE p.library_id = ? "
        "ORDER BY p.file_mtime ASC",
        (library_id,),
    ) as cur:
        rows = await cur.fetchall()

    def _resolve_shot_at(row: object) -> str:
        """优先级：EXIF DateTimeOriginal > file_mtime > created_at."""
        try:
            exif = row["exif_json"]  # type: ignore[index]
            if exif:
                import json
                data = json.loads(str(exif))
                dto = data.get("DateTimeOriginal")
                if dto and isinstance(dto, str):
                    # EXIF 格式 "2026:04:25 06:42:15" → ISO 8601
                    iso = dto.replace(":", "-", 2).replace(" ", "T")
                    return iso
        except Exception:
            pass
        try:
            mt = row["file_mtime"]  # type: ignore[index]
            if mt:
                return str(mt)
        except Exception:
            pass
        return str(row["created_at"])  # type: ignore[index]

    photos = [
        PhotoRow(
            id=str(r["id"]),
            file_path=str(r["file_path"]),
            file_name=str(r["file_name"]),
            format=(str(r["format"]) if r["format"] is not None else None),
            width=(int(r["width"]) if r["width"] is not None else None),
            height=(int(r["height"]) if r["height"] is not None else None),
            thumb_grid=(str(r["thumb_grid"]) if r["thumb_grid"] is not None else None),
            thumb_preview=(
                str(r["thumb_preview"]) if r["thumb_preview"] is not None else None
            ),
            created_at=str(r["created_at"]),
            shot_at=_resolve_shot_at(r),
            pipeline_version=(
                str(r["pipeline_version"])
                if r["pipeline_version"] is not None
                else None
            ),
            grade=(str(r["grade"]) if r["grade"] is not None else None),
            quality_score=(
                float(r["quality_score"]) if r["quality_score"] is not None else None
            ),
            bird_count=(
                int(r["bird_count"]) if r["bird_count"] is not None else None
            ),
            species=(str(r["species"]) if r["species"] is not None else None),
            decision=(str(r["decision"]) if r["decision"] is not None else "unreviewed"),
        )
        for r in rows
    ]

    return LibraryDetail(library=summary, photos=photos)


@router.delete("/{library_id}", status_code=204)
async def delete_library(request: Request, library_id: str) -> None:
    """DELETE /library/{id} — cascades to photos / analysis_results / task_queue."""
    db = await _db(request)
    async with db.conn.execute(
        "SELECT id FROM libraries WHERE id = ?", (library_id,),
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Library not found")

    await db.conn.execute("DELETE FROM libraries WHERE id = ?", (library_id,))
    await db.conn.commit()
    await logger.ainfo("Library deleted", library_id=library_id)


@router.post("/{library_id}/thumbnails", status_code=200)
async def build_thumbnails(request: Request, library_id: str) -> dict:
    """POST /library/{id}/thumbnails — generate missing thumbnails."""
    db = await _db(request)
    settings = request.app.state.settings if hasattr(request.app.state, "settings") else None
    if settings is None:
        from engine.core.config import settings as app_settings

        settings = app_settings
    cache_root = settings.data_dir / "cache" / "thumbnails"

    summary = await _fetch_library_summary(db, library_id)
    if summary is None:
        raise HTTPException(status_code=404, detail="Library not found")

    report = await generate_library_thumbnails(db, library_id, cache_root)
    return report
