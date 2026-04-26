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
from engine.services.scene_grouper import regroup_library
from engine.services.thumbnail import generate_library_thumbnails

logger = structlog.stdlib.get_logger()


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
