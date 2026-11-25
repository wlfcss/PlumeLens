"""Unit tests for lifespan worker resumption and stuck-task sweeper recovery."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from engine.core.config import Settings
from engine.core.database import Database
from engine.core.lifespan import _resume_pending_workers, _sweep_stuck_tasks
from engine.pipeline.manager import PipelineManager
from fastapi import FastAPI


async def _seed_db(tmp_path: Path) -> Database:
    db = Database(tmp_path / "lifespan.db")
    await db.connect()
    await db.conn.execute(
        "INSERT INTO libraries (id, display_name, parent_path, root_path, status, "
        "created_at, last_opened_at) VALUES ('lib-run', 'Run', '/p', '/p/run', 'ready', "
        "'2026-04-24', '2026-04-24')"
    )
    await db.conn.execute(
        "INSERT INTO libraries (id, display_name, parent_path, root_path, status, "
        "created_at, last_opened_at) VALUES ('lib-paused', 'Paused', '/p', '/p/paused', 'ready', "
        "'2026-04-24', '2026-04-24')"
    )
    for idx, lib_id in enumerate(("lib-run", "lib-paused")):
        await db.conn.execute(
            "INSERT INTO photos (id, file_path, file_name, file_size, file_mtime, "
            "file_hash, created_at, library_id) VALUES (?, ?, ?, 100, '2026-04-24', ?, "
            "'2026-04-24', ?)",
            (f"p-{idx}", f"/p/{idx}.jpg", f"{idx}.jpg", f"h-{idx}", lib_id),
        )
    await db.conn.commit()
    return db


def _ready_pipeline(tmp_path: Path) -> PipelineManager:
    pm = PipelineManager(Settings(data_dir=tmp_path))
    pm._detector = MagicMock()
    return pm


async def test_resume_pending_workers_resumes_running_and_skips_paused_or_unready(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = await _seed_db(tmp_path)
    try:
        await db.conn.execute(
            "INSERT INTO analysis_runs (id, library_id, desired_state, created_at) "
            "VALUES ('run-1', 'lib-run', 'running', '2026-04-24')"
        )
        await db.conn.execute(
            "INSERT INTO analysis_runs (id, library_id, desired_state, created_at) "
            "VALUES ('run-2', 'lib-paused', 'paused', '2026-04-24')"
        )
        await db.conn.execute(
            "INSERT INTO task_queue (id, photo_id, library_id, status, priority, attempts, "
            "created_at, run_id) VALUES ('t-1', 'p-0', 'lib-run', 'pending', 0, 0, "
            "'2026-04-24', 'run-1')"
        )
        await db.conn.execute(
            "INSERT INTO task_queue (id, photo_id, library_id, status, priority, attempts, "
            "created_at, run_id) VALUES ('t-2', 'p-1', 'lib-paused', 'pending', 0, 0, "
            "'2026-04-24', 'run-2')"
        )
        await db.conn.commit()

        started: list[str] = []
        monkeypatch.setattr(
            "engine.services.analysis_worker.start_library_worker",
            lambda _db, _pipeline, lib_id, _conc: started.append(lib_id),
        )

        # Unready pipeline → skips everything
        app = FastAPI()
        app.state.pipeline = PipelineManager(Settings(data_dir=tmp_path))
        await _resume_pending_workers(app, db)
        assert started == []

        # Ready pipeline → resumes lib-run, ignores paused lib-paused
        app.state.pipeline = _ready_pipeline(tmp_path)
        await _resume_pending_workers(app, db)
        assert started == ["lib-run"]

        async with db.conn.execute("SELECT status FROM libraries WHERE id='lib-run'") as cur:
            row = await cur.fetchone()
        assert row is not None and row["status"] == "analyzing_partial"
    finally:
        await db.close()


async def test_sweep_stuck_tasks_fast_resets_dead_worker_processing_and_revives(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = await _seed_db(tmp_path)
    try:
        await db.conn.execute(
            "INSERT INTO analysis_runs (id, library_id, desired_state, created_at) "
            "VALUES ('run-1', 'lib-run', 'running', '2026-04-24')"
        )
        await db.conn.execute(
            "INSERT INTO task_queue (id, photo_id, library_id, status, priority, attempts, "
            "created_at, started_at, run_id) VALUES ('t-proc', 'p-0', 'lib-run', 'processing', "
            "0, 0, '2026-04-24', '2026-04-24', 'run-1')"
        )
        await db.conn.commit()

        revived: list[str] = []
        monkeypatch.setattr("engine.services.analysis_worker.get_library_worker", lambda _lib: None)
        monkeypatch.setattr(
            "engine.services.analysis_worker.start_library_worker",
            lambda _db, _pipeline, lib_id, _conc: revived.append(lib_id),
        )

        # Let _sweep_stuck_tasks run exactly one iteration, then cancel cleanly
        sleep_calls = 0

        async def one_shot_sleep(_sec: float) -> None:
            nonlocal sleep_calls
            sleep_calls += 1
            if sleep_calls > 1:
                raise asyncio.CancelledError

        monkeypatch.setattr(asyncio, "sleep", one_shot_sleep)

        app = FastAPI()
        app.state.pipeline = _ready_pipeline(tmp_path)

        with pytest.raises(asyncio.CancelledError):
            await _sweep_stuck_tasks(app, db)

        async with db.conn.execute(
            "SELECT status, started_at FROM task_queue WHERE id='t-proc'"
        ) as cur:
            row = await cur.fetchone()
        assert row is not None
        assert row["status"] == "pending"
        assert row["started_at"] is None
        assert revived == ["lib-run"]
    finally:
        await db.close()


async def test_lifespan_shuts_down_cleanly_without_executor_after_shutdown_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """lifespan 退出时必须先完成 db.close() 与异步日志，最后再关闭默认 thread_pool。"""
    from engine.core import lifespan as lifespan_mod
    from engine.core.config import settings

    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(settings, "models_dir", tmp_path / "empty-models")

    async def noop_initialize(self: PipelineManager) -> None:
        self._pipeline_version = "v2-test"

    monkeypatch.setattr(PipelineManager, "initialize", noop_initialize)
    monkeypatch.setattr(lifespan_mod, "_refresh_all_thumbnails", lambda _db: asyncio.sleep(3600))
    monkeypatch.setattr(lifespan_mod, "_backfill_locations", lambda _db: asyncio.sleep(3600))
    monkeypatch.setattr(lifespan_mod, "_sweep_stuck_tasks", lambda _a, _d: asyncio.sleep(3600))

    app = FastAPI()
    async with lifespan_mod.lifespan(app):
        assert app.state.db is not None
        assert app.state.pipeline is not None
