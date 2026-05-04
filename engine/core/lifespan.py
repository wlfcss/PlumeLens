"""FastAPI application lifespan management."""

import asyncio
import os
import sys
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI

from engine.core.config import settings
from engine.core.database import Database
from engine.core.logging import setup_logging
from engine.pipeline.manager import PipelineManager
from engine.services.queue import mark_stuck_tasks_failed, recover_on_startup
from engine.services.scene_grouper import regroup_library
from engine.services.thumbnail import generate_library_thumbnails, thumbnail_cache_root

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
    if not isinstance(pipeline, PipelineManager) or not pipeline.is_ready:
        await logger.ainfo("Skipping queue resume: pipeline not ready")
        return

    # 延迟 import 避免循环依赖（analysis route 也 import services）
    from engine.api.routes.analysis import start_library_worker
    from engine.core.config import settings

    async with db.conn.execute(
        "SELECT library_id, COUNT(*) AS n FROM task_queue "
        "WHERE status = 'pending' GROUP BY library_id",
    ) as cur:
        rows = await cur.fetchall()
    for row in rows:
        library_id = str(row["library_id"])
        pending_count = int(row["n"])
        await db.conn.execute(
            "UPDATE libraries SET status = 'analyzing_partial' "
            "WHERE id = ? AND status NOT IN ('path_missing', 'error')",
            (library_id,),
        )
        await db.conn.commit()
        start_library_worker(db, pipeline, library_id, settings.analysis_concurrency)
        await logger.ainfo(
            "Resumed pending queue worker",
            library_id=library_id,
            pending=pending_count,
        )


async def _sweep_stuck_tasks(db: Database) -> None:
    """周期性扫 PROCESSING 超时 task,强制 fail 让队列推进。

    对应场景:某个 worker 卡死(MPS hang / 死锁) — 整个进程没崩,但单个 task 永远
    不会完成。前端看进度条不动,以为是后端崩了。30s 周期 + 5min 阈值能覆盖正常
    抖动而不误杀。
    """
    while True:
        try:
            await asyncio.sleep(30)
            await mark_stuck_tasks_failed(db)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Stuck task sweeper iteration failed")


async def _refresh_all_thumbnails(db: Database) -> None:
    """启动后扫所有 library：补缩略图 + 补 scene_id + 补缺失 EXIF（曝光参数）。"""
    cache_root = thumbnail_cache_root(settings.data_dir)
    # 延迟 import 避免循环依赖
    from engine.services.scanner import refresh_library_exif

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
                # Step 3: 补缺失/旧 EXIF（5deab5f 之前老扫描遗漏的 ExifIFD 字段，
                # 比如 ExposureTime/FNumber/ISO/FocalLength/LensModel）。
                # 函数内会判断是否 incomplete，齐了就 skip 不重抽。
                try:
                    exif_report = await refresh_library_exif(db, library_id)
                    if exif_report.get("refreshed", 0) > 0:
                        await logger.ainfo(
                            "Startup EXIF refresh ran",
                            library_id=library_id,
                            **exif_report,
                        )
                except Exception:
                    logger.exception(
                        "Startup EXIF refresh failed",
                        library_id=library_id,
                    )
                # Step 4: 补 v6 → v7 升级后老库的 companion_*(JPG/RAW pair 同伴信息)。
                # 轻量,只 stat 不读 EXIF。已有 companion 字段的行不动。
                try:
                    from engine.services.scanner import backfill_companion_for_library
                    await backfill_companion_for_library(db, library_id)
                except Exception:
                    logger.exception(
                        "Startup companion backfill failed",
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


def _kill_orphan_engines(my_pid: int) -> int:
    """启动时杀掉除自己外的所有 plumelens-engine 进程。

    场景：
    - v0.1.0 时代 process-manager bug 留下了孤儿 engine（kill 不干净 + freeze_support
      之前 spawn 的 helper 进程）
    - 用户从 Activity Monitor 直接强杀 Electron，子进程 detached 后变孤儿
    - dmg 升级时老进程没被 SIGTERM 干掉

    旧 engine 进程占着 ~/.plumelens 数据库 + 监听其他端口 + 吃 RAM。新启动一份没
    冲突（uvicorn 用 port 0 自分配），但用户机器上累积多个进程吃几 GB RAM。

    Returns: 杀掉的进程数。
    """
    import signal
    import subprocess

    try:
        # 找所有 plumelens-engine 进程（注意：argv[0] 在 frozen binary 是
        # /.../plumelens-engine/plumelens-engine 路径）
        result = subprocess.run(
            ["pgrep", "-f", "plumelens-engine"],
            capture_output=True,
            text=True,
            timeout=2,
        )
        if result.returncode != 0:
            return 0
        pids = [
            int(p)
            for p in result.stdout.strip().split()
            if p.strip().isdigit() and int(p) != my_pid
        ]
        killed = 0
        for pid in pids:
            try:
                # 先温和 SIGTERM；这里不等，启动流程不该被孤儿阻塞
                os.kill(pid, signal.SIGTERM)
                killed += 1
            except ProcessLookupError:
                pass  # 已退出
            except PermissionError:
                pass  # 不是同一用户的进程
        return killed
    except Exception:
        return 0


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None]:
    # Startup — 提前确保 data_dir 存在，再 setup_logging 让文件日志落到 data_dir/logs/
    # 这样所有后续步骤（孤儿清理、模型加载、崩溃 traceback）都能进 engine.jsonl 文件。
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    setup_logging(log_level=settings.log_level, logs_dir=settings.data_dir / "logs")
    await logger.ainfo(
        "Engine logging initialized",
        data_dir=str(settings.data_dir),
        logs_dir=str(settings.data_dir / "logs"),
    )

    # 启动预清理：杀掉所有除自己外的 plumelens-engine 孤儿进程，避免它们
    # 继续吃 RAM / 持有 db lock / 抢 MPS 资源。
    orphans_killed = _kill_orphan_engines(my_pid=os.getpid())
    if orphans_killed > 0:
        await logger.awarning(
            "Killed orphan plumelens-engine processes at startup",
            count=orphans_killed,
        )

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

    # Background：周期性把卡死 (PROCESSING > 5min) 的 task 标记 failed,让队列继续推进
    sweep_task = asyncio.create_task(_sweep_stuck_tasks(db))

    # Print ready signal for Electron process manager to parse
    print("PLUMELENS_READY", file=sys.stderr, flush=True)

    yield

    # Shutdown
    refresh_task.cancel()
    sweep_task.cancel()
    import contextlib

    with contextlib.suppress(asyncio.CancelledError, Exception):
        await refresh_task
    with contextlib.suppress(asyncio.CancelledError, Exception):
        await sweep_task
    app.state.pipeline.close()
    await app.state.db.close()
    await logger.ainfo("PlumeLens Engine shutting down")
