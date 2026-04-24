"""Tests for task_queue service (state machine + recovery)."""

from __future__ import annotations

from pathlib import Path

import pytest
from engine.core.database import Database
from engine.services.queue import (
    MAX_ATTEMPTS,
    IllegalTransitionError,
    TaskStatus,
    cancel_library,
    enqueue_library,
    enqueue_photos,
    get_stats,
    get_task,
    list_tasks,
    mark_failed_with_retry,
    pause_library,
    pick_next,
    recover_on_startup,
    resume_library,
    transition,
)


@pytest.fixture
async def db_with_photos(tmp_path: Path) -> Database:
    """Setup: library + 3 photos (2 with hash, 1 without)."""
    db = Database(tmp_path / "queue_test.db")
    await db.connect()
    await db.conn.execute(
        "INSERT INTO libraries (id, display_name, parent_path, root_path, "
        "created_at, last_opened_at) VALUES ('lib-1', 'X', '/p', '/p/r', "
        "'2026-04-24', '2026-04-24')",
    )
    for i in range(3):
        h = f"hash-{i}" if i < 2 else None
        await db.conn.execute(
            "INSERT INTO photos (id, file_path, file_name, file_size, file_mtime, "
            "file_hash, created_at, library_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (f"photo-{i}", f"/p/{i}.jpg", f"{i}.jpg", 100, "2026-04-24",
             h, "2026-04-24", "lib-1"),
        )
    await db.conn.commit()
    yield db
    await db.close()


class TestEnqueue:
    async def test_enqueue_photos_inserts_pending(
        self, db_with_photos: Database,
    ) -> None:
        db = db_with_photos
        n = await enqueue_photos(db, "lib-1", ["photo-0", "photo-1"])
        assert n == 2

        tasks = await list_tasks(db, library_id="lib-1")
        assert len(tasks) == 2
        assert {t.status for t in tasks} == {TaskStatus.PENDING}

    async def test_enqueue_skips_duplicates(
        self, db_with_photos: Database,
    ) -> None:
        db = db_with_photos
        n1 = await enqueue_photos(db, "lib-1", ["photo-0"])
        n2 = await enqueue_photos(db, "lib-1", ["photo-0", "photo-1"])
        assert n1 == 1
        assert n2 == 1  # 只新增 photo-1

    async def test_enqueue_library_excludes_nohash(
        self, db_with_photos: Database,
    ) -> None:
        # photo-2 没 file_hash，应该跳过
        n = await enqueue_library(db_with_photos, "lib-1")
        assert n == 2


class TestPickNext:
    async def test_pick_pending_marks_processing(
        self, db_with_photos: Database,
    ) -> None:
        db = db_with_photos
        await enqueue_photos(db, "lib-1", ["photo-0"])
        task = await pick_next(db, library_id="lib-1")
        assert task is not None
        assert task.status is TaskStatus.PROCESSING
        assert task.started_at is not None

    async def test_pick_none_when_empty(
        self, db_with_photos: Database,
    ) -> None:
        task = await pick_next(db_with_photos, library_id="lib-1")
        assert task is None

    async def test_priority_ordering(
        self, db_with_photos: Database,
    ) -> None:
        db = db_with_photos
        # 低优先级先入队，高优先级后入队
        await enqueue_photos(db, "lib-1", ["photo-0"], priority=0)
        await enqueue_photos(db, "lib-1", ["photo-1"], priority=10)
        # pick 应先挑高优先级
        task = await pick_next(db)
        assert task is not None
        assert task.photo_id == "photo-1"


class TestTransitions:
    async def _enqueue_one(self, db: Database) -> str:
        await enqueue_photos(db, "lib-1", ["photo-0"])
        tasks = await list_tasks(db, library_id="lib-1")
        return tasks[0].id

    async def test_legal_pending_to_processing(
        self, db_with_photos: Database,
    ) -> None:
        db = db_with_photos
        tid = await self._enqueue_one(db)
        t = await transition(db, tid, TaskStatus.PROCESSING)
        assert t.status is TaskStatus.PROCESSING

    async def test_illegal_pending_to_completed(
        self, db_with_photos: Database,
    ) -> None:
        db = db_with_photos
        tid = await self._enqueue_one(db)
        with pytest.raises(IllegalTransitionError):
            await transition(db, tid, TaskStatus.COMPLETED)

    async def test_completed_is_terminal(
        self, db_with_photos: Database,
    ) -> None:
        db = db_with_photos
        tid = await self._enqueue_one(db)
        await transition(db, tid, TaskStatus.PROCESSING)
        await transition(db, tid, TaskStatus.COMPLETED)
        # 从 completed 不能再转出
        with pytest.raises(IllegalTransitionError):
            await transition(db, tid, TaskStatus.PROCESSING)

    async def test_failed_to_pending_retry(
        self, db_with_photos: Database,
    ) -> None:
        db = db_with_photos
        tid = await self._enqueue_one(db)
        await transition(db, tid, TaskStatus.PROCESSING)
        t = await transition(
            db, tid, TaskStatus.FAILED, error_message="oh no",
        )
        assert t.attempts == 1
        assert t.error_message == "oh no"

        # 重试
        t2 = await transition(db, tid, TaskStatus.PENDING)
        assert t2.status is TaskStatus.PENDING
        assert t2.attempts == 1  # 不重置

    async def test_paused_resume_cycle(
        self, db_with_photos: Database,
    ) -> None:
        db = db_with_photos
        tid = await self._enqueue_one(db)
        await transition(db, tid, TaskStatus.PROCESSING)
        paused = await transition(db, tid, TaskStatus.PAUSED)
        assert paused.status is TaskStatus.PAUSED
        resumed = await transition(db, tid, TaskStatus.PENDING)
        assert resumed.status is TaskStatus.PENDING

    async def test_mark_failed_with_retry_auto_dead(
        self, db_with_photos: Database,
    ) -> None:
        db = db_with_photos
        tid = await self._enqueue_one(db)
        # 把 attempts 推到 MAX_ATTEMPTS
        for _ in range(MAX_ATTEMPTS):
            await transition(db, tid, TaskStatus.PROCESSING)
            await mark_failed_with_retry(db, tid, "err")
        final = await get_task(db, tid)
        assert final is not None
        assert final.status is TaskStatus.DEAD
        assert final.attempts == MAX_ATTEMPTS


class TestRecovery:
    async def test_recover_processing_to_pending(
        self, db_with_photos: Database,
    ) -> None:
        db = db_with_photos
        # 手工插入 2 个 PROCESSING + 1 个 COMPLETED
        await enqueue_photos(db, "lib-1", ["photo-0", "photo-1"])
        tasks = await list_tasks(db)
        t1, t2 = tasks[0].id, tasks[1].id
        await transition(db, t1, TaskStatus.PROCESSING)
        await transition(db, t2, TaskStatus.PROCESSING)

        recovered = await recover_on_startup(db)
        assert recovered == 2

        # 都应恢复为 pending
        for tid in (t1, t2):
            t = await get_task(db, tid)
            assert t is not None
            assert t.status is TaskStatus.PENDING
            assert t.started_at is None


class TestBatchOps:
    async def test_pause_resume_library(
        self, db_with_photos: Database,
    ) -> None:
        db = db_with_photos
        await enqueue_photos(db, "lib-1", ["photo-0", "photo-1"])

        paused = await pause_library(db, "lib-1")
        assert paused == 2
        stats = await get_stats(db, "lib-1")
        assert stats["paused"] == 2

        resumed = await resume_library(db, "lib-1")
        assert resumed == 2
        stats = await get_stats(db, "lib-1")
        assert stats["pending"] == 2

    async def test_cancel_library(
        self, db_with_photos: Database,
    ) -> None:
        db = db_with_photos
        await enqueue_photos(db, "lib-1", ["photo-0", "photo-1"])
        cancelled = await cancel_library(db, "lib-1")
        assert cancelled == 2

        stats = await get_stats(db, "lib-1")
        assert stats["cancelled"] == 2
        assert stats["pending"] == 0


class TestStats:
    async def test_stats_returns_all_status_keys(
        self, db_with_photos: Database,
    ) -> None:
        stats = await get_stats(db_with_photos, "lib-1")
        # 无任务时所有状态都是 0
        for status in TaskStatus:
            assert stats[status.value] == 0
