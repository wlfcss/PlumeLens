"""Integration tests for /library endpoints (with real DB + real ASGI transport)."""

from __future__ import annotations

from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from PIL import Image


def _make_jpeg(path: Path, size: tuple[int, int] = (100, 80)) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, (120, 140, 160)).save(path, "JPEG")


@pytest.fixture
async def real_client(tmp_path: Path):
    """Spin up a real FastAPI app with real DB (no ONNX models loaded)."""
    from unittest.mock import MagicMock

    from engine.core.config import settings
    from engine.core.database import Database
    from engine.main import create_app

    # 临时目录做数据库 + cache
    settings.data_dir = tmp_path
    settings.models_dir = tmp_path / "missing-models"  # 故意让 pipeline 降级
    app = create_app()

    # 手动跳过 lifespan 的 pipeline 初始化（不真正加载 ONNX）
    db = Database(tmp_path / "test.db")
    await db.connect()
    mock_pipeline = MagicMock()
    mock_pipeline.is_ready = False
    mock_pipeline.pose_available = False
    mock_pipeline.species_available = False
    mock_pipeline.pipeline_version = "test-v1"
    mock_pipeline.model_status = {}
    mock_pipeline.model_providers = {}
    app.state.db = db
    app.state.pipeline = mock_pipeline

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, tmp_path
    await db.close()


class TestImportLibrary:
    async def test_import_creates_library_and_scans(self, real_client) -> None:
        client, tmp = real_client
        lib_root = tmp / "library1"
        _make_jpeg(lib_root / "a.jpg")
        _make_jpeg(lib_root / "b.jpg")

        resp = await client.post(
            "/library/import", json={"root_path": str(lib_root)},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["display_name"] == "library1"
        assert data["status"] == "ready"
        assert data["total_count"] == 2
        assert data["analyzed_count"] == 0

    async def test_import_nonexistent_path_400(self, real_client) -> None:
        client, _ = real_client
        resp = await client.post(
            "/library/import", json={"root_path": "/nonexistent/path"},
        )
        assert resp.status_code == 400

    async def test_import_idempotent(self, real_client) -> None:
        client, tmp = real_client
        lib_root = tmp / "lib_idempotent"
        _make_jpeg(lib_root / "a.jpg")

        r1 = await client.post("/library/import", json={"root_path": str(lib_root)})
        r2 = await client.post("/library/import", json={"root_path": str(lib_root)})
        assert r1.status_code == r2.status_code == 201
        # 同一 root_path 应返回同一个 id
        assert r1.json()["id"] == r2.json()["id"]


class TestListAndDetail:
    async def test_list_and_detail(self, real_client) -> None:
        client, tmp = real_client
        lib_root = tmp / "lib_detail"
        _make_jpeg(lib_root / "p.jpg")
        await client.post("/library/import", json={"root_path": str(lib_root)})

        resp = await client.get("/library")
        assert resp.status_code == 200
        libs = resp.json()
        assert len(libs) == 1
        lib_id = libs[0]["id"]

        detail = await client.get(f"/library/{lib_id}")
        assert detail.status_code == 200
        d = detail.json()
        assert d["library"]["id"] == lib_id
        assert len(d["photos"]) == 1
        assert d["photos"][0]["file_name"] == "p.jpg"
        # 分析尚未跑 → grade 为 None
        assert d["photos"][0]["grade"] is None

    async def test_detail_404(self, real_client) -> None:
        client, _ = real_client
        resp = await client.get("/library/does-not-exist")
        assert resp.status_code == 404


class TestDelete:
    async def test_delete_cascades(self, real_client) -> None:
        client, tmp = real_client
        lib_root = tmp / "lib_del"
        _make_jpeg(lib_root / "x.jpg")
        r = await client.post("/library/import", json={"root_path": str(lib_root)})
        lib_id = r.json()["id"]

        delete = await client.delete(f"/library/{lib_id}")
        assert delete.status_code == 204

        # 后续 detail 应 404
        resp = await client.get(f"/library/{lib_id}")
        assert resp.status_code == 404

    async def test_delete_404_for_unknown(self, real_client) -> None:
        client, _ = real_client
        resp = await client.delete("/library/nope")
        assert resp.status_code == 404
