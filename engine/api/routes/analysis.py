# pyright: basic
"""Analysis endpoints (single + batch + SSE progress)."""

from __future__ import annotations

import asyncio

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
from engine.core.config import settings
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
from engine.services.scanner import backfill_hashes

logger = structlog.stdlib.get_logger()

router = APIRouter(prefix="/analysis", tags=["analysis"])

# 并发数从 settings.analysis_concurrency 读取（默认 2，见 engine/core/config.py）。
# 每个 task 内 ONNX 推理在 thread pool 释放 GIL，多 worker = 多张图并行推理。
# CoreML EP 多 session 在 ANE/GPU 上能共享资源。SQLite WAL 模式允许并发读 + 单写，
# cache.store 写入有 busy_timeout 5s 兜底。

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
            # mark_failed_with_retry 自身异常（如 DB 写入失败）→ task 卡在 PROCESSING
            # 永远出不来。直接 transition 到 CANCELLED（PROCESSING 合法转移之一）作为
            # 最后兜底，避免阻塞队列 + 让 lifespan recover_on_startup 能重置它。
            logger.exception(
                "mark_failed_with_retry failed — falling back to CANCELLED",
                task_id=task.id, photo_id=task.photo_id,
            )
            try:
                await transition(db, task.id, TaskStatus.CANCELLED)
            except Exception:
                logger.exception(
                    "CRITICAL: cannot mark task CANCELLED either, task is stuck",
                    task_id=task.id,
                )
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
    """POST /analysis/batch — enqueue all photos in library + spawn worker.

    安全网：先同步补齐 SHA-256（如果 import 后台任务还没跑完），再入队。
    enqueue_library 只会取 file_hash IS NOT NULL 的照片，所以这一步保证用户
    手动触发分析时不会因哈希未完成而 enqueued=0。
    """
    db = await _db(request)
    pipeline = await _pipeline(request)

    # 同步补哈希（幂等，已有哈希的 photo 直接跳过；空集时秒级返回）
    await backfill_hashes(db, body.library_id)

    # 传 pipeline_version 进 enqueue → 当前版本已分析过的 photo 跳过（去重）。
    # 之前 bug：用户多次点开始分析（或 lifespan resume + 手动点）会让同一 photo
    # 累积多个 task_queue 行 → 783 张照片产生 3173 个 task = 4× 膨胀。
    # 现在按 (file_hash, pipeline_version) 单一来源去重。
    inserted = await enqueue_library(
        db, body.library_id,
        current_pipeline_version=pipeline.pipeline_version,
    )

    # Kick off drain worker（不阻塞返回）
    if body.library_id not in _workers or _workers[body.library_id].done():
        _workers[body.library_id] = asyncio.create_task(
            _drain_queue(db, pipeline, body.library_id, settings.analysis_concurrency),
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
            _drain_queue(db, pipeline, library_id, settings.analysis_concurrency),
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
    **不会主动关闭** — 长连接保持到客户端断开。这样用户在 idle 状态下点击「开始
    分析」后，新生成的 pending tasks 立即能被同一个 SSE 流推送出去。

    历史 bug：之前发完 `event: done` 就 return，导致前端 EventSource 关闭；
    用户点击「开始分析」后 task 入队但前端永远看不到（SSE 已死），button 卡在
    "开始分析"。
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
            # idle 状态（pending=0 且 processing=0）也保持流，不再主动 done。
            # 用户随时可能点「开始分析」让 pending 变非 0；这条流要能马上推。
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
