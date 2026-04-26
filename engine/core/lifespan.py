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
from engine.services.thumbnail import generate_library_thumbnails

logger = structlog.stdlib.get_logger()


async def _refresh_all_thumbnails(db: Database) -> None:
    """启动后扫所有 library，补磁盘上丢失的缩略图。

    场景：用户重装/迁移应用，db 里 thumb_grid 路径都在但磁盘 cache 文件丢了。
    generate_library_thumbnails 内部会检查文件存在性，已存在的跳过，缺失的重建。
    """
    cache_root = settings.data_dir / "cache" / "thumbnails"
    try:
        async with db.conn.execute("SELECT id FROM libraries") as cur:
            rows = await cur.fetchall()
        for row in rows:
            library_id = str(row["id"])
            try:
                report = await generate_library_thumbnails(db, library_id, cache_root)
                if report.get("built", 0) > 0:
                    await logger.ainfo(
                        "Startup thumbnail refresh built missing",
                        library_id=library_id,
                        **report,
                    )
            except Exception as e:
                logger.warning(
                    "Startup thumbnail refresh failed",
                    library_id=library_id,
                    error=str(e),
                )
    except Exception as e:
        logger.warning("Startup thumbnail refresh aborted", error=str(e))


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
    try:
        await refresh_task
    except (asyncio.CancelledError, Exception):
        pass
    app.state.pipeline.close()
    await app.state.db.close()
    await logger.ainfo("PlumeLens Engine shutting down")
