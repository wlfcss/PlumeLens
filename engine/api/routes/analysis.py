# pyright: basic
"""Analysis endpoints (single + batch + SSE progress)."""

from __future__ import annotations

import asyncio
import json

import structlog
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from engine.api.schemas.analysis import (
    AnalysisBatchRequest,
    AnalysisBatchResponse,
    AnalysisProgressEvent,
    QueueStats,
    TaskRow,
)
from engine.core.database import Database
from engine.services.analyzer import analyze_photo
from engine.services.queue import (
    IllegalTransitionError,
    TaskStatus,
    cancel_library,
    enqueue_library,
    get_stats,
    list_tasks,
    mark_failed_with_retry,
    pause_library,
    pick_next,
    resume_library,
    transition,
)

logger = structlog.stdlib.get_logger()

router = APIRouter(prefix="/analysis", tags=["analysis"])

# 同时最多处理多少个 task。SQLite 是单写，worker 并发超过 1 会在 DB 写入上竞争，
# ONNX 推理已经靠 asyncio.to_thread 并行化，故这里用 1 即可，够简单够稳。
DEFAULT_CONCURRENCY = 1

# SSE 进度推送轮询间隔（秒）
SSE_INTERVAL = 1.0

# 单个 library 的 worker 状态（并发分析 + 取消标志）
_workers: dict[str, asyncio.Task] = {}


async def _db(request: Request) -> Database:
    db = getattr(request.app.state, "db", None)
    if db is None:
        raise HTTPException(status_code=503, detail="Database not initialized")
    return db


async def _pipeline(request: Request):
    pipeline = getattr(request.app.state, "pipeline", None)
    if pipeline is None:
        raise HTTPException(status_code=503, detail="Pipeline not initialized")
    if not pipeline.is_ready:
        raise HTTPException(
            status_code=503,
            detail="Pipeline not ready (core models not loaded)",
        )
    return pipeline


async def _run_one_task(db: Database, pipeline, library_id: str) -> bool:
    """Pick one task and run it. Returns True if a task was processed, False if queue empty."""
    task = await pick_next(db, library_id=library_id)
    if task is None:
        return False
    try:
        await analyze_photo(db, pipeline, task.photo_id)
        await transition(db, task.id, TaskStatus.COMPLETED)
        return True
    except IllegalTransitionError:
        logger.exception("Illegal transition in worker", task_id=task.id)
        return True
    except Exception as e:
        logger.warning(
            "Task failed",
            task_id=task.id, photo_id=task.photo_id, error=str(e),
        )
        try:
            await mark_failed_with_retry(db, task.id, str(e))
        except Exception:
            logger.exception("mark_failed_with_retry failed")
        return True


async def _drain_queue(db: Database, pipeline, library_id: str, concurrency: int) -> None:
    """Run pending tasks for `library_id` until none remain.

    Each worker coroutine loops picking next task until pick_next returns None.
    """
    async def worker() -> None:
        while True:
            did_work = await _run_one_task(db, pipeline, library_id)
            if not did_work:
                return
    await asyncio.gather(*[worker() for _ in range(concurrency)])


@router.post("/batch", response_model=AnalysisBatchResponse)
async def start_batch(
    request: Request, body: AnalysisBatchRequest,
) -> AnalysisBatchResponse:
    """POST /analysis/batch — enqueue all photos in library + spawn worker."""
    db = await _db(request)
    pipeline = await _pipeline(request)

    # 如果 force_rerun，先把已有 active 的该 library 的结果 invalidate
    # （MVP 策略：仍然重新入队，analyze_photo 的 force_rerun 参数由每个 task 决定；
    # 为简化，这里让每次 batch 入队时用 pipeline_version + cache 行为自然处理）
    inserted = await enqueue_library(db, body.library_id)

    # Kick off drain worker（不阻塞返回）
    if body.library_id not in _workers or _workers[body.library_id].done():
        _workers[body.library_id] = asyncio.create_task(
            _drain_queue(db, pipeline, body.library_id, DEFAULT_CONCURRENCY),
        )

    stats = await get_stats(db, body.library_id)
    return AnalysisBatchResponse(
        library_id=body.library_id, enqueued=inserted, stats=stats,
    )


@router.post("/library/{library_id}/pause", response_model=QueueStats)
async def pause(request: Request, library_id: str) -> QueueStats:
    db = await _db(request)
    await pause_library(db, library_id)
    return QueueStats(library_id=library_id, stats=await get_stats(db, library_id))


@router.post("/library/{library_id}/resume", response_model=QueueStats)
async def resume(request: Request, library_id: str) -> QueueStats:
    db = await _db(request)
    pipeline = await _pipeline(request)
    await resume_library(db, library_id)
    # 重启 drain worker
    if library_id not in _workers or _workers[library_id].done():
        _workers[library_id] = asyncio.create_task(
            _drain_queue(db, pipeline, library_id, DEFAULT_CONCURRENCY),
        )
    return QueueStats(library_id=library_id, stats=await get_stats(db, library_id))


@router.post("/library/{library_id}/cancel", response_model=QueueStats)
async def cancel(request: Request, library_id: str) -> QueueStats:
    db = await _db(request)
    await cancel_library(db, library_id)
    return QueueStats(library_id=library_id, stats=await get_stats(db, library_id))


@router.get("/library/{library_id}/stats", response_model=QueueStats)
async def stats(request: Request, library_id: str) -> QueueStats:
    db = await _db(request)
    return QueueStats(library_id=library_id, stats=await get_stats(db, library_id))


@router.get("/library/{library_id}/tasks", response_model=list[TaskRow])
async def library_tasks(
    request: Request,
    library_id: str,
    status: str | None = None,
    limit: int = 200,
) -> list[TaskRow]:
    """GET /analysis/library/{id}/tasks — list tasks filtered by status."""
    db = await _db(request)
    status_enum = TaskStatus(status) if status else None
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


async def _progress_stream(db: Database, library_id: str):
    """Generator yielding SSE `data: ...` lines.

    推送策略：每 SSE_INTERVAL 秒一次状态快照；两次相邻状态相同时不重发（节省流量）。
    """
    last_payload: str | None = None
    try:
        while True:
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
            )
            payload = event.model_dump_json()
            if payload != last_payload:
                yield f"data: {payload}\n\n"
                last_payload = payload
            # 若没有在流转的任务，额外发一次"done"后退出
            if processing == 0 and pending == 0:
                yield f"event: done\ndata: {json.dumps({'library_id': library_id})}\n\n"
                return
            await asyncio.sleep(SSE_INTERVAL)
    except asyncio.CancelledError:
        # 客户端断开，正常退出
        return


@router.get("/library/{library_id}/progress")
async def progress_stream(request: Request, library_id: str) -> StreamingResponse:
    """GET /analysis/library/{id}/progress — SSE progress stream."""
    db = await _db(request)
    return StreamingResponse(
        _progress_stream(db, library_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # proxy 级别禁用缓冲
        },
    )
