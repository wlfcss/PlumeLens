"""Integration tests for /decisions endpoints."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest
from httpx import ASGITransport, AsyncClient
from PIL import Image


def _make_jpeg(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (60, 40), (100, 100, 100)).save(path, "JPEG")


@pytest.fixture
async def client_with_photos(tmp_path: Path):
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
    app.state.db = db
    app.state.pipeline = pipeline

    lib_root = tmp_path / "lib"
    for i in range(3):
        _make_jpeg(lib_root / f"p{i}.jpg")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        r = await ac.post("/library/import", json={"root_path": str(lib_root)})
        lib_id = r.json()["id"]
        detail = await ac.get(f"/library/{lib_id}")
        photo_ids = [p["id"] for p in detail.json()["photos"]]
        yield ac, lib_id, photo_ids, db

    await db.close()


class TestSingleDecision:
    async def test_default_none(self, client_with_photos) -> None:
        client, _, photo_ids, _ = client_with_photos
        r = await client.get(f"/decisions/photo/{photo_ids[0]}")
        assert r.status_code == 200
        assert r.json()["decision"] is None

    async def test_put_and_read_back(self, client_with_photos) -> None:
        client, _, photo_ids, _ = client_with_photos
        r = await client.put(
            f"/decisions/photo/{photo_ids[0]}",
            json={"decision": "select"},
        )
        assert r.status_code == 200
        assert r.json()["decision"] == "select"

        r2 = await client.get(f"/decisions/photo/{photo_ids[0]}")
        assert r2.json()["decision"] == "select"

    async def test_put_null_clears_manual_grade(self, client_with_photos) -> None:
        client, _, photo_ids, _ = client_with_photos
        await client.put(f"/decisions/photo/{photo_ids[0]}", json={"decision": "usable"})
        r = await client.put(f"/decisions/photo/{photo_ids[0]}", json={"decision": None})
        assert r.status_code == 200
        assert r.json()["decision"] is None

    async def test_put_invalid_decision_400(self, client_with_photos) -> None:
        client, _, photo_ids, _ = client_with_photos
        r = await client.put(
            f"/decisions/photo/{photo_ids[0]}",
            json={"decision": "garbage"},
        )
        assert r.status_code == 400

    async def test_put_nonexistent_photo_404(self, client_with_photos) -> None:
        client, _, _, _ = client_with_photos
        r = await client.put(
            "/decisions/photo/does-not-exist",
            json={"decision": "select"},
        )
        assert r.status_code == 404


class TestBatchDecisions:
    async def test_batch_update(self, client_with_photos) -> None:
        client, _, photo_ids, _ = client_with_photos
        updates = [
            [photo_ids[0], "select"],
            [photo_ids[1], "reject"],
            [photo_ids[2], "record"],
        ]
        r = await client.post(
            "/decisions/batch",
            json={"updates": updates},
        )
        assert r.status_code == 200
        assert r.json()["updated"] == 3

        # Verify
        for pid, expected in zip(photo_ids, ["select", "reject", "record"], strict=True):
            r = await client.get(f"/decisions/photo/{pid}")
            assert r.json()["decision"] == expected

    async def test_batch_null_clears_manual_grade(self, client_with_photos) -> None:
        client, _, photo_ids, _ = client_with_photos
        await client.put(f"/decisions/photo/{photo_ids[0]}", json={"decision": "usable"})

        r = await client.post(
            "/decisions/batch",
            json={"updates": [[photo_ids[0], None]]},
        )

        assert r.status_code == 200
        assert r.json()["updated"] == 1
        r2 = await client.get(f"/decisions/photo/{photo_ids[0]}")
        assert r2.json()["decision"] is None

    async def test_batch_nonexistent_photo_404(self, client_with_photos) -> None:
        client, _, _, _ = client_with_photos
        r = await client.post(
            "/decisions/batch",
            json={"updates": [["does-not-exist", "select"]]},
        )
        assert r.status_code == 404


class TestListAndCounts:
    async def test_library_list(self, client_with_photos) -> None:
        client, lib_id, photo_ids, _ = client_with_photos
        await client.put(
            f"/decisions/photo/{photo_ids[0]}",
            json={"decision": "select"},
        )
        r = await client.get(f"/decisions/library/{lib_id}")
        data = r.json()
        assert len(data) == 1
        assert data[0]["photo_id"] == photo_ids[0]
        assert data[0]["decision"] == "select"

    async def test_library_counts(self, client_with_photos) -> None:
        client, lib_id, photo_ids, _ = client_with_photos
        await client.put(
            f"/decisions/photo/{photo_ids[0]}",
            json={"decision": "select"},
        )
        await client.put(
            f"/decisions/photo/{photo_ids[1]}",
            json={"decision": "reject"},
        )
        r = await client.get(f"/decisions/library/{lib_id}/counts")
        assert r.status_code == 200
        counts = r.json()["counts"]
        assert counts["select"] == 1
        assert counts["reject"] == 1
        assert counts["usable"] == 0
        assert counts["record"] == 0

    async def test_library_detail_includes_decision(
        self,
        client_with_photos,
    ) -> None:
        """PhotoRow.decision 字段应出现在 /library/{id} 响应里。"""
        client, lib_id, photo_ids, _ = client_with_photos
        await client.put(
            f"/decisions/photo/{photo_ids[0]}",
            json={"decision": "usable"},
        )
        r = await client.get(f"/library/{lib_id}")
        photos = r.json()["photos"]
        decisions_by_id = {p["id"]: p["decision"] for p in photos}
        assert decisions_by_id[photo_ids[0]] == "usable"
        # 其他 photo 默认无人工覆盖
        for pid in photo_ids[1:]:
            assert decisions_by_id[pid] is None


class TestSpeciesOverride:
    async def test_put_species_override_and_clear(self, client_with_photos) -> None:
        client, _, photo_ids, _ = client_with_photos
        r = await client.put(
            f"/decisions/photo/{photo_ids[0]}/species/0",
            json={
                "canonical_sci": "Zosterops simplex",
                "canonical_zh": "暗绿绣眼鸟",
                "canonical_en": "Swinhoe's white-eye",
            },
        )
        assert r.status_code == 200
        assert r.json()["canonical_sci"] == "Zosterops simplex"
        assert r.json()["canonical_zh"] == "暗绿绣眼鸟"

        r2 = await client.put(
            f"/decisions/photo/{photo_ids[0]}/species/0",
            json={"canonical_sci": None},
        )
        assert r2.status_code == 200
        assert r2.json()["canonical_sci"] is None

    async def test_put_species_override_rejects_negative_index(
        self,
        client_with_photos,
    ) -> None:
        client, _, photo_ids, _ = client_with_photos
        r = await client.put(
            f"/decisions/photo/{photo_ids[0]}/species/-1",
            json={"canonical_sci": "Zosterops simplex"},
        )
        assert r.status_code == 400
