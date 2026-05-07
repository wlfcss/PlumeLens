"""Integration tests for /analysis endpoints."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from engine.pipeline.models import (
    BirdAnalysis,
    BoundingBox,
    PipelineResult,
    QualityGrade,
    QualityScores,
)
from httpx import ASGITransport, AsyncClient
from PIL import Image


def _make_jpeg(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (60, 40), (100, 100, 100)).save(path, "JPEG")


def _fake_result(photo_id: str, version: str = "v1-test") -> PipelineResult:
    bbox = BoundingBox(x1=0, y1=0, x2=60, y2=40, confidence=0.9)
    q = QualityScores(clipiqa=0.4, hyperiqa=0.6, combined=0.55)
    ba = BirdAnalysis(bbox=bbox, quality=q, grade=QualityGrade.USABLE)
    return PipelineResult(
        photo_id=photo_id,
        detections=[ba],
        best=ba,
        bird_count=1,
        pipeline_version=version,
        duration_ms=50.0,
    )


@pytest.fixture
async def client_with_lib(tmp_path: Path):
    """Client with DB + 1 library containing 2 photos, pipeline mocked as ready."""
    from engine.core.config import settings
    from engine.core.database import Database
    from engine.main import create_app

    settings.data_dir = tmp_path
    settings.models_dir = tmp_path / "unused"
    app = create_app()

    db = Database(tmp_path / "test.db")
    await db.connect()

    # mock pipeline: ready + analyze returns fake
    pipeline = MagicMock()
    pipeline.is_ready = True
    pipeline.quality_available = True
    pipeline.pose_available = False
    pipeline.species_available = False
    pipeline.pipeline_version = "v1-test"
    pipeline.model_status = {}
    pipeline.model_providers = {}

    async def fake_analyze(image_path: Path, photo_id: str = "") -> PipelineResult:
        return _fake_result(photo_id)

    pipeline.analyze = AsyncMock(side_effect=fake_analyze)

    app.state.db = db
    app.state.pipeline = pipeline

    # Pre-create library + 2 photos on disk + DB
    lib_root = tmp_path / "lib"
    _make_jpeg(lib_root / "a.jpg")
    _make_jpeg(lib_root / "b.jpg")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        r = await ac.post("/library/import", json={"root_path": str(lib_root)})
        lib_id = r.json()["id"]
        # 手工补 file_hash（否则 enqueue_library 会跳过）
        await db.conn.execute(
            "UPDATE photos SET file_hash = id WHERE library_id = ?",
            (lib_id,),
        )
        await db.conn.commit()
        yield ac, lib_id, db, pipeline

    # Fixture teardown: 等 worker 收尾，避免 DB 关闭时还在查询
    from engine.api.routes.analysis import _workers

    for task in list(_workers.values()):
        if not task.done():
            try:
                await asyncio.wait_for(task, timeout=5.0)
            except (TimeoutError, Exception):
                task.cancel()
    _workers.clear()
    await db.close()


class TestBatch:
    async def test_batch_enqueues_and_runs(self, client_with_lib) -> None:
        client, lib_id, db, _ = client_with_lib
        resp = await client.post(
            "/analysis/batch",
            json={"library_id": lib_id},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["library_id"] == lib_id
        assert data["enqueued"] == 2
        assert data["stats"]["pending"] >= 0

        # 等 worker 把队列跑完
        for _ in range(50):
            stats_resp = await client.get(f"/analysis/library/{lib_id}/stats")
            stats = stats_resp.json()["stats"]
            if stats.get("completed", 0) + stats.get("dead", 0) >= 2:
                break
            await asyncio.sleep(0.05)
        assert stats.get("completed", 0) == 2

    async def test_batch_updates_library_status_and_completion_time(self, client_with_lib) -> None:
        client, lib_id, _, pipeline = client_with_lib
        release = asyncio.Event()

        async def slow_analyze(image_path: Path, photo_id: str = "") -> PipelineResult:
            await release.wait()
            return _fake_result(photo_id)

        pipeline.analyze = AsyncMock(side_effect=slow_analyze)

        resp = await client.post(
            "/analysis/batch",
            json={"library_id": lib_id},
        )
        assert resp.status_code == 200
        detail = await client.get(f"/library/{lib_id}")
        assert detail.json()["library"]["status"] == "analyzing_partial"

        release.set()
        for _ in range(50):
            stats_resp = await client.get(f"/analysis/library/{lib_id}/stats")
            stats = stats_resp.json()["stats"]
            if stats.get("completed", 0) >= 2:
                break
            await asyncio.sleep(0.05)

        detail = await client.get(f"/library/{lib_id}")
        library = detail.json()["library"]
        assert library["status"] == "ready"
        assert library["analyzed_count"] == 2
        assert library["last_analyzed_at"] is not None

    async def test_starting_new_batch_clears_old_terminal_queue_rows(self, client_with_lib) -> None:
        client, lib_id, _, _ = client_with_lib
        await client.post("/analysis/batch", json={"library_id": lib_id})
        for _ in range(50):
            stats_resp = await client.get(f"/analysis/library/{lib_id}/stats")
            stats = stats_resp.json()["stats"]
            if stats.get("completed", 0) >= 2:
                break
            await asyncio.sleep(0.05)
        assert stats.get("completed", 0) == 2

        resp = await client.post("/analysis/batch", json={"library_id": lib_id})
        assert resp.status_code == 200
        data = resp.json()
        assert data["enqueued"] == 0
        assert sum(data["stats"].values()) == 0

    async def test_batch_force_rerun_ignores_current_version_cache(self, client_with_lib) -> None:
        client, lib_id, _, pipeline = client_with_lib
        await client.post("/analysis/batch", json={"library_id": lib_id})
        for _ in range(50):
            stats_resp = await client.get(f"/analysis/library/{lib_id}/stats")
            stats = stats_resp.json()["stats"]
            if stats.get("completed", 0) >= 2:
                break
            await asyncio.sleep(0.05)

        pipeline.analyze.reset_mock()
        resp = await client.post(
            "/analysis/batch",
            json={"library_id": lib_id, "force_rerun": True},
        )
        assert resp.status_code == 200
        assert resp.json()["enqueued"] == 2

        for _ in range(50):
            stats_resp = await client.get(f"/analysis/library/{lib_id}/stats")
            stats = stats_resp.json()["stats"]
            if stats.get("completed", 0) >= 2:
                break
            await asyncio.sleep(0.05)
        assert pipeline.analyze.await_count == 2

    async def test_stats_returns_all_keys(self, client_with_lib) -> None:
        client, lib_id, _, _ = client_with_lib
        resp = await client.get(f"/analysis/library/{lib_id}/stats")
        assert resp.status_code == 200
        stats = resp.json()["stats"]
        for key in ("pending", "processing", "completed", "failed", "dead", "cancelled", "paused"):
            assert key in stats

    async def test_tasks_list(self, client_with_lib) -> None:
        client, lib_id, _, _ = client_with_lib
        await client.post("/analysis/batch", json={"library_id": lib_id})
        resp = await client.get(f"/analysis/library/{lib_id}/tasks")
        assert resp.status_code == 200
        tasks = resp.json()
        assert len(tasks) == 2

    async def test_batch_rejects_missing_source_root(self, client_with_lib) -> None:
        client, lib_id, db, _ = client_with_lib
        async with db.conn.execute(
            "SELECT root_path FROM libraries WHERE id = ?",
            (lib_id,),
        ) as cur:
            row = await cur.fetchone()
        root = Path(str(row["root_path"]))
        await asyncio.to_thread(root.rename, root.with_name("lib-moved"))

        resp = await client.post("/analysis/batch", json={"library_id": lib_id})
        assert resp.status_code == 409
        assert "relink" in resp.json()["detail"]

        detail = await client.get(f"/library/{lib_id}")
        assert detail.json()["library"]["status"] == "path_missing"

    async def test_batch_recovers_path_missing_when_source_root_returns(
        self,
        client_with_lib,
    ) -> None:
        client, lib_id, db, _ = client_with_lib
        await db.conn.execute(
            "UPDATE libraries SET status = 'path_missing' WHERE id = ?",
            (lib_id,),
        )
        await db.conn.commit()

        resp = await client.post("/analysis/batch", json={"library_id": lib_id})
        assert resp.status_code == 200

        detail = await client.get(f"/library/{lib_id}")
        assert detail.json()["library"]["status"] in {"analyzing_partial", "ready"}


class TestLifecycle:
    async def test_cancel(self, client_with_lib) -> None:
        client, lib_id, _, pipeline = client_with_lib
        from engine.core.config import settings

        old_concurrency = settings.analysis_concurrency
        settings.analysis_concurrency = 1
        release = asyncio.Event()

        async def slow_analyze(image_path: Path, photo_id: str = "") -> PipelineResult:
            await release.wait()
            return _fake_result(photo_id)

        try:
            pipeline.analyze = AsyncMock(side_effect=slow_analyze)
            await client.post("/analysis/batch", json={"library_id": lib_id})
            for _ in range(50):
                stats_resp = await client.get(f"/analysis/library/{lib_id}/stats")
                stats = stats_resp.json()["stats"]
                if stats.get("processing", 0) >= 1:
                    break
                await asyncio.sleep(0.05)

            cancel_resp = await client.post(f"/analysis/library/{lib_id}/cancel")
            assert cancel_resp.status_code == 200
            stats = cancel_resp.json()["stats"]
            assert stats.get("processing", 0) == 1
            assert stats.get("cancelled", 0) == 1

            release.set()
            for _ in range(50):
                stats_resp = await client.get(f"/analysis/library/{lib_id}/stats")
                stats = stats_resp.json()["stats"]
                if stats.get("completed", 0) >= 1:
                    break
                await asyncio.sleep(0.05)
            assert stats.get("completed", 0) == 1
            assert stats.get("cancelled", 0) == 1
        finally:
            settings.analysis_concurrency = old_concurrency


class TestAutoBackfill:
    """回归测试：start_batch 必须在 enqueue 前同步补 SHA-256，
    确保用户在 import 之后立刻触发分析也不会得到 enqueued=0。"""

    async def test_batch_auto_backfills_missing_hashes(self, tmp_path: Path) -> None:
        from engine.core.config import settings
        from engine.core.database import Database
        from engine.main import create_app

        settings.data_dir = tmp_path
        settings.models_dir = tmp_path / "unused"
        app = create_app()
        db = Database(tmp_path / "t.db")
        await db.connect()

        pipeline = MagicMock()
        pipeline.is_ready = True
        pipeline.quality_available = True
        pipeline.pose_available = False
        pipeline.species_available = False
        pipeline.pipeline_version = "v1-test"
        pipeline.model_status = {}
        pipeline.model_providers = {}

        async def fake_analyze(image_path: Path, photo_id: str = "") -> PipelineResult:
            return _fake_result(photo_id)

        pipeline.analyze = AsyncMock(side_effect=fake_analyze)
        app.state.db = db
        app.state.pipeline = pipeline

        lib_root = tmp_path / "auto-backfill-lib"
        _make_jpeg(lib_root / "a.jpg")
        _make_jpeg(lib_root / "b.jpg")

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            r = await ac.post("/library/import", json={"root_path": str(lib_root)})
            assert r.status_code == 201
            lib_id = r.json()["id"]

            # 不手动补 file_hash —— 我们要测试 start_batch 自己补
            # 验证：导入后 photos 表里 file_hash 可能是 NULL（看 BackgroundTasks 是否抢先跑了）
            # 不重要，重要的是 batch 一定能 enqueue 到 2 张

            resp = await ac.post("/analysis/batch", json={"library_id": lib_id})
            assert resp.status_code == 200
            assert resp.json()["enqueued"] == 2

            # 验证 file_hash 被同步补齐（且非 NULL）
            async with db.conn.execute(
                "SELECT COUNT(*) AS c FROM photos WHERE library_id = ? AND file_hash IS NOT NULL",
                (lib_id,),
            ) as cur:
                row = await cur.fetchone()
            assert row is not None and int(row["c"]) == 2

        # teardown 清理 worker
        from engine.api.routes.analysis import _workers

        for task in list(_workers.values()):
            if not task.done():
                try:
                    await asyncio.wait_for(task, timeout=5.0)
                except (TimeoutError, Exception):
                    task.cancel()
        _workers.clear()
        await db.close()


class TestPipelineGate:
    async def test_batch_requires_pipeline_ready(self, tmp_path: Path) -> None:
        from engine.core.config import settings
        from engine.core.database import Database
        from engine.main import create_app

        settings.data_dir = tmp_path
        settings.models_dir = tmp_path / "x"
        app = create_app()
        db = Database(tmp_path / "t.db")
        await db.connect()
        pipeline = MagicMock()
        pipeline.is_ready = False
        pipeline.pose_available = False
        pipeline.species_available = False
        pipeline.pipeline_version = "n/a"
        pipeline.model_status = {}
        pipeline.model_providers = {}
        app.state.db = db
        app.state.pipeline = pipeline

        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as c:
            resp = await c.post("/analysis/batch", json={"library_id": "lib-x"})
        assert resp.status_code == 503
        await db.close()
