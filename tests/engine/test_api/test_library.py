"""Integration tests for /library endpoints (with real DB + real ASGI transport)."""

from __future__ import annotations

import json
from pathlib import Path

import aiosqlite
import pytest
from httpx import ASGITransport, AsyncClient
from PIL import Image


def _make_jpeg(path: Path, size: tuple[int, int] = (100, 80)) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, (120, 140, 160)).save(path, "JPEG")


def _make_pose(head_visible: bool, eye_visible: bool | None = None) -> dict:
    """构造完整的 pose payload（PoseDetail schema 要求 5 个 keypoint 必填）。
    单独的 head_visible / eye_visible flag 是早期 fixture 的 shortcut，缺
    keypoint 会让 PoseDetail.model_validate 失败 → best.pose 落 None → 新规则下
    被判为 model_unconfirmed。这里补全 keypoint 让 pose 真正可解析。"""
    if eye_visible is None:
        eye_visible = head_visible
    kp = {"x": 10.0, "y": 10.0, "confidence": 0.9}
    return {
        "bill": kp,
        "crown": kp,
        "nape": kp,
        "left_eye": kp,
        "right_eye": kp,
        "head_visible": head_visible,
        "eye_visible": eye_visible,
    }


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
    mock_pipeline.quality_available = False
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
            "/library/import",
            json={"root_path": str(lib_root)},
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
            "/library/import",
            json={"root_path": "/nonexistent/path"},
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

    async def test_detail_applies_manual_species_override_per_bird(self, real_client) -> None:
        client, tmp = real_client
        lib_root = tmp / "lib_species_override"
        _make_jpeg(lib_root / "multi.jpg")
        await client.post("/library/import", json={"root_path": str(lib_root)})

        libs = (await client.get("/library")).json()
        lib_id = libs[0]["id"]
        initial_detail = (await client.get(f"/library/{lib_id}")).json()
        photo_id = initial_detail["photos"][0]["id"]

        result_json = {
            "photo_id": photo_id,
            "pipeline_version": "test-v1",
            "bird_count": 2,
            "duration_ms": 12,
            "best": None,
            "detections": [
                {
                    "bbox": {"x1": 1, "y1": 2, "x2": 30, "y2": 40, "confidence": 0.9},
                    "quality": {"clipiqa": 80.0, "hyperiqa": 75.0, "combined": 78.0},
                    "grade": "select",
                    "pose": None,
                    "species": "须浮鸥",
                    "species_candidates": [
                        {
                            "canonical_sci": "Chlidonias hybrida",
                            "canonical_zh": "须浮鸥",
                            "confidence": 0.91,
                        }
                    ],
                },
                {
                    "bbox": {"x1": 50, "y1": 60, "x2": 90, "y2": 100, "confidence": 0.8},
                    "quality": {"clipiqa": 70.0, "hyperiqa": 68.0, "combined": 69.0},
                    "grade": "usable",
                    "pose": None,
                    "species": "翠鸟",
                    "species_candidates": [
                        {
                            "canonical_sci": "Alcedo atthis",
                            "canonical_zh": "翠鸟",
                            "confidence": 0.82,
                        }
                    ],
                },
            ],
        }
        async with aiosqlite.connect(tmp / "test.db") as conn:
            await conn.execute(
                "INSERT INTO analysis_results (id, photo_id, pipeline_version, "
                "quality_score, grade, bird_count, species, result_json, created_at, is_active) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
                (
                    "ar-override",
                    photo_id,
                    "test-v1",
                    78.0,
                    "select",
                    2,
                    "须浮鸥",
                    json.dumps(result_json),
                    "2026-04-23T07:00:00+00:00",
                ),
            )
            await conn.commit()

        override = await client.put(
            f"/decisions/photo/{photo_id}/species/1",
            json={
                "canonical_sci": "Zosterops simplex",
                "canonical_zh": "暗绿绣眼鸟",
                "canonical_en": "swinhoe's white eye",
            },
        )
        assert override.status_code == 200

        detail = (await client.get(f"/library/{lib_id}")).json()
        photo = detail["photos"][0]
        assert photo["best_detection"]["species"] == "须浮鸥"
        assert photo["detections"][0]["species"] == "须浮鸥"
        assert photo["detections"][0]["manual_species"] is False
        assert photo["detections"][1]["species"] == "暗绿绣眼鸟"
        assert photo["detections"][1]["species_latin"] == "Zosterops simplex"
        assert photo["detections"][1]["manual_species"] is True

    async def test_detail_applies_group_species_consensus_for_single_bird_scene(
        self,
        real_client,
    ) -> None:
        client, tmp = real_client
        lib_root = tmp / "lib_group_species"
        for name in ("a.jpg", "b.jpg", "c.jpg", "d.jpg"):
            _make_jpeg(lib_root / name)
        await client.post("/library/import", json={"root_path": str(lib_root)})

        libs = (await client.get("/library")).json()
        lib_id = libs[0]["id"]
        initial_detail = (await client.get(f"/library/{lib_id}")).json()
        photos = sorted(initial_detail["photos"], key=lambda p: p["file_name"])

        def result_json(
            photo_id: str,
            species: str | None,
            sci: str | None,
            confidence: float | None,
            extra_candidate: tuple[str, str, float] | None = None,
        ) -> str:
            candidates = []
            if species and sci and confidence is not None:
                candidates.append(
                    {
                        "canonical_sci": sci,
                        "canonical_zh": species,
                        "confidence": confidence,
                    }
                )
            if extra_candidate is not None:
                extra_sci, extra_zh, extra_conf = extra_candidate
                candidates.append(
                    {
                        "canonical_sci": extra_sci,
                        "canonical_zh": extra_zh,
                        "confidence": extra_conf,
                    }
                )
            detection = {
                "bbox": {"x1": 1, "y1": 2, "x2": 30, "y2": 40, "confidence": 0.9},
                "quality": {"clipiqa": 0.7, "hyperiqa": 0.8, "combined": 0.76},
                "grade": "select",
                "pose": _make_pose(head_visible=True),
                "species": species,
                "species_candidates": candidates,
            }
            return json.dumps(
                {
                    "photo_id": photo_id,
                    "pipeline_version": "test-v1",
                    "bird_count": 1,
                    "duration_ms": 12,
                    "best": detection,
                    "detections": [detection],
                }
            )

        rows = [
            ("a.jpg", "暗绿绣眼鸟", "Zosterops simplex", 0.94, None),
            ("b.jpg", "暗绿绣眼鸟", "Zosterops simplex", 0.91, None),
            ("c.jpg", "暗绿绣眼鸟", "Zosterops simplex", 0.88, None),
            (
                "d.jpg",
                "日本绣眼鸟",
                "Zosterops japonicus",
                0.43,
                ("Zosterops simplex", "暗绿绣眼鸟", 0.30),
            ),
        ]

        async with aiosqlite.connect(tmp / "test.db") as conn:
            for index, photo in enumerate(photos):
                await conn.execute(
                    "UPDATE photos SET scene_id = ?, file_mtime = ? WHERE id = ?",
                    (0, f"2026-04-23T07:00:0{index}+00:00", photo["id"]),
                )
            for file_name, species, sci, confidence, extra in rows:
                photo = next(p for p in photos if p["file_name"] == file_name)
                await conn.execute(
                    "INSERT INTO analysis_results (id, photo_id, pipeline_version, "
                    "quality_score, grade, bird_count, species, result_json, created_at, "
                    "is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
                    (
                        f"ar-{file_name}",
                        photo["id"],
                        "test-v1",
                        0.76,
                        "select",
                        1,
                        species,
                        result_json(photo["id"], species, sci, confidence, extra),
                        "2026-04-23T07:00:00+00:00",
                    ),
                )
            await conn.commit()

        detail = (await client.get(f"/library/{lib_id}")).json()
        by_name = {p["file_name"]: p for p in detail["photos"]}
        corrected = by_name["d.jpg"]
        assert corrected["model_species"] == "日本绣眼鸟"
        assert corrected["species"] == "暗绿绣眼鸟"
        assert corrected["species_latin"] == "Zosterops simplex"
        assert corrected["species_source"] == "group_consensus"
        assert corrected["group_species_support"] == 3
        assert corrected["group_species_evidence"] == 4
        assert corrected["species_conflict"] is False
        assert by_name["a.jpg"]["species_source"] == "model"

    async def test_species_source_marks_head_invisible_as_model_unconfirmed(
        self,
        real_client,
    ) -> None:
        """放宽规则：head 可见 → model；head 不可见 / pose 缺失 → model_unconfirmed；
        manual_species 始终覆盖（优先级最高）。"""
        client, tmp = real_client
        lib_root = tmp / "lib_unconfirmed"
        for name in ("head_ok.jpg", "head_hidden.jpg", "no_pose.jpg", "manual.jpg"):
            _make_jpeg(lib_root / name)
        await client.post("/library/import", json={"root_path": str(lib_root)})

        libs = (await client.get("/library")).json()
        lib_id = libs[0]["id"]
        photos = sorted(
            (await client.get(f"/library/{lib_id}")).json()["photos"],
            key=lambda p: p["file_name"],
        )

        def make_result(photo_id: str, pose: dict | None) -> str:
            detection = {
                "bbox": {"x1": 1, "y1": 2, "x2": 30, "y2": 40, "confidence": 0.9},
                "quality": {"clipiqa": 0.7, "hyperiqa": 0.8, "combined": 0.76},
                "grade": "select",
                "pose": pose,
                "species": "白鹭",
                "species_candidates": [
                    {
                        "canonical_sci": "Egretta garzetta",
                        "canonical_zh": "白鹭",
                        "confidence": 0.85,
                    }
                ],
            }
            return json.dumps(
                {
                    "photo_id": photo_id,
                    "pipeline_version": "test-v1",
                    "bird_count": 1,
                    "duration_ms": 12,
                    "best": detection,
                    "detections": [detection],
                }
            )

        # 全可见 / head 不可见 / pose 缺失 三种 fixture
        cases = [
            ("head_ok.jpg", _make_pose(head_visible=True)),
            ("head_hidden.jpg", _make_pose(head_visible=False)),
            ("no_pose.jpg", None),
            ("manual.jpg", _make_pose(head_visible=False)),
        ]
        async with aiosqlite.connect(tmp / "test.db") as conn:
            for file_name, pose in cases:
                photo = next(p for p in photos if p["file_name"] == file_name)
                await conn.execute(
                    "INSERT INTO analysis_results (id, photo_id, pipeline_version, "
                    "quality_score, grade, bird_count, species, result_json, created_at, "
                    "is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
                    (
                        f"ar-{file_name}",
                        photo["id"],
                        "test-v1",
                        0.76,
                        "select",
                        1,
                        "白鹭",
                        make_result(photo["id"], pose),
                        "2026-04-23T07:00:00+00:00",
                    ),
                )
            await conn.commit()

        # manual.jpg 走人工标注，覆盖 unconfirmed
        manual_photo = next(p for p in photos if p["file_name"] == "manual.jpg")
        override = await client.put(
            f"/decisions/photo/{manual_photo['id']}/species/0",
            json={
                "canonical_sci": "Egretta garzetta",
                "canonical_zh": "白鹭",
                "canonical_en": "Little Egret",
            },
        )
        assert override.status_code == 200

        detail = (await client.get(f"/library/{lib_id}")).json()
        by_name = {p["file_name"]: p for p in detail["photos"]}

        assert by_name["head_ok.jpg"]["species_source"] == "model"
        assert by_name["head_hidden.jpg"]["species_source"] == "model_unconfirmed"
        assert by_name["no_pose.jpg"]["species_source"] == "model_unconfirmed"
        # 人工标注始终覆盖（最高优先级）
        assert by_name["manual.jpg"]["species_source"] == "manual"


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
