# pyright: basic
"""Analysis endpoints (single + batch + SSE progress)."""

from __future__ import annotations

import asyncio
from pathlib import Path

import structlog
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from engine.api.schemas.analysis import (
    AnalysisBatchRequest,
    AnalysisBatchResponse,
    AnalysisProgressEvent,
    QueueStats,
    TaskRow,
)
from engine.core.config import settings
from engine.core.database import Database
from engine.pipeline.manager import PipelineManager
from engine.services.analysis_worker import (
    _batch_locks,
    _workers,
    cancel_all_workers,
    cancel_library_worker,
    get_active_worker_count,
    get_library_worker,
    start_library_worker,
)
from engine.services.analysis_worker import (
    has_active_tasks as _has_active_tasks,
)
from engine.services.analysis_worker import (
    mark_library_analysis_idle as _mark_library_analysis_idle,
)
from engine.services.analysis_worker import (
    mark_library_analyzing as _mark_library_analyzing,
)
from engine.services.analysis_worker import (
    run_one_task as _run_one_task,
)
from engine.services.queue import (
    TaskStatus,
    cancel_library,
    clear_terminal_tasks,
    enqueue_library,
    get_library_control,
    get_stats,
    list_tasks,
    pause_library,
    resume_library,
)
from engine.services.scanner import backfill_hashes

__all__ = [
    "_batch_locks",
    "_run_one_task",
    "_workers",
    "cancel_all_workers",
    "cancel_library_worker",
    "get_active_worker_count",
    "get_library_worker",
    "router",
    "start_library_worker",
]

logger = structlog.stdlib.get_logger()

router = APIRouter(prefix="/analysis", tags=["analysis"])

# 并发数从 settings.analysis_concurrency 读取（默认 2，见 engine/core/config.py）。
# 每个 task 内 ONNX 推理在 thread pool 释放 GIL，多 worker = 多张图并行推理。
# CoreML EP 多 session 在 ANE/GPU 上能共享资源。SQLite WAL 模式允许并发读 + 单写，
# cache.store 写入有 busy_timeout 5s 兜底。

# SSE 进度推送轮询间隔（秒）
SSE_INTERVAL = 1.0

# 单 library 同时允许的 progress SSE 长连接数。本地桌面 UI 正常 1 个,留 8 给
# hot-reload / Playwright / 异常 renderer 缓冲;阻止失控调用方靠不停 open
# EventSource 把 _progress_streams 拖大占用 ThreadPool / 阻塞队列推进。
MAX_PROGRESS_SSE_PER_LIBRARY = 8

# 当前各 library 活跃 progress SSE 连接计数 — incr / decr 都在协程内做,不需要 lock
# (asyncio 单线程内修改 dict 是原子)。
_progress_stream_counts: dict[str, int] = {}


def _has_rescannable_input(paths: list[Path]) -> bool:
    for path in paths:
        try:
            if path.is_file():
                return True
        except OSError:
            return True  # Unreadable is different from missing.
    return False


async def _db(request: Request) -> Database:
    db = getattr(request.app.state, "db", None)
    if db is None:
        raise HTTPException(status_code=503, detail="Database not initialized")
    return db


async def _ensure_library_source_available(db: Database, library_id: str) -> None:
    async with (
        db.read_snapshot() as conn,
        conn.execute(
            "SELECT root_path, status FROM libraries WHERE id = ?",
            (library_id,),
        ) as cur,
    ):
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Library not found")

    root_path = str(row["root_path"])
    exists = await asyncio.to_thread(Path(root_path).exists)
    if not exists:
        async with db.transaction() as conn:
            await conn.execute(
                "UPDATE libraries SET status = 'path_missing' WHERE id = ?",
                (library_id,),
            )
        raise HTTPException(
            status_code=409,
            detail="Library source path is missing; relink the folder before analysis",
        )
    if str(row["status"]) == "path_missing":
        async with db.transaction() as conn:
            await conn.execute(
                "UPDATE libraries SET status = 'ready' WHERE id = ?",
                (library_id,),
            )


async def _pipeline(request: Request) -> PipelineManager:
    pipeline = getattr(request.app.state, "pipeline", None)
    if pipeline is None:
        raise HTTPException(status_code=503, detail="Pipeline not initialized")
    if not pipeline.is_ready:
        raise HTTPException(
            status_code=503,
            detail="Pipeline not ready (core models not loaded)",
        )
    return pipeline


@router.post("/batch", response_model=AnalysisBatchResponse)
async def start_batch(
    request: Request,
    body: AnalysisBatchRequest,
) -> AnalysisBatchResponse:
    """POST /analysis/batch — enqueue all photos in library + spawn worker.

    安全网：先同步补齐 SHA-256（如果 import 后台任务还没跑完），再入队。
    enqueue_library 只会取 file_hash IS NOT NULL 的照片，所以这一步保证用户
    手动触发分析时不会因哈希未完成而 enqueued=0。
    """
    db = await _db(request)
    pipeline = await _pipeline(request)
    await _ensure_library_source_available(db, body.library_id)

    async with (
        db.read_snapshot() as conn,
        conn.execute(
            "SELECT file_path FROM photos WHERE library_id=? AND input_needs_scan=1",
            (body.library_id,),
        ) as cur,
    ):
        pending_rescan = [Path(row["file_path"]) for row in await cur.fetchall()]
    # A partial relink can retain missing rows for history. They are excluded
    # from hash backfill and the queue, so they cannot prevent other work.
    if pending_rescan and await asyncio.to_thread(_has_rescannable_input, pending_rescan):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "source_changed",
                "message": "Update the folder before retrying analysis",
            },
        )

    # 同步补哈希（幂等，已有哈希的 photo 直接跳过；空集时秒级返回）
    await backfill_hashes(db, body.library_id)

    # Serialize per-library batch startup so concurrent POST /analysis/batch calls
    # cannot race between checking active tasks, clearing terminal rows, and spawning.
    batch_lock = _batch_locks.setdefault(body.library_id, asyncio.Lock())
    async with batch_lock:
        # 新一轮开始前清掉上轮终态队列，避免进度 total 被历史 completed/dead/cancelled
        # 累加污染。若已有 active task，则保留当前 live ledger，继续复用 worker。
        existing_stats = await get_stats(db, body.library_id)
        existing_worker = _workers.get(body.library_id)
        if existing_worker is not None and existing_worker.done():
            _workers.pop(body.library_id, None)
        elif existing_worker is not None and not _has_active_tasks(existing_stats):
            try:
                await asyncio.wait_for(asyncio.shield(existing_worker), timeout=2.0)
            except TimeoutError:
                logger.warning(
                    "Cancelling idle analysis worker before starting a new batch",
                    library_id=body.library_id,
                )
                existing_worker.cancel()
                await asyncio.gather(existing_worker, return_exceptions=True)
            except Exception as e:
                logger.warning(
                    "Previous analysis worker finished with error before new batch",
                    library_id=body.library_id,
                    error=str(e),
                )
            finally:
                _workers.pop(body.library_id, None)

        if body.force_rerun and _has_active_tasks(existing_stats):
            raise HTTPException(
                status_code=409,
                detail="Cannot force rerun while this library already has active analysis tasks",
            )
        if not _has_active_tasks(existing_stats):
            await clear_terminal_tasks(db, body.library_id)

        # 传 pipeline_version 进 enqueue → 当前版本已分析过的 photo 跳过（去重）。
        # 之前 bug：用户多次点开始分析（或 lifespan resume + 手动点）会让同一 photo
        # 累积多个 task_queue 行 → 783 张照片产生 3173 个 task = 4× 膨胀。
        # 现在按 (file_hash, pipeline_version) 单一来源去重。
        inserted = await enqueue_library(
            db,
            body.library_id,
            current_pipeline_version=pipeline.pipeline_version,
            force_rerun=body.force_rerun,
        )

        stats = await get_stats(db, body.library_id)
        if _has_active_tasks(stats):
            await _mark_library_analyzing(db, body.library_id)
        else:
            await _mark_library_analysis_idle(db, body.library_id)

        # Kick off drain worker（不阻塞返回）
        start_library_worker(
            db,
            pipeline,
            body.library_id,
            settings.analysis_concurrency,
            force_rerun=body.force_rerun,
        )

        stats = await get_stats(db, body.library_id)
        return AnalysisBatchResponse(
            library_id=body.library_id,
            enqueued=inserted,
            stats=stats,
        )


@router.post("/library/{library_id}/pause", response_model=QueueStats)
async def pause(request: Request, library_id: str) -> QueueStats:
    db = await _db(request)
    lock = _batch_locks.setdefault(library_id, asyncio.Lock())
    async with lock:
        await pause_library(db, library_id)
        current_stats = await get_stats(db, library_id)
        if _has_active_tasks(current_stats):
            await _mark_library_analyzing(db, library_id)
        else:
            await _mark_library_analysis_idle(db, library_id)
        return QueueStats(
            library_id=library_id,
            stats=current_stats,
            **await get_library_control(db, library_id),
        )


@router.post("/library/{library_id}/resume", response_model=QueueStats)
async def resume(request: Request, library_id: str) -> QueueStats:
    db = await _db(request)
    pipeline = await _pipeline(request)
    lock = _batch_locks.setdefault(library_id, asyncio.Lock())
    async with lock:
        await _ensure_library_source_available(db, library_id)
        await resume_library(db, library_id)
        await _mark_library_analyzing(db, library_id)
        # 重启 drain worker
        start_library_worker(db, pipeline, library_id, settings.analysis_concurrency)
        return QueueStats(
            library_id=library_id,
            stats=await get_stats(db, library_id),
            **await get_library_control(db, library_id),
        )


@router.post("/library/{library_id}/cancel", response_model=QueueStats)
async def cancel(request: Request, library_id: str) -> QueueStats:
    db = await _db(request)
    lock = _batch_locks.setdefault(library_id, asyncio.Lock())
    async with lock:
        await cancel_library(db, library_id)
        stats = await get_stats(db, library_id)
        if int(stats.get(TaskStatus.PROCESSING.value, 0)) > 0:
            await _mark_library_analyzing(db, library_id)
        else:
            await _mark_library_analysis_idle(db, library_id)
        return QueueStats(
            library_id=library_id, stats=stats, **await get_library_control(db, library_id)
        )


@router.get("/library/{library_id}/stats", response_model=QueueStats)
async def stats(request: Request, library_id: str) -> QueueStats:
    db = await _db(request)
    return QueueStats(
        library_id=library_id,
        stats=await get_stats(db, library_id),
        **await get_library_control(db, library_id),
    )


@router.get("/library/{library_id}/tasks", response_model=list[TaskRow])
async def library_tasks(
    request: Request,
    library_id: str,
    status: str | None = None,
    limit: int = Query(default=200, ge=1, le=2000),
) -> list[TaskRow]:
    """GET /analysis/library/{id}/tasks — list tasks filtered by status."""
    db = await _db(request)
    try:
        status_enum = TaskStatus(status) if status else None
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid task status: {status}") from exc
    tasks = await list_tasks(db, library_id=library_id, status=status_enum, limit=limit)
    return [
        TaskRow(
            id=t.id,
            photo_id=t.photo_id,
            library_id=t.library_id,
            status=t.status.value,
            priority=t.priority,
            attempts=t.attempts,
            error_message=t.error_message,
            created_at=t.created_at,
            started_at=t.started_at,
            completed_at=t.completed_at,
        )
        for t in tasks
    ]


async def _progress_stream(request: Request, db: Database, library_id: str):
    """Generator yielding SSE `data: ...` lines.

    推送策略：每 SSE_INTERVAL 秒一次状态快照；两次相邻状态相同时不重发（节省流量）。
    **不会主动关闭** — 长连接保持到客户端断开，空闲时每 15 秒发送 keepalive 注释。
    """
    _progress_stream_counts[library_id] = _progress_stream_counts.get(library_id, 0) + 1
    last_payload: str | None = None
    idle_ticks = 0
    try:
        while True:
            if await request.is_disconnected():
                break
            stats_dict = await get_stats(db, library_id)
            total = sum(stats_dict.values())
            completed = stats_dict.get("completed", 0)
            pending = stats_dict.get("pending", 0)
            processing = stats_dict.get("processing", 0)
            failed = stats_dict.get("failed", 0)
            dead = stats_dict.get("dead", 0)
            event = AnalysisProgressEvent(
                library_id=library_id,
                completed=completed,
                total=total,
                pending=pending,
                processing=processing,
                failed=failed,
                dead=dead,
                current_photo_id=None,
                **await get_library_control(db, library_id),
            )
            payload = event.model_dump_json()
            if payload != last_payload:
                yield f"data: {payload}\n\n"
                last_payload = payload
                idle_ticks = 0
            else:
                idle_ticks += 1
                if idle_ticks >= 15:
                    yield ": keepalive\n\n"
                    idle_ticks = 0
            await asyncio.sleep(SSE_INTERVAL)
    except asyncio.CancelledError:
        # 客户端断开，正常退出
        return
    finally:
        # 无论怎么退(客户端断 / 异常),释放计数,不让后续合法 connect 误判限流。
        remaining = _progress_stream_counts.get(library_id, 1) - 1
        if remaining <= 0:
            _progress_stream_counts.pop(library_id, None)
        else:
            _progress_stream_counts[library_id] = remaining


@router.get("/library/{library_id}/progress")
async def progress_stream(request: Request, library_id: str) -> StreamingResponse:
    """GET /analysis/library/{id}/progress — SSE progress stream."""
    db = await _db(request)
    if _progress_stream_counts.get(library_id, 0) >= MAX_PROGRESS_SSE_PER_LIBRARY:
        raise HTTPException(
            status_code=429,
            detail=f"Too many progress SSE subscribers (limit {MAX_PROGRESS_SSE_PER_LIBRARY})",
            headers={"Retry-After": "5"},
        )
    return StreamingResponse(
        _progress_stream(request, db, library_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # proxy 级别禁用缓冲
        },
    )
