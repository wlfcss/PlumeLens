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
    mark_stuck_tasks_failed,
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
            (f"photo-{i}", f"/p/{i}.jpg", f"{i}.jpg", 100, "2026-04-24", h, "2026-04-24", "lib-1"),
        )
    await db.conn.commit()
    yield db
    await db.close()


class TestEnqueue:
    async def test_enqueue_photos_inserts_pending(
        self,
        db_with_photos: Database,
    ) -> None:
        db = db_with_photos
        n = await enqueue_photos(db, "lib-1", ["photo-0", "photo-1"])
        assert n == 2

        tasks = await list_tasks(db, library_id="lib-1")
        assert len(tasks) == 2
        assert {t.status for t in tasks} == {TaskStatus.PENDING}

    async def test_enqueue_skips_duplicates(
        self,
        db_with_photos: Database,
    ) -> None:
        db = db_with_photos
        n1 = await enqueue_photos(db, "lib-1", ["photo-0"])
        n2 = await enqueue_photos(db, "lib-1", ["photo-0", "photo-1"])
        assert n1 == 1
        assert n2 == 1  # 只新增 photo-1

    async def test_enqueue_library_excludes_nohash(
        self,
        db_with_photos: Database,
    ) -> None:
        # photo-2 没 file_hash，应该跳过
        n = await enqueue_library(db_with_photos, "lib-1")
        assert n == 2

    async def test_force_rerun_does_not_skip_current_version_cache(
        self,
        db_with_photos: Database,
    ) -> None:
        db = db_with_photos
        await db.conn.execute(
            "INSERT INTO analysis_results (id, photo_id, pipeline_version, result_json, "
            "bird_count, created_at, is_active) VALUES (?, ?, ?, ?, 1, ?, 1)",
            ("result-1", "photo-0", "v1-test", "{}", "2026-04-24"),
        )
        await db.conn.commit()

        skipped = await enqueue_photos(
            db,
            "lib-1",
            ["photo-0"],
            current_pipeline_version="v1-test",
        )
        assert skipped == 0

        forced = await enqueue_photos(
            db,
            "lib-1",
            ["photo-0"],
            current_pipeline_version="v1-test",
            force_rerun=True,
        )
        assert forced == 1


class TestPickNext:
    async def test_pick_pending_marks_processing(
        self,
        db_with_photos: Database,
    ) -> None:
        db = db_with_photos
        await enqueue_photos(db, "lib-1", ["photo-0"])
        task = await pick_next(db, library_id="lib-1")
        assert task is not None
        assert task.status is TaskStatus.PROCESSING
        assert task.started_at is not None

    async def test_pick_none_when_empty(
        self,
        db_with_photos: Database,
    ) -> None:
        task = await pick_next(db_with_photos, library_id="lib-1")
        assert task is None

    async def test_priority_ordering(
        self,
        db_with_photos: Database,
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
        self,
        db_with_photos: Database,
    ) -> None:
        db = db_with_photos
        tid = await self._enqueue_one(db)
        t = await transition(db, tid, TaskStatus.PROCESSING)
        assert t.status is TaskStatus.PROCESSING

    async def test_illegal_pending_to_completed(
        self,
        db_with_photos: Database,
    ) -> None:
        db = db_with_photos
        tid = await self._enqueue_one(db)
        with pytest.raises(IllegalTransitionError):
            await transition(db, tid, TaskStatus.COMPLETED)

    async def test_completed_is_terminal(
        self,
        db_with_photos: Database,
    ) -> None:
        db = db_with_photos
        tid = await self._enqueue_one(db)
        await transition(db, tid, TaskStatus.PROCESSING)
        await transition(db, tid, TaskStatus.COMPLETED)
        # 从 completed 不能再转出
        with pytest.raises(IllegalTransitionError):
            await transition(db, tid, TaskStatus.PROCESSING)

    async def test_failed_to_pending_retry(
        self,
        db_with_photos: Database,
    ) -> None:
        db = db_with_photos
        tid = await self._enqueue_one(db)
        await transition(db, tid, TaskStatus.PROCESSING)
        t = await transition(
            db,
            tid,
            TaskStatus.FAILED,
            error_message="oh no",
        )
        assert t.attempts == 1
        assert t.error_message == "oh no"

        # 重试
        t2 = await transition(db, tid, TaskStatus.PENDING)
        assert t2.status is TaskStatus.PENDING
        assert t2.attempts == 1  # 不重置

    async def test_paused_resume_cycle(
        self,
        db_with_photos: Database,
    ) -> None:
        db = db_with_photos
        tid = await self._enqueue_one(db)
        await transition(db, tid, TaskStatus.PROCESSING)
        paused = await transition(db, tid, TaskStatus.PAUSED)
        assert paused.status is TaskStatus.PAUSED
        resumed = await transition(db, tid, TaskStatus.PENDING)
        assert resumed.status is TaskStatus.PENDING

    async def test_mark_failed_with_retry_auto_dead(
        self,
        db_with_photos: Database,
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

    async def test_mark_failed_with_retry_fallback_when_second_step_fails(
        self,
        db_with_photos: Database,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """第二次 transition 抛 → fallback SQL 兜底,task 不卡 FAILED。

        模拟方法:patch transition 让第二次调用抛 RuntimeError(第一次正常)。
        预期:fallback UPDATE 把 task 推到 PENDING,attempts=1 不丢失。
        """
        from engine.services import queue as queue_module

        db = db_with_photos
        tid = await self._enqueue_one(db)
        await transition(db, tid, TaskStatus.PROCESSING)

        original_transition = queue_module.transition
        call_count = {"n": 0}

        async def flaky_transition(db_arg, task_id, to, *, error_message=None):  # type: ignore[no-untyped-def]
            call_count["n"] += 1
            # 第 1 次(transition FAILED) 走原实现; 第 2 次(transition PENDING) 故意抛
            if call_count["n"] == 1:
                return await original_transition(db_arg, task_id, to, error_message=error_message)
            msg = "Simulated DB failure on second transition"
            raise RuntimeError(msg)

        monkeypatch.setattr(queue_module, "transition", flaky_transition)
        result = await mark_failed_with_retry(db, tid, "first failure")

        # fallback 路径生效:task 应在 PENDING(attempts=1 < MAX → retry)
        assert result.status is TaskStatus.PENDING
        assert result.attempts == 1
        assert result.started_at is None  # fallback UPDATE 清了
        # 直接读 DB 二次确认(避免 result 是缓存值)
        from_db = await get_task(db, tid)
        assert from_db is not None
        assert from_db.status is TaskStatus.PENDING
        assert from_db.attempts == 1


class TestRecovery:
    async def test_recover_processing_to_pending(
        self,
        db_with_photos: Database,
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


class TestStuckSweeper:
    """`mark_stuck_tasks_failed` — worker 卡死(MPS hang / 死锁) 的兜底回收。"""

    async def test_old_processing_task_marked_failed_and_requeued(
        self,
        db_with_photos: Database,
    ) -> None:
        """started_at 超过阈值 → mark_failed_with_retry → attempts<MAX 时回 PENDING。"""
        db = db_with_photos
        await enqueue_photos(db, "lib-1", ["photo-0"])
        task_id = (await list_tasks(db))[0].id
        await transition(db, task_id, TaskStatus.PROCESSING)

        # 手动把 started_at 倒推 10 分钟,模拟卡死
        await db.conn.execute(
            "UPDATE task_queue SET started_at = '2020-01-01T00:00:00+00:00' WHERE id = ?",
            (task_id,),
        )
        await db.conn.commit()

        handled = await mark_stuck_tasks_failed(db, threshold_sec=300)
        assert handled == 1

        t = await get_task(db, task_id)
        assert t is not None
        assert t.status is TaskStatus.PENDING  # attempts=1 < MAX → 重新排队
        assert t.attempts == 1

    async def test_recent_processing_task_not_touched(
        self,
        db_with_photos: Database,
    ) -> None:
        """started_at 在阈值内的 PROCESSING task 不该被误杀。"""
        db = db_with_photos
        await enqueue_photos(db, "lib-1", ["photo-0"])
        task_id = (await list_tasks(db))[0].id
        await transition(db, task_id, TaskStatus.PROCESSING)
        # started_at 是刚才 transition 设的 now,远在阈值内

        handled = await mark_stuck_tasks_failed(db, threshold_sec=300)
        assert handled == 0
        t = await get_task(db, task_id)
        assert t is not None
        assert t.status is TaskStatus.PROCESSING

    async def test_stuck_after_max_attempts_goes_to_dead(
        self,
        db_with_photos: Database,
    ) -> None:
        """已经 fail 过 MAX-1 次的 task 再 stuck → DEAD,而不是无限重试。"""
        db = db_with_photos
        await enqueue_photos(db, "lib-1", ["photo-0"])
        task_id = (await list_tasks(db))[0].id

        # 模拟 attempts 已经积累到 MAX-1
        for _ in range(MAX_ATTEMPTS - 1):
            await transition(db, task_id, TaskStatus.PROCESSING)
            await transition(db, task_id, TaskStatus.FAILED, error_message="prev")
            await transition(db, task_id, TaskStatus.PENDING)

        # 最后一次 PROCESSING + 卡死
        await transition(db, task_id, TaskStatus.PROCESSING)
        await db.conn.execute(
            "UPDATE task_queue SET started_at = '2020-01-01T00:00:00+00:00' WHERE id = ?",
            (task_id,),
        )
        await db.conn.commit()

        handled = await mark_stuck_tasks_failed(db, threshold_sec=300)
        assert handled == 1
        t = await get_task(db, task_id)
        assert t is not None
        assert t.status is TaskStatus.DEAD  # 不再无限重试


class TestBatchOps:
    async def test_pause_resume_library(
        self,
        db_with_photos: Database,
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
        self,
        db_with_photos: Database,
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
        self,
        db_with_photos: Database,
    ) -> None:
        stats = await get_stats(db_with_photos, "lib-1")
        # 无任务时所有状态都是 0
        for status in TaskStatus:
            assert stats[status.value] == 0
