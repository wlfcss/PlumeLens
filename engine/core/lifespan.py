"""FastAPI application lifespan management."""

import asyncio
import sys
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI

from engine.core.config import settings
from engine.core.database import Database
from engine.core.logging import setup_logging
from engine.pipeline.manager import PipelineManager
from engine.services.queue import recover_on_startup
from engine.services.scene_grouper import regroup_library
from engine.services.thumbnail import generate_library_thumbnails

logger = structlog.stdlib.get_logger()


async def _resume_pending_workers(app: FastAPI, db: Database) -> None:
    """启动后扫所有 library 的 pending tasks，自动拉起 worker 续跑。

    解决断点续跑：用户上次分析没跑完就关闭应用 / 应用 crash 重启，db 里
    还有 pending（甚至 processing 残留）的 task。recover_on_startup 已
    把 processing 重置回 pending，但 worker 是 in-memory，重启后空了
    没人消费 pending → 永远卡住。这里在 pipeline ready 后扫一遍，给每
    个有 pending tasks 的 library 起一个 _drain_queue 协程。
    """
    pipeline = getattr(app.state, "pipeline", None)
    if pipeline is None or not pipeline.is_ready:
        await logger.ainfo("Skipping queue resume: pipeline not ready")
        return

    # 延迟 import 避免循环依赖（analysis route 也 import services）
    from engine.api.routes.analysis import _drain_queue, _workers
    from engine.core.config import settings

    async with db.conn.execute(
        "SELECT library_id, COUNT(*) AS n FROM task_queue "
        "WHERE status = 'pending' GROUP BY library_id",
    ) as cur:
        rows = await cur.fetchall()
    for row in rows:
        library_id = str(row["library_id"])
        pending_count = int(row["n"])
        if library_id in _workers and not _workers[library_id].done():
            continue  # 已有 worker 在跑
        _workers[library_id] = asyncio.create_task(
            _drain_queue(db, pipeline, library_id, settings.analysis_concurrency),
        )
        await logger.ainfo(
            "Resumed pending queue worker",
            library_id=library_id,
            pending=pending_count,
        )


async def _refresh_all_thumbnails(db: Database) -> None:
    """启动后扫所有 library：补缩略图 + 补缺失的 scene_id。"""
    cache_root = settings.data_dir / "cache" / "thumbnails"
    try:
        async with db.conn.execute("SELECT id FROM libraries") as cur:
            rows = await cur.fetchall()
        for row in rows:
            library_id = str(row["id"])
            try:
                # Step 1: thumbnails (可能 rebuild 旧缺失文件)
                report = await generate_library_thumbnails(db, library_id, cache_root)
                if report.get("built", 0) > 0:
                    await logger.ainfo(
                        "Startup thumbnail refresh built missing",
                        library_id=library_id,
                        **report,
                    )
                # Step 2: 检查 library 内是否有 photo 还没分配 scene_id（之前未跑过场景分组）
                async with db.conn.execute(
                    "SELECT COUNT(*) FROM photos WHERE library_id = ? AND scene_id IS NULL",
                    (library_id,),
                ) as cur2:
                    missing_row = await cur2.fetchone()
                missing = int(missing_row[0]) if missing_row else 0
                if missing > 0:
                    try:
                        scene_report = await regroup_library(db, library_id, cache_root)
                        await logger.ainfo(
                            "Startup scene grouping ran",
                            library_id=library_id,
                            **scene_report,
                        )
                    except Exception:
                        logger.exception(
                            "Startup scene grouping failed",
                            library_id=library_id,
                        )
            except Exception as e:
                logger.warning(
                    "Startup library refresh failed",
                    library_id=library_id,
                    error=str(e),
                )
    except Exception as e:
        logger.warning("Startup library refresh aborted", error=str(e))


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None]:
    # Startup
    setup_logging(log_level=settings.log_level)

    # Ensure data directory exists
    settings.data_dir.mkdir(parents=True, exist_ok=True)

    await logger.ainfo("PlumeLens Engine starting", data_dir=str(settings.data_dir))

    # Open SQLite database (WAL + schema migration)
    db = Database(settings.data_dir / "plumelens.db")
    await db.connect()
    app.state.db = db

    # Load ONNX pipeline
    pipeline = PipelineManager(settings)
    await pipeline.initialize()
    app.state.pipeline = pipeline

    # 断点续跑：把崩溃前残留的 processing 重置为 pending（不计 attempts）
    recovered = await recover_on_startup(db)
    if recovered > 0:
        await logger.ainfo("Reset stale processing tasks", count=recovered)

    # 自动拉起 worker 消费 pending tasks（用户上次没跑完的）
    await _resume_pending_workers(app, db)

    # Background：扫所有 library 补磁盘上丢失的缩略图（重装应用 / 缓存清理后保证 UI 能看到照片）
    refresh_task = asyncio.create_task(_refresh_all_thumbnails(db))

    # Print ready signal for Electron process manager to parse
    print("PLUMELENS_READY", file=sys.stderr, flush=True)

    yield

    # Shutdown
    refresh_task.cancel()
    import contextlib
    with contextlib.suppress(asyncio.CancelledError, Exception):
        await refresh_task
    app.state.pipeline.close()
    await app.state.db.close()
    await logger.ainfo("PlumeLens Engine shutting down")
