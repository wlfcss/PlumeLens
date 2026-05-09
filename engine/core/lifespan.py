"""FastAPI application lifespan management."""

import asyncio
import inspect
import os
import sys
from collections.abc import AsyncGenerator
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import Any

import structlog
from fastapi import FastAPI

from engine.core.config import settings
from engine.core.database import Database
from engine.core.imaging import configure_pil_decompression_bomb_guard
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


async def _backfill_locations(db: Database) -> None:
    """启动后台:把所有有 GPS 但 country IS NULL 的照片调 reverse_geocoding 写回。
    幂等 — 已填充的跳过。reverse_geocoding 走 services/geocoder 的 provider chain,
    在线失败也会 fallback offline。本任务可能耗时几分钟到几十分钟(取决于 amap
    qps + 总数),整个 backfill 期间应用功能不受影响,羽迹页面会渐进显示数据。

    永久 retry-loop:外层异常(db locked / provider chain 全跪等)不应让整个回填
    任务静默死亡。失败后 sleep + 重试,backoff 60s→300s,最长 5 分钟;CancelledError
    照例 propagate 让 lifespan shutdown 干净退出。
    """
    from engine.services.location_backfill import backfill_all_libraries

    await asyncio.sleep(2)  # 等 lifespan 其他启动步骤先跑完
    backoff = 60
    while True:
        try:
            await backfill_all_libraries(db)
            return  # 成功完成 → 退出 task
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception(
                "Location backfill task failed, will retry",
                retry_in_sec=backoff,
            )
            try:
                await asyncio.sleep(backoff)
            except asyncio.CancelledError:
                raise
            backoff = min(backoff * 2, 300)  # cap 5 分钟


async def _sweep_stuck_tasks(app: FastAPI, db: Database) -> None:
    """周期性扫 PROCESSING 超时 task → 失败重试,并兜底启动孤儿 PENDING 的 worker。

    对应场景:
    1. 某个 worker 卡死(MPS hang / 死锁) — 整个进程没崩,单个 task 永远不会完成。
       30s 周期 + 5min 阈值覆盖正常抖动而不误杀。sweeper mark failed → 自动 retry
       回 PENDING(attempts<MAX)或 DEAD(>=MAX)。
    2. **孤儿 pending tasks**:worker pool 因为某个未捕获异常 / 重试逻辑漏洞退出,
       但 task_queue 里仍有 PENDING 行。原 _drain_queue 已经看不到任务退出,没人
       再 pick_next。结果就是进度条卡住到天荒地老(用户实测见过 1664/1668 卡 4 张)。
       每个 sweep 周期顺手扫:有 PENDING 的 library 但 worker registry 里没活跃 task →
       重启 worker 兜底。复用 _resume_pending_workers 同款 query。
    """
    from engine.api.routes.analysis import get_library_worker, start_library_worker

    sweep_interval_sec = 15

    while True:
        try:
            await asyncio.sleep(sweep_interval_sec)
        except asyncio.CancelledError:
            raise

        # ---- step 1: stuck PROCESSING → FAILED → PENDING/DEAD ----
        # 单独 try/except,DB 异常不会掐断后续 step。
        try:
            await mark_stuck_tasks_failed(db)
        except Exception:
            logger.exception("Sweeper step1 (mark_stuck_tasks_failed) failed")

        pipeline = getattr(app.state, "pipeline", None)
        if not isinstance(pipeline, PipelineManager) or not pipeline.is_ready:
            continue

        # ---- step 2: 死 worker + PROCESSING 行 → 立即重置 PENDING ----
        # 真实场景下"5.5 min 黑洞"的正解:worker task 因异常 done(),其名下的
        # task_queue 行还停在 PROCESSING,普通的 STUCK_THRESHOLD 路径要等 5 min
        # 才会动它。死 worker 配 PROCESSING 行可以判定为孤儿并立刻回收 — 不用等
        # 5 min 阈值,下面 step3 的 worker 重启接管。
        try:
            async with db.conn.execute(
                "SELECT library_id, COUNT(*) AS n FROM task_queue "
                "WHERE status = 'processing' GROUP BY library_id",
            ) as cur:
                processing_rows = await cur.fetchall()
            for row in processing_rows:
                library_id = str(row["library_id"])
                worker = get_library_worker(library_id)
                if worker is not None and not worker.done():
                    continue
                count = int(row["n"])
                await db.conn.execute(
                    "UPDATE task_queue SET status='pending', started_at=NULL "
                    "WHERE library_id=? AND status='processing'",
                    (library_id,),
                )
                await db.conn.commit()
                await logger.awarning(
                    "Sweeper: dead worker with PROCESSING tasks — fast-reset to pending",
                    library_id=library_id,
                    count=count,
                )
        except Exception:
            logger.exception("Sweeper step2 (dead worker fast-reset) failed")

        # ---- step 3: 孤儿 PENDING (含 step 2 刚刚重置的) → 重启 worker ----
        try:
            async with db.conn.execute(
                "SELECT library_id, COUNT(*) AS n FROM task_queue "
                "WHERE status = 'pending' GROUP BY library_id",
            ) as cur:
                rows = await cur.fetchall()
            for row in rows:
                library_id = str(row["library_id"])
                worker = get_library_worker(library_id)
                if worker is not None and not worker.done():
                    continue
                await logger.awarning(
                    "Reviving worker for orphaned PENDING tasks",
                    library_id=library_id,
                    pending=int(row["n"]),
                )
                start_library_worker(db, pipeline, library_id, settings.analysis_concurrency)
        except Exception:
            logger.exception("Sweeper step3 (orphan PENDING revival) failed")


async def _refresh_all_thumbnails(db: Database) -> None:
    """启动后扫所有 library：补缩略图 + 补 scene_id + 补缺失 EXIF（曝光参数）。

    顶层 SELECT 失败时(db locked / 进程被 SIGTERM 中途等)以前直接 return,所有
    library 的缩略图/scene/EXIF 补齐永久不再发生 — 用户清过 cache 目录后只能等
    下次启动。改成 3 次 retry + 短 backoff,扛过瞬态错误。内层 per-library 异常
    依旧吞掉跳过(单个库挂不影响其他)。
    """
    cache_root = thumbnail_cache_root(settings.data_dir)
    # 延迟 import 避免循环依赖
    from engine.services.scanner import refresh_library_exif

    rows = None
    for attempt in range(3):
        try:
            async with db.conn.execute("SELECT id FROM libraries") as cur:
                rows = await cur.fetchall()
            break
        except Exception as e:
            logger.warning(
                "Startup library list fetch failed, will retry",
                attempt=attempt + 1,
                error=str(e),
            )
            try:
                await asyncio.sleep(2**attempt)  # 1s/2s/4s
            except asyncio.CancelledError:
                raise
    if rows is None:
        logger.warning("Startup library refresh aborted after 3 retries")
        return

    try:
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

    场景:
    - v0.1.0 时代 process-manager bug 留下了孤儿 engine(kill 不干净 + freeze_support
      之前 spawn 的 helper 进程)
    - 用户从 Activity Monitor 直接强杀 Electron,子进程 detached 后变孤儿
    - dmg 升级时老进程没被 SIGTERM 干掉

    旧 engine 进程占着 ~/.plumelens 数据库 + 监听其他端口 + 吃 RAM。新启动一份没
    冲突(uvicorn 用 port 0 自分配),但用户机器上累积多个进程吃几 GB RAM。

    PLUMELENS_SKIP_ORPHAN_KILL=1 旁路:e2e 测试场景下用户的 PlumeLens 可能正在
    跑,e2e 自己的 engine 通过 --user-data-dir 隔离数据但 pgrep -f 看到的是同
    binary 名 → 会误杀用户 app 的 engine。e2e setup 时设此 env 跳过即可。

    Returns: 杀掉的进程数。
    """
    if os.environ.get("PLUMELENS_SKIP_ORPHAN_KILL") == "1":
        return 0

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

    # 把 PIL 的 decompression bomb 上限提到 256 MP — 既能解码鸟摄高分辨率
    # (Sony α7R V 61 MP)又挡住 zlib bomb 类恶意图(几亿像素 PNG/TIFF 直接
    # OOM)。Image.open / load_image / 缩略图 / 扫描器全链路都依赖这个全局开关。
    configure_pil_decompression_bomb_guard()

    # 启动预清理：杀掉所有除自己外的 plumelens-engine 孤儿进程，避免它们
    # 继续吃 RAM / 持有 db lock / 抢 MPS 资源。
    orphans_killed = _kill_orphan_engines(my_pid=os.getpid())
    if orphans_killed > 0:
        await logger.awarning(
            "Killed orphan plumelens-engine processes at startup",
            count=orphans_killed,
        )

    await logger.ainfo("PlumeLens Engine starting", data_dir=str(settings.data_dir))

    worker_threads = max(1, int(settings.worker_threads))
    thread_pool = ThreadPoolExecutor(
        max_workers=worker_threads,
        thread_name_prefix="plumelens-worker",
    )
    asyncio.get_running_loop().set_default_executor(thread_pool)
    app.state.thread_pool = thread_pool
    await logger.ainfo("Configured default thread pool", max_workers=worker_threads)

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
    sweep_task = asyncio.create_task(_sweep_stuck_tasks(app, db))

    # Background：reverse geocoding 全库 backfill(GPS → 省市区地名),
    # 羽迹三级地图聚合用。一次性后台扫,完成后该 library 所有有 GPS 的照片都填充好。
    geocode_task = asyncio.create_task(_backfill_locations(db))

    # Print ready signal for Electron process manager to parse
    print("PLUMELENS_READY", file=sys.stderr, flush=True)

    yield

    async def _await_cancelled_task(task: asyncio.Task[Any], name: str) -> None:
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception:
            await logger.aexception("Background task failed during shutdown", task=name)

    # Shutdown
    refresh_task.cancel()
    sweep_task.cancel()
    geocode_task.cancel()

    await _await_cancelled_task(refresh_task, "refresh_all_thumbnails")
    await _await_cancelled_task(sweep_task, "sweep_stuck_tasks")
    await _await_cancelled_task(geocode_task, "backfill_locations")

    close_pipeline = getattr(app.state.pipeline, "close", None)
    if callable(close_pipeline):
        close_result = close_pipeline()
        if inspect.isawaitable(close_result):
            await close_result
    await app.state.db.close()
    thread_pool.shutdown(wait=False, cancel_futures=True)
    await logger.ainfo("PlumeLens Engine shutting down")
