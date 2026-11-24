# pyright: basic
"""Library management endpoints (import / list / detail / delete / scan)."""

from __future__ import annotations

import asyncio
import json
import sqlite3
import time
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, cast

import aiosqlite
import structlog
from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import TypeAdapter

from engine.api.schemas.library import (
    ImportLibraryRequest,
    LibraryDetail,
    LibraryStatus,
    LibrarySummary,
    PhotoBatchRequest,
    PhotoBatchResponse,
    PhotoReview,
    PhotoSummary,
    RelinkLibraryRequest,
    RelinkLibraryResponse,
    UpdateLibraryRequest,
)
from engine.api.schemas.selection import SelectionQueryRequest, SelectionQueryResponse
from engine.core.budgets import (
    MAX_LIBRARY_PAGE_LIMIT,
    MAX_SELECTION_PAGE_LIMIT,
    SUMMARY_ROWS_PER_CHUNK,
    SUMMARY_STREAM_THRESHOLD,
)
from engine.core.config import settings as app_settings
from engine.core.database import Database
from engine.services import archive_cache
from engine.services.event_bus import (
    TooManySubscribersError,
    publish_library_event,
    subscribe_library_events,
    unsubscribe_library_events,
)
from engine.services.library_projection import (
    LibraryProjectionNotFound,
    load_library_photos,
    load_library_photos_by_ids,
    load_photo_review,
    projection_revision,
)
from engine.services.library_projection import (
    _apply_group_species_consensus as _apply_group_species_consensus,
)
from engine.services.library_projection import (
    _iou_tuple as _iou_tuple,
)
from engine.services.library_projection import (
    _match_overrides_to_detections as _match_overrides_to_detections,
)
from engine.services.library_relink import RelinkAnalysis, RelinkedPhoto, verify_relinked_photo
from engine.services.library_summary import (
    dump_compact_summary_row,
    normalize_root_prefix,
    prepare_library_summary,
)
from engine.services.photo_input import invalidate_derived_input
from engine.services.scanner import backfill_hashes, scan_library
from engine.services.selection import (
    SelectionLibraryNotFound,
    SelectionProjectionCache,
    build_selection_projection,
    query_selection,
)
from engine.services.thumbnail import (
    delete_thumbnails_for_photos,
    ensure_thumbnails_for_photo,
    generate_library_thumbnails,
    thumbnail_cache_root,
)

logger = structlog.stdlib.get_logger()

router = APIRouter(prefix="/library", tags=["library"])


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


async def _backfill_then_thumbnails(db: Database, library_id: str) -> None:
    """阶段 2/3/4/5：补 SHA-256 + 生成缩略图 + 跑场景分组 + GPS reverse geocoding。"""
    await backfill_hashes(db, library_id)
    cache_root = thumbnail_cache_root(app_settings.data_dir)
    await generate_library_thumbnails(db, library_id, cache_root)
    # 缩略图就绪后才能跑场景相似度（用 preview 缩略图算 AKAZE/颜色）
    from engine.services.scene_grouper import regroup_library

    try:
        report = await regroup_library(db, library_id, cache_root)
        publish_library_event(library_id, "scene_groups_ready", report)
    except Exception as e:
        # cv2 未安装/library import 失败不影响其他流程
        await logger.aexception("scene grouping failed", library_id=library_id)
        _ = e

    # 阶段 5：reverse geocoding。之前只有 lifespan 启动期跑过一次,新 import 的
    # library 要等用户下次开应用才有省/市/区字段(羽迹页显示「未解析地点」)。
    # 现在 import 完成后就在 BackgroundTasks 里跑 — 不阻塞响应,完成时通过
    # archive_cache.invalidate 刷新羽迹聚合缓存(backfill_library_locations 内部
    # 已处理)。失败被 try/except 吞,不影响其他 import 流程。
    try:
        from engine.services.location_backfill import backfill_library_locations

        await backfill_library_locations(db, library_id)
    except Exception:
        await logger.aexception("post-import location backfill failed", library_id=library_id)


async def _db(request: Request) -> Database:
    db = getattr(request.app.state, "db", None)
    if db is None:
        raise HTTPException(status_code=503, detail="Database not initialized")
    return db


async def _path_exists(path: str) -> bool:
    return await asyncio.to_thread(Path(path).exists)


async def _sync_library_path_status(db: Database, row: Any) -> LibraryStatus:
    """Keep library.status honest when the source root was moved/renamed externally."""
    current = LibraryStatus(str(row["status"]))
    root_path = str(row["root_path"])
    exists = await _path_exists(root_path)

    if not exists:
        if current != LibraryStatus.PATH_MISSING:
            async with db.transaction() as conn:
                await conn.execute(
                    "UPDATE libraries SET status = ? WHERE id = ?",
                    (LibraryStatus.PATH_MISSING.value, str(row["id"])),
                )
        return LibraryStatus.PATH_MISSING

    if current == LibraryStatus.PATH_MISSING:
        async with db.transaction() as conn:
            await conn.execute(
                "UPDATE libraries SET status = ? WHERE id = ?",
                (LibraryStatus.READY.value, str(row["id"])),
            )
        return LibraryStatus.READY

    return current


async def _fetch_library_summary(db: Database, library_id: str) -> LibrarySummary | None:
    async with db.conn.execute(
        "SELECT * FROM libraries WHERE id = ?",
        (library_id,),
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        return None
    status = await _sync_library_path_status(db, row)
    # Counts
    async with db.conn.execute(
        "SELECT COUNT(*) AS c FROM photos WHERE library_id = ?",
        (library_id,),
    ) as cur:
        total_row = await cur.fetchone()
    total = int(total_row["c"]) if total_row else 0
    async with db.conn.execute(
        "SELECT COUNT(*) AS c FROM analysis_results ar "
        "JOIN photos p ON ar.photo_id = p.id "
        "WHERE p.library_id = ? AND ar.is_active = 1 AND ar.input_revision = p.input_revision",
        (library_id,),
    ) as cur:
        analyzed_row = await cur.fetchone()
    analyzed = int(analyzed_row["c"]) if analyzed_row else 0

    return LibrarySummary(
        id=str(row["id"]),
        display_name=str(row["display_name"]),
        parent_path=str(row["parent_path"]),
        root_path=str(row["root_path"]),
        status=status,
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


@router.get("/{library_id}/events")
async def library_events(request: Request, library_id: str) -> StreamingResponse:
    """GET /library/{id}/events — library-scoped SSE updates.

    Used for thumbnail readiness and scene grouping completion. The renderer can
    refresh the affected query only when the backend reports a state change,
    instead of polling the whole library while background work is running.
    """
    db = await _db(request)
    summary = await _fetch_library_summary(db, library_id)
    if summary is None:
        raise HTTPException(status_code=404, detail="Library not found")

    try:
        queue = subscribe_library_events(library_id)
    except TooManySubscribersError as exc:
        # 单 library 同时打开太多 SSE — renderer 泄漏 / 测试脚本 / 攻击。返
        # 429,客户端节流后再试。Retry-After 给 5s,renderer 重连不会立刻打爆。
        raise HTTPException(
            status_code=429,
            detail=f"Too many SSE subscribers for library (limit {exc.limit})",
            headers={"Retry-After": "5"},
        ) from exc

    async def _stream():
        try:
            snapshot = {
                "type": "library_snapshot",
                "library_id": library_id,
                "payload": {"status": summary.status.value},
                "created_at": _now_iso(),
            }
            yield f"event: library_snapshot\ndata: {json.dumps(snapshot)}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                except TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                event_type = str(event.get("type", "message"))
                payload = json.dumps(event, ensure_ascii=False)
                yield f"event: {event_type}\ndata: {payload}\n\n"
        finally:
            unsubscribe_library_events(library_id, queue)

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


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

    async with db.transaction() as conn:
        # 如果已存在同 root_path，直接返回（幂等）
        async with conn.execute(
            "SELECT id FROM libraries WHERE root_path = ?",
            (root_str,),
        ) as cur:
            existing = await cur.fetchone()

        if existing is not None:
            library_id = str(existing["id"])
            await conn.execute(
                "UPDATE libraries SET last_opened_at = ?, status = ? WHERE id = ?",
                (now, LibraryStatus.SCANNING.value, library_id),
            )
        else:
            library_id = str(uuid.uuid4())
            await conn.execute(
                "INSERT INTO libraries (id, display_name, parent_path, root_path, "
                "status, recursive, created_at, last_opened_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    library_id,
                    display,
                    parent,
                    root_str,
                    LibraryStatus.SCANNING.value,
                    1 if body.recursive else 0,
                    now,
                    now,
                ),
            )

    # Phase 1 scan (同步执行，完成后回转 READY；大库可在此处 kick off 异步任务)
    try:
        report = await scan_library(
            db,
            library_id=library_id,
            root=root,
            recursive=body.recursive,
        )
        async with db.transaction() as conn:
            await conn.execute(
                "UPDATE libraries SET status = ?, last_scanned_at = ? WHERE id = ?",
                (LibraryStatus.READY.value, _now_iso(), library_id),
            )
        await logger.ainfo(
            "Library imported",
            library_id=library_id,
            root=root_str,
            added=report.added,
            unchanged=report.unchanged,
            updated=report.updated,
        )
        # 阶段 2/3：后台补 SHA-256 + 生成缩略图（不阻塞 import 响应）
        background_tasks.add_task(_backfill_then_thumbnails, db, library_id)
    except Exception:
        async with db.transaction() as conn:
            await conn.execute(
                "UPDATE libraries SET status = ? WHERE id = ?",
                (LibraryStatus.ERROR.value, library_id),
            )
        await logger.aexception("Library import scan failed", library_id=library_id)
        raise HTTPException(status_code=500, detail="Scan failed") from None

    summary = await _fetch_library_summary(db, library_id)
    assert summary is not None
    return summary


async def _relink_inputs(
    conn: aiosqlite.Connection, library_id: str
) -> tuple[list[aiosqlite.Row], list[aiosqlite.Row]]:
    async with conn.execute(
        "SELECT id,file_path,file_size,file_mtime,companion_path,companion_size,companion_mtime,"
        "file_hash,input_revision,input_needs_scan "
        "FROM photos WHERE library_id=? ORDER BY id",
        (library_id,),
    ) as cur:
        photos = list(await cur.fetchall())
    async with conn.execute(
        "SELECT ar.id,ar.photo_id,ar.source_path,ar.source_hash,ar.source_fingerprint "
        "FROM analysis_results ar JOIN photos p ON ar.photo_id=p.id "
        "WHERE p.library_id=? AND ar.input_revision=p.input_revision "
        "AND ar.input_hash IS p.file_hash ORDER BY ar.id",
        (library_id,),
    ) as cur:
        analyses = list(await cur.fetchall())
    return photos, analyses


def _verify_relink_inputs(
    old_root: Path,
    new_root: Path,
    photos: list[aiosqlite.Row],
    analyses: dict[str, list[RelinkAnalysis]],
) -> list[RelinkedPhoto]:
    return [
        verify_relinked_photo(
            old_root,
            new_root,
            Path(row["file_path"]),
            Path(row["companion_path"]) if row["companion_path"] else None,
            row["file_hash"],
            analyses.get(row["id"], []),
        )
        for row in photos
    ]


def _needs_relink(
    row: aiosqlite.Row, candidate: RelinkedPhoto, analyses: list[RelinkAnalysis]
) -> bool:
    next_companion = str(candidate.companion.path) if candidate.companion else None
    if str(candidate.primary.path) != row["file_path"] or next_companion != row["companion_path"]:
        return True
    if row["input_needs_scan"]:
        return False  # The unchanged mapping already requires explicit scanning.
    if not candidate.verified:
        return True
    primary = candidate.primary.stamp
    companion = candidate.companion.stamp if candidate.companion else None
    assert primary is not None
    if (primary.size, primary.mtime) != (row["file_size"], row["file_mtime"]):
        return True
    if companion and (companion.size, companion.mtime) != (
        row["companion_size"],
        row["companion_mtime"],
    ):
        return True
    fingerprint = candidate.fingerprint()
    return any(a.source_fingerprint and a.source_fingerprint != fingerprint for a in analyses)


async def _apply_relinked_photo(
    conn: aiosqlite.Connection,
    row: aiosqlite.Row,
    candidate: RelinkedPhoto,
    analyses: list[RelinkAnalysis],
) -> None:
    next_primary = candidate.primary.path
    next_companion = candidate.companion.path if candidate.companion else None
    id_ = str(row["id"])
    old_revision = int(row["input_revision"])
    revision = old_revision + 1
    await conn.execute(
        "UPDATE photos SET file_path=?,companion_path=?,input_revision=? WHERE id=?",
        (str(next_primary), str(next_companion) if next_companion else None, revision, id_),
    )
    if not candidate.verified or row["input_needs_scan"]:
        await conn.execute(
            "UPDATE photos SET input_needs_scan=1,file_hash=NULL,width=NULL,height=NULL,"
            "exif_json=NULL WHERE id=?",
            (id_,),
        )
        await invalidate_derived_input(conn, id_)
        return

    primary_stamp = candidate.primary.stamp
    assert primary_stamp is not None
    companion_stamp = candidate.companion.stamp if candidate.companion else None
    await conn.execute(
        "UPDATE photos SET file_size=?,file_mtime=?,companion_size=?,companion_mtime=? WHERE id=?",
        (
            primary_stamp.size,
            primary_stamp.mtime,
            companion_stamp.size if companion_stamp else None,
            companion_stamp.mtime if companion_stamp else None,
            id_,
        ),
    )

    # The bytes are unchanged. Keep the cached outputs and overrides while
    # rebasing source paths and the revision checked by in-flight publishers.
    paths = {Path(row["file_path"]): str(next_primary)}
    if row["companion_path"] and next_companion:
        paths[Path(row["companion_path"])] = str(next_companion)
    fingerprint = candidate.fingerprint()
    for analysis in analyses:
        source_path = paths.get(Path(analysis.source_path)) if analysis.source_path else None
        if analysis.source_path and source_path is None:
            continue
        await conn.execute(
            "UPDATE analysis_results SET input_revision=?,source_path=?,source_fingerprint=? "
            "WHERE id=?",
            (revision, source_path, fingerprint, analysis.id),
        )
    await conn.execute(
        "UPDATE analysis_results SET is_active=0 WHERE photo_id=? AND input_revision<>?",
        (id_, revision),
    )
    await conn.execute(
        "UPDATE photo_species_overrides SET input_revision=? WHERE photo_id=? AND input_revision=?",
        (revision, id_, old_revision),
    )
    await conn.execute(
        "UPDATE task_queue SET input_revision=? WHERE photo_id=? AND input_revision=? "
        "AND status IN ('pending','paused')",
        (revision, id_, old_revision),
    )


@router.post("/{library_id}/relink", response_model=RelinkLibraryResponse)
async def relink_library(
    request: Request,
    library_id: str,
    body: RelinkLibraryRequest,
) -> RelinkLibraryResponse:
    """Point a moved library at a new root and retain results for verified inputs."""
    db = await _db(request)
    new_root = Path(body.root_path).expanduser().resolve()  # noqa: ASYNC240
    if not new_root.exists():  # noqa: ASYNC240
        raise HTTPException(status_code=400, detail=f"Path does not exist: {new_root}")
    if not new_root.is_dir():  # noqa: ASYNC240
        raise HTTPException(status_code=400, detail=f"Not a directory: {new_root}")

    async with db.transaction() as conn:
        async with conn.execute("SELECT root_path FROM libraries WHERE id=?", (library_id,)) as cur:
            library = await cur.fetchone()
        if library is None:
            raise HTTPException(status_code=404, detail="Library not found")
        async with conn.execute(
            "SELECT id FROM libraries WHERE root_path=? AND id<>?", (str(new_root), library_id)
        ) as cur:
            if await cur.fetchone() is not None:
                raise HTTPException(status_code=409, detail="Path is already imported")
        rows, analysis_rows = await _relink_inputs(conn, library_id)

    previous_root_path = str(library["root_path"])
    analyses: dict[str, list[RelinkAnalysis]] = {}
    for row in analysis_rows:
        analyses.setdefault(str(row["photo_id"]), []).append(
            RelinkAnalysis(
                row["id"], row["source_path"], row["source_hash"], row["source_fingerprint"]
            )
        )

    try:
        candidates = await asyncio.to_thread(
            _verify_relink_inputs, Path(previous_root_path), new_root, rows, analyses
        )
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=409, detail="Unable to verify relink sources") from exc

    matched = sum(candidate.primary.verified for candidate in candidates)
    if rows and (not matched or (len(rows) >= 5 and matched * 2 < len(rows))):
        raise HTTPException(
            status_code=400, detail="New folder does not contain enough verified library photos"
        )
    changed = [
        (row, candidate)
        for row, candidate in zip(rows, candidates, strict=True)
        if _needs_relink(row, candidate, analyses.get(row["id"], []))
    ]

    try:
        async with db.transaction() as conn:
            # Hashing happens outside the write transaction. Recheck the DB
            # snapshot and physical destination stamps before committing it.
            if await _relink_inputs(conn, library_id) != (rows, analysis_rows) or not (
                await asyncio.to_thread(lambda: all(c.unchanged() for c in candidates))
            ):
                raise HTTPException(status_code=409, detail="Library changed during relink; retry")
            if changed or str(new_root) != previous_root_path:
                async with conn.execute(
                    "SELECT 1 FROM task_queue WHERE library_id=? AND status='processing' LIMIT 1",
                    (library_id,),
                ) as cur:
                    if await cur.fetchone() is not None:
                        raise HTTPException(
                            status_code=409, detail="Library analysis is in progress"
                        )
                async with conn.execute(
                    "UPDATE libraries SET parent_path=?,root_path=?,status=?,last_opened_at=? "
                    "WHERE id=? AND root_path=? AND status NOT IN ('scanning','updating') "
                    "RETURNING id",
                    (
                        str(new_root.parent),
                        str(new_root),
                        LibraryStatus.READY.value,
                        _now_iso(),
                        library_id,
                        previous_root_path,
                    ),
                ) as cur:
                    if await cur.fetchone() is None:
                        raise HTTPException(
                            status_code=409, detail="Library changed during relink; retry"
                        )
                for row, candidate in changed:
                    await _apply_relinked_photo(conn, row, candidate, analyses.get(row["id"], []))
    except sqlite3.IntegrityError as e:
        raise HTTPException(
            status_code=409,
            detail="Relinked paths conflict with existing photos",
        ) from e
    except OSError as exc:
        raise HTTPException(status_code=409, detail="Library changed during relink; retry") from exc

    archive_cache.invalidate()
    summary = await _fetch_library_summary(db, library_id)
    assert summary is not None
    publish_library_event(
        library_id,
        "library_updated",
        {
            "root_path": summary.root_path,
            "status": summary.status.value,
        },
    )
    return RelinkLibraryResponse(
        library=summary,
        previous_root_path=previous_root_path,
        matched_photos=matched,
        relinked_photos=len(candidates),
        missing_photos=len(rows) - matched,
        relinked_companions=sum(
            candidate.companion is not None and candidate.companion.verified
            for candidate in candidates
        ),
    )


@router.patch("/{library_id}", response_model=LibrarySummary)
async def update_library(
    request: Request,
    library_id: str,
    body: UpdateLibraryRequest,
) -> LibrarySummary:
    """PATCH /library/{id} — update user-facing folder alias.

    The alias is stored in libraries.display_name, which is also the name used by
    export output folders and manifest metadata.
    """
    db = await _db(request)
    display_name = body.display_name.strip()
    if not display_name:
        raise HTTPException(status_code=400, detail="Display name cannot be empty")

    summary = await _fetch_library_summary(db, library_id)
    if summary is None:
        raise HTTPException(status_code=404, detail="Library not found")

    async with db.transaction() as conn:
        await conn.execute(
            "UPDATE libraries SET display_name = ? WHERE id = ?",
            (display_name, library_id),
        )
    updated = await _fetch_library_summary(db, library_id)
    assert updated is not None
    publish_library_event(
        library_id,
        "library_updated",
        {"display_name": updated.display_name},
    )
    return updated


_SUMMARY_BATCH_MEDIA_TYPE = "application/x-ndjson"
_SUMMARY_STREAM_THRESHOLD = SUMMARY_STREAM_THRESHOLD
_SUMMARY_ROWS_PER_CHUNK = SUMMARY_ROWS_PER_CHUNK
_SUMMARY_ROWS = TypeAdapter(list[PhotoSummary])


def _encode_summary_rows(photos: list[PhotoSummary]) -> bytes:
    return _SUMMARY_ROWS.dump_json(photos)[1:-1]


def _encode_compact_summary_rows(photos: list[PhotoSummary], root_prefix: str) -> bytes:
    return b",".join(dump_compact_summary_row(photo, root_prefix) for photo in photos)


async def _stream_library_summary(
    detail: LibraryDetail,
    photos: list[PhotoSummary],
    *,
    batches: bool = False,
    compact: bool = False,
) -> AsyncIterator[bytes]:
    # The nested models have already been validated by library projection.
    # Reuse their serializers and the envelope fields used by the buffered path.
    root_prefix = normalize_root_prefix(detail.library.root_path) if compact else ""
    if batches:
        yield detail.model_dump_json(exclude={"photos"}).encode() + b"\n"
    else:
        yield b'{"library":' + detail.library.model_dump_json().encode() + b',"photos":['
    for start in range(0, len(photos), _SUMMARY_ROWS_PER_CHUNK):
        await asyncio.sleep(0)
        chunk = photos[start : start + _SUMMARY_ROWS_PER_CHUNK]
        if batches:
            rows = (
                _encode_compact_summary_rows(chunk, root_prefix)
                if compact
                else _encode_summary_rows(chunk)
            )
            yield b"[" + rows + b"]\n"
        else:
            rows = _encode_summary_rows(chunk)
            yield (b"," if start else b"") + rows
    if batches:
        # The count is from the same photo snapshot. Library metadata can be
        # read earlier and legitimately carry a different photo_total.
        yield f"{len(photos)}\n".encode()
    else:
        yield b"]," + detail.model_dump_json(exclude={"library", "photos"}).encode()[1:]


async def _stream_prepared_summary(
    detail: LibraryDetail, rows: list[bytes]
) -> AsyncIterator[bytes]:
    yield detail.model_dump_json(exclude={"photos"}).encode() + b"\n"
    for start in range(0, len(rows), _SUMMARY_ROWS_PER_CHUNK):
        await asyncio.sleep(0)
        yield b"[" + b",".join(rows[start : start + _SUMMARY_ROWS_PER_CHUNK]) + b"]\n"
    yield f"{len(rows)}\n".encode()


@router.get("/{library_id}", response_model=LibraryDetail)
async def library_detail(
    request: Request,
    response: Response,
    library_id: str,
    limit: int | None = Query(default=None, ge=1, le=MAX_LIBRARY_PAGE_LIMIT),
    offset: int = Query(default=0, ge=0),
    include_selection_snapshot: bool = Query(default=False),
    view: Literal["full", "summary"] = Query(default="full"),
    summary_format: Literal["compact-v1"] | None = Query(default=None),
) -> LibraryDetail | StreamingResponse:
    """GET /library/{id} — summary + photos.

    默认保持旧契约一次返回全量照片。传入 limit/offset 时按
    `(library_id, file_mtime)` 索引分页,为大图库前端逐步迁移做准备。
    """
    started = time.perf_counter()
    db = await _db(request)
    summary = await _fetch_library_summary(db, library_id)
    if summary is None:
        raise HTTPException(status_code=404, detail="Library not found")
    photo_total = summary.total_count

    batches = request.headers.get("accept") == _SUMMARY_BATCH_MEDIA_TYPE
    use_compact = batches and summary_format == "compact-v1"
    try:
        if (
            batches
            and view == "summary"
            and limit is None
            and photo_total >= _SUMMARY_STREAM_THRESHOLD
        ):
            projections: SelectionProjectionCache = request.app.state.selection_projections
            prepared = await prepare_library_summary(
                db,
                library_id,
                include_selection_snapshot,
                projections.latest(library_id) if include_selection_snapshot else None,
                root_path=summary.root_path,
                compact=use_compact,
            )
            if prepared.selection is not None:
                projections.store(library_id, prepared.selection)
            detail = LibraryDetail(
                library=summary,
                photos=[],
                projection_revision=prepared.revision,
                photo_total=photo_total,
                photo_offset=offset,
                summary_format="compact-v1" if use_compact else None,
            )
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            payload_bytes = sum(len(r) for r in prepared.rows)
            return StreamingResponse(
                _stream_prepared_summary(detail, prepared.rows),
                media_type=_SUMMARY_BATCH_MEDIA_TYPE,
                headers={
                    "Vary": "Accept",
                    "Cache-Control": "no-store",
                    "X-PlumeLens-Projection-Ms": f"{elapsed_ms:.1f}",
                    "X-PlumeLens-Photo-Count": str(len(prepared.rows)),
                    "X-PlumeLens-Payload-Bytes": str(payload_bytes),
                },
            )
        photos = await load_library_photos(
            db, library_id, limit=limit, offset=offset, summary=view == "summary"
        )
    except LibraryProjectionNotFound as exc:
        raise HTTPException(status_code=404, detail="Library not found") from exc
    revision = None
    if limit is None:
        if include_selection_snapshot:
            projections: SelectionProjectionCache = request.app.state.selection_projections
            projection = await asyncio.to_thread(
                build_selection_projection, library_id, photos, projections.latest(library_id)
            )
            projections.store(library_id, projection)
            revision = projection.revision
        else:
            revision = await asyncio.to_thread(projection_revision, library_id, photos)

    next_offset = None
    if limit is not None and offset + len(photos) < photo_total:
        next_offset = offset + len(photos)

    stream = view == "summary" and limit is None and len(photos) >= _SUMMARY_STREAM_THRESHOLD
    detail = LibraryDetail(
        library=summary,
        photos=[] if stream else photos,
        projection_revision=revision,
        photo_total=photo_total,
        photo_offset=offset,
        photo_limit=limit,
        next_offset=next_offset,
        summary_format="compact-v1" if (stream and use_compact) else None,
    )
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    if stream:
        return StreamingResponse(
            _stream_library_summary(
                detail,
                cast("list[PhotoSummary]", photos),
                batches=batches,
                compact=use_compact,
            ),
            media_type=_SUMMARY_BATCH_MEDIA_TYPE if batches else "application/json",
            headers={
                "Vary": "Accept",
                "Cache-Control": "no-store",
                "X-PlumeLens-Projection-Ms": f"{elapsed_ms:.1f}",
                "X-PlumeLens-Photo-Count": str(len(photos)),
            },
        )
    response.headers["X-PlumeLens-Projection-Ms"] = f"{elapsed_ms:.1f}"
    response.headers["X-PlumeLens-Photo-Count"] = str(len(photos))
    return detail


@router.post("/{library_id}/photos/batch", response_model=PhotoBatchResponse)
async def library_photos_batch(
    request: Request,
    response: Response,
    library_id: str,
    body: PhotoBatchRequest,
    projection_revision: str | None = Query(default=None, pattern=r"^[0-9a-f]{64}$"),
) -> PhotoBatchResponse:
    """Hydrate a bounded page of photo summaries/rows by ID with scene-consistent consensus."""
    started = time.perf_counter()
    db = await _db(request)
    if projection_revision is not None:
        projections: SelectionProjectionCache = request.app.state.selection_projections
        if projections.get(library_id, projection_revision) is None:
            raise HTTPException(status_code=409, detail="Selection snapshot expired")
    try:
        photos = await load_library_photos_by_ids(
            db, library_id, body.photo_ids, summary=body.view == "summary"
        )
    except LibraryProjectionNotFound as exc:
        raise HTTPException(status_code=404, detail="Library not found") from exc
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    response.headers["X-PlumeLens-Projection-Ms"] = f"{elapsed_ms:.1f}"
    response.headers["X-PlumeLens-Photo-Count"] = str(len(photos))
    return PhotoBatchResponse(
        library_id=library_id,
        projection_revision=projection_revision,
        photos=photos,
    )


@router.get("/photo/{photo_id}/review", response_model=PhotoReview)
async def photo_review(request: Request, photo_id: str) -> PhotoReview:
    """Hydrate the selected photo using a single, scene-consistent snapshot."""
    db = await _db(request)
    try:
        library_id, photo = await load_photo_review(db, photo_id)
    except LibraryProjectionNotFound as exc:
        raise HTTPException(status_code=404, detail="Photo not found") from exc
    return PhotoReview(library_id=library_id, photo=photo)


@router.post("/{library_id}/selection/query", response_model=SelectionQueryResponse)
async def selection_query(
    request: Request,
    response: Response,
    library_id: str,
    body: SelectionQueryRequest,
    projection_revision: str | None = Query(default=None, pattern=r"^[0-9a-f]{64}$"),
    limit: int | None = Query(default=None, ge=1, le=MAX_SELECTION_PAGE_LIMIT),
    offset: int = Query(default=0, ge=0),
) -> SelectionQueryResponse:
    """Read-only authoritative filters, effective identities and deduplicated facets."""
    started = time.perf_counter()
    db = await _db(request)
    projection = None
    if projection_revision is not None:
        projections: SelectionProjectionCache = request.app.state.selection_projections
        projection = projections.get(library_id, projection_revision)
        if projection is None:
            raise HTTPException(status_code=409, detail="Selection snapshot expired")
    try:
        result = await query_selection(
            db, library_id, body, projection=projection, limit=limit, offset=offset
        )
    except SelectionLibraryNotFound as exc:
        raise HTTPException(status_code=404, detail="Library not found") from exc
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    response.headers["X-PlumeLens-Projection-Ms"] = f"{elapsed_ms:.1f}"
    response.headers["X-PlumeLens-Photo-Count"] = str(len(result.matched_photo_ids))
    return result


@router.post("/photo/{photo_id}/thumbnail", status_code=200)
async def build_photo_thumbnail(request: Request, photo_id: str) -> dict:
    """POST /library/photo/{photo_id}/thumbnail — rebuild one visible thumbnail."""
    db = await _db(request)
    async with db.conn.execute(
        "SELECT library_id FROM photos WHERE id = ?",
        (photo_id,),
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Photo not found")

    library_id = str(row["library_id"])
    settings = request.app.state.settings if hasattr(request.app.state, "settings") else None
    if settings is None:
        from engine.core.config import settings as app_settings

        settings = app_settings
    cache_root = thumbnail_cache_root(settings.data_dir)

    result = await ensure_thumbnails_for_photo(db, photo_id, cache_root, force=True)
    async with db.conn.execute(
        "SELECT thumb_grid, thumb_preview FROM photos WHERE id = ?",
        (photo_id,),
    ) as cur:
        updated = await cur.fetchone()

    built = result is not None
    payload = {
        "photo_id": photo_id,
        "library_id": library_id,
        "built": built,
        "thumb_grid": str(updated["thumb_grid"]) if updated and updated["thumb_grid"] else None,
        "thumb_preview": (
            str(updated["thumb_preview"]) if updated and updated["thumb_preview"] else None
        ),
    }
    publish_library_event(
        library_id,
        "thumbnail_ready" if built else "thumbnail_failed",
        payload,
    )
    return payload


@router.delete("/{library_id}", status_code=204)
async def delete_library(request: Request, library_id: str) -> None:
    """DELETE /library/{id} — 移除应用内的全部记录,**不动源文件夹**。

    DB 侧靠外键 CASCADE 清 photos / analysis_results / task_queue / decisions;
    缩略图是磁盘文件不受 CASCADE 管,必须在删行之前把 photo_id 取出来,否则行
    一没就再也定位不到那些文件 —— 那是永久泄漏。
    """
    db = await _db(request)
    async with db.transaction() as conn:
        async with conn.execute(
            "SELECT id FROM libraries WHERE id = ?",
            (library_id,),
        ) as cur:
            row = await cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Library not found")

        async with conn.execute(
            "SELECT id FROM photos WHERE library_id = ?",
            (library_id,),
        ) as cur:
            photo_ids = [str(photo["id"]) for photo in await cur.fetchall()]

        async with conn.execute(
            "DELETE FROM libraries WHERE id = ?",
            (library_id,),
        ) as cur:
            deleted = cur.rowcount or 0
    if deleted == 0:
        # 上面已检查过 row 存在,DELETE 的 rowcount 为 0 表示约束阻止删除(外键
        # 缺 CASCADE / 触发器拦下等)。返回 500 而非静默成功 — 用户可能看到删除
        # 按钮按了无反应,需要排查。
        raise HTTPException(status_code=500, detail="Library deletion failed (constraint)")

    projections: SelectionProjectionCache = request.app.state.selection_projections
    projections.discard_library(library_id)
    settings = getattr(request.app.state, "settings", None)
    if settings is None:
        from engine.core.config import settings as app_settings

        settings = app_settings
    removed_thumbnails = await asyncio.to_thread(
        delete_thumbnails_for_photos,
        photo_ids,
        thumbnail_cache_root(settings.data_dir),
    )

    archive_cache.invalidate()
    await logger.ainfo(
        "Library deleted",
        library_id=library_id,
        photos=len(photo_ids),
        thumbnails_removed=removed_thumbnails,
    )


@router.post("/{library_id}/thumbnails", status_code=200)
async def build_thumbnails(request: Request, library_id: str) -> dict:
    """POST /library/{id}/thumbnails — generate missing thumbnails."""
    db = await _db(request)
    settings = request.app.state.settings if hasattr(request.app.state, "settings") else None
    if settings is None:
        from engine.core.config import settings as app_settings

        settings = app_settings
    cache_root = thumbnail_cache_root(settings.data_dir)

    summary = await _fetch_library_summary(db, library_id)
    if summary is None:
        raise HTTPException(status_code=404, detail="Library not found")

    report = await generate_library_thumbnails(db, library_id, cache_root)
    return report


@router.post("/{library_id}/scene-groups", status_code=200)
async def regroup_scenes(request: Request, library_id: str) -> dict:
    """POST /library/{id}/scene-groups — 重新计算 scene_id（AKAZE 特征 + 颜色直方图）。

    用 preview 缩略图（1920px）做相似度，避免重新解码原 RAW。
    """
    db = await _db(request)
    summary = await _fetch_library_summary(db, library_id)
    if summary is None:
        raise HTTPException(status_code=404, detail="Library not found")

    cache_root = thumbnail_cache_root(app_settings.data_dir)
    from engine.services.scene_grouper import regroup_library

    return await regroup_library(db, library_id, cache_root)
