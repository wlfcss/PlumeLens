# pyright: basic
"""In-memory background worker pool & per-library analysis state management.

Extracted from `engine/api/routes/analysis.py` so `core/lifespan.py`,
`routes/library.py`, and `routes/settings.py` depend strictly downward on
`engine/services/` instead of reverse-importing API route modules.
"""

from __future__ import annotations

import asyncio
import sqlite3
from contextlib import suppress
from datetime import UTC, datetime

import structlog

from engine.core.database import Database
from engine.pipeline.manager import PipelineManager
from engine.services.analyzer import SourceChangedError, StalePhotoInputError, analyze_photo
from engine.services.queue import (
    IllegalTransitionError,
    TaskStatus,
    get_stats,
    get_task_force_rerun,
    mark_failed_with_retry,
    pick_next,
    transition,
)

logger = structlog.stdlib.get_logger()

# Per-library worker registry & control locks
_workers: dict[str, asyncio.Task[None]] = {}
_batch_locks: dict[str, asyncio.Lock] = {}


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def get_batch_lock(library_id: str) -> asyncio.Lock:
    """Return the per-library asyncio lock serializing batch/pause/resume/cancel."""
    return _batch_locks.setdefault(library_id, asyncio.Lock())


def get_library_worker(library_id: str) -> asyncio.Task[None] | None:
    """Return the live in-memory worker task for a library, if any."""
    return _workers.get(library_id)


def get_active_worker_count() -> int:
    """Return number of currently running library analysis workers."""
    return sum(1 for task in _workers.values() if not task.done())


async def cancel_library_worker(library_id: str, wait_seconds: float = 5.0) -> bool:
    """Cancel and await one library's in-memory worker before deleting the library."""
    task = _workers.get(library_id)
    if task is None or task.done():
        _workers.pop(library_id, None)
        return True
    task.cancel()
    try:
        await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), timeout=wait_seconds)
    except TimeoutError:
        logger.warning("Timed out waiting for library worker to cancel", library_id=library_id)
        return False
    _workers.pop(library_id, None)
    return True


async def cancel_all_workers(wait_seconds: float = 5.0) -> bool:
    """Cancel all in-memory analysis workers before destructive maintenance or shutdown."""
    tasks = [task for task in _workers.values() if not task.done()]
    for task in tasks:
        task.cancel()
    if tasks:
        try:
            await asyncio.wait_for(
                asyncio.gather(*tasks, return_exceptions=True),
                timeout=wait_seconds,
            )
        except TimeoutError:
            logger.warning("Timed out waiting for analysis workers to cancel")
            for library_id, task in list(_workers.items()):
                if task.done():
                    _workers.pop(library_id, None)
            return False
    _workers.clear()
    return True


def has_active_tasks(stats: dict[str, int]) -> bool:
    return (
        stats.get(TaskStatus.PENDING.value, 0)
        + stats.get(TaskStatus.PROCESSING.value, 0)
        + stats.get(TaskStatus.PAUSED.value, 0)
    ) > 0


async def mark_library_analyzing(db: Database, library_id: str) -> None:
    """Keep library summary/status in sync with the live analysis queue."""
    async with db.transaction():
        await db.conn.execute(
            "UPDATE libraries SET status = ? WHERE id = ? AND status NOT IN "
            "('path_missing', 'error')",
            ("analyzing_partial", library_id),
        )


async def mark_library_analysis_idle(db: Database, library_id: str) -> None:
    """Mark analysis as no longer active once no pending/processing/paused tasks remain."""
    async with db.transaction():
        stats = await get_stats(db, library_id)
        if has_active_tasks(stats):
            return

        await db.conn.execute(
            "UPDATE analysis_runs SET desired_state='completed' WHERE library_id=? "
            "AND desired_state='running'",
            (library_id,),
        )
        finished = (
            stats.get(TaskStatus.COMPLETED.value, 0)
            + stats.get(TaskStatus.DEAD.value, 0)
            + stats.get(TaskStatus.CANCELLED.value, 0)
        )
        if finished > 0:
            await db.conn.execute(
                "UPDATE libraries SET status = ?, last_analyzed_at = ? "
                "WHERE id = ? AND status NOT IN ('path_missing', 'error')",
                ("ready", _now_iso(), library_id),
            )
        else:
            await db.conn.execute(
                "UPDATE libraries SET status = ? "
                "WHERE id = ? AND status NOT IN ('path_missing', 'error')",
                ("ready", library_id),
            )


async def run_one_task(
    db: Database,
    pipeline: PipelineManager,
    library_id: str,
    *,
    force_rerun: bool = False,
) -> bool:
    """Pick one task and run it. Returns True if a task was processed, False if queue empty."""
    from engine.core.windows_resources import wait_for_memory

    await wait_for_memory()
    task = None
    for attempt in range(3):
        try:
            task = await pick_next(db, library_id=library_id)
            break
        except sqlite3.OperationalError as exc:
            if attempt == 2:
                raise
            logger.warning(
                "Transient SQLite error in pick_next, retrying",
                library_id=library_id,
                attempt=attempt + 1,
                error=str(exc),
            )
            await asyncio.sleep(0.25)
    if task is None:
        return False
    try:
        await analyze_photo(
            db,
            pipeline,
            task.photo_id,
            force_rerun=force_rerun or await get_task_force_rerun(db, task),
            expected_input_revision=task.input_revision,
        )
        await transition(db, task.id, TaskStatus.COMPLETED)
        return True
    except SourceChangedError as e:
        logger.warning(
            "Task failed due to unscanned source change",
            task_id=task.id,
            photo_id=task.photo_id,
            error=str(e),
        )
        try:
            await mark_failed_with_retry(db, task.id, str(e))
        except Exception:
            with suppress(IllegalTransitionError):
                await transition(db, task.id, TaskStatus.CANCELLED)
        return True
    except StalePhotoInputError as e:
        logger.info(
            "Task superseded by input change",
            task_id=task.id,
            photo_id=task.photo_id,
            reason=str(e),
        )
        with suppress(IllegalTransitionError):
            await transition(db, task.id, TaskStatus.CANCELLED)
        return True
    except IllegalTransitionError:
        logger.exception("Illegal transition in worker", task_id=task.id)
        return True
    except Exception as e:
        logger.warning(
            "Task failed",
            task_id=task.id,
            photo_id=task.photo_id,
            error=str(e),
        )
        try:
            await mark_failed_with_retry(db, task.id, str(e))
        except Exception:
            logger.exception(
                "mark_failed_with_retry failed — falling back to CANCELLED",
                task_id=task.id,
                photo_id=task.photo_id,
            )
            try:
                await transition(db, task.id, TaskStatus.CANCELLED)
            except Exception:
                logger.exception(
                    "CRITICAL: cannot mark task CANCELLED either, task is stuck",
                    task_id=task.id,
                )
        return True


async def _drain_queue(
    db: Database,
    pipeline: PipelineManager,
    library_id: str,
    concurrency: int,
    *,
    force_rerun: bool = False,
) -> None:
    """Run pending tasks for `library_id` until none remain."""

    async def worker() -> None:
        while True:
            did_work = await run_one_task(db, pipeline, library_id, force_rerun=force_rerun)
            if not did_work:
                return

    try:
        await asyncio.gather(*[worker() for _ in range(concurrency)])
    finally:
        with suppress(RuntimeError):
            await mark_library_analysis_idle(db, library_id)


def start_library_worker(
    db: Database,
    pipeline: PipelineManager,
    library_id: str,
    concurrency: int,
    *,
    force_rerun: bool = False,
) -> None:
    """Start or reuse the in-memory worker that drains one library queue."""
    existing = _workers.get(library_id)
    if existing is not None:
        if not existing.done():
            return
        _workers.pop(library_id, None)
    _workers[library_id] = asyncio.create_task(
        _drain_queue(db, pipeline, library_id, concurrency, force_rerun=force_rerun),
    )
