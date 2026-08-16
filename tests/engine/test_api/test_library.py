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

    async def test_detail_supports_photo_pagination(self, real_client) -> None:
        client, tmp = real_client
        lib_root = tmp / "lib_detail_paged"
        for name in ("a.jpg", "b.jpg", "c.jpg"):
            _make_jpeg(lib_root / name)
        created = await client.post("/library/import", json={"root_path": str(lib_root)})
        lib_id = created.json()["id"]

        first_page = (await client.get(f"/library/{lib_id}?limit=1&offset=0")).json()
        assert len(first_page["photos"]) == 1
        assert first_page["photo_total"] == 3
        assert first_page["photo_offset"] == 0
        assert first_page["photo_limit"] == 1
        assert first_page["next_offset"] == 1

        last_page = (await client.get(f"/library/{lib_id}?limit=1&offset=2")).json()
        assert len(last_page["photos"]) == 1
        assert last_page["photo_total"] == 3
        assert last_page["photo_offset"] == 2
        assert last_page["next_offset"] is None

    async def test_update_display_name_persists_to_list_and_detail(self, real_client) -> None:
        client, tmp = real_client
        lib_root = tmp / "lib_alias"
        _make_jpeg(lib_root / "p.jpg")
        created = await client.post("/library/import", json={"root_path": str(lib_root)})
        lib_id = created.json()["id"]

        updated = await client.patch(
            f"/library/{lib_id}",
            json={"display_name": "  洋湖湿地早晨  "},
        )
        assert updated.status_code == 200
        assert updated.json()["display_name"] == "洋湖湿地早晨"

        libs = (await client.get("/library")).json()
        assert libs[0]["display_name"] == "洋湖湿地早晨"

        detail = (await client.get(f"/library/{lib_id}")).json()
        assert detail["library"]["display_name"] == "洋湖湿地早晨"

    async def test_update_display_name_rejects_blank_alias(self, real_client) -> None:
        client, tmp = real_client
        lib_root = tmp / "lib_alias_blank"
        _make_jpeg(lib_root / "p.jpg")
        created = await client.post("/library/import", json={"root_path": str(lib_root)})
        lib_id = created.json()["id"]

        updated = await client.patch(f"/library/{lib_id}", json={"display_name": "   "})
        assert updated.status_code == 400
        assert updated.json()["detail"] == "Display name cannot be empty"

    async def test_missing_root_is_reported_as_path_missing(self, real_client) -> None:
        client, tmp = real_client
        lib_root = tmp / "lib_missing_root"
        _make_jpeg(lib_root / "p.jpg")
        created = await client.post("/library/import", json={"root_path": str(lib_root)})
        lib_id = created.json()["id"]

        lib_root.rename(tmp / "lib_missing_root_renamed")

        libs = (await client.get("/library")).json()
        assert libs[0]["id"] == lib_id
        assert libs[0]["status"] == "path_missing"

        detail = (await client.get(f"/library/{lib_id}")).json()
        assert detail["library"]["status"] == "path_missing"
        assert detail["photos"][0]["file_path"].endswith("lib_missing_root/p.jpg")

    async def test_relink_moved_library_preserves_photo_identity(self, real_client) -> None:
        client, tmp = real_client
        lib_root = tmp / "lib_relink"
        _make_jpeg(lib_root / "nested" / "p.jpg")
        created = await client.post("/library/import", json={"root_path": str(lib_root)})
        lib_id = created.json()["id"]
        before = (await client.get(f"/library/{lib_id}")).json()
        photo_id = before["photos"][0]["id"]

        moved_root = tmp / "lib_relink_moved"
        lib_root.rename(moved_root)
        missing = await client.get("/library")
        assert missing.json()[0]["status"] == "path_missing"

        relinked = await client.post(
            f"/library/{lib_id}/relink",
            json={"root_path": str(moved_root)},
        )
        assert relinked.status_code == 200
        payload = relinked.json()
        assert payload["library"]["status"] == "ready"
        assert payload["library"]["root_path"] == str(moved_root)
        assert payload["matched_photos"] == 1

        after = (await client.get(f"/library/{lib_id}")).json()
        assert after["library"]["status"] == "ready"
        assert after["photos"][0]["id"] == photo_id
        assert after["photos"][0]["file_path"] == str(moved_root / "nested" / "p.jpg")

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

    async def test_detection_level_species_source_for_multi_bird_mixed_visibility(
        self,
        real_client,
    ) -> None:
        """多鸟图混合可见性：每个 detection 独立计算 species_source。
        photo-level 由 best detection 决定；非 best detection 按自己的 pose 判断。"""
        client, tmp = real_client
        lib_root = tmp / "lib_multi_bird_mixed"
        _make_jpeg(lib_root / "multi.jpg")
        await client.post("/library/import", json={"root_path": str(lib_root)})

        libs = (await client.get("/library")).json()
        lib_id = libs[0]["id"]
        photo_id = (await client.get(f"/library/{lib_id}")).json()["photos"][0]["id"]

        # detection 0: head 可见 + 高 quality（best） → model
        # detection 1: head 不可见 + 低 quality → model_unconfirmed
        result_json = {
            "photo_id": photo_id,
            "pipeline_version": "test-v1",
            "bird_count": 2,
            "duration_ms": 12,
            "best": None,
            "detections": [
                {
                    "bbox": {"x1": 1, "y1": 2, "x2": 30, "y2": 40, "confidence": 0.9},
                    "quality": {"clipiqa": 0.8, "hyperiqa": 0.85, "combined": 0.83},
                    "grade": "select",
                    "pose": _make_pose(head_visible=True),
                    "species": "白鹭",
                    "species_candidates": [
                        {
                            "canonical_sci": "Egretta garzetta",
                            "canonical_zh": "白鹭",
                            "confidence": 0.91,
                        }
                    ],
                },
                {
                    "bbox": {"x1": 50, "y1": 60, "x2": 90, "y2": 100, "confidence": 0.8},
                    "quality": {"clipiqa": 0.6, "hyperiqa": 0.62, "combined": 0.61},
                    "grade": "usable",
                    "pose": _make_pose(head_visible=False),
                    "species": "苍鹭",
                    "species_candidates": [
                        {
                            "canonical_sci": "Ardea cinerea",
                            "canonical_zh": "苍鹭",
                            "confidence": 0.55,
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
                    "ar-multi-mixed",
                    photo_id,
                    "test-v1",
                    0.83,
                    "select",
                    2,
                    "白鹭",
                    json.dumps(result_json),
                    "2026-04-23T07:00:00+00:00",
                ),
            )
            await conn.commit()

        photo = (await client.get(f"/library/{lib_id}")).json()["photos"][0]
        # photo-level 由 best（detection 0，quality 高）决定
        assert photo["species_source"] == "model"
        assert photo["best_detection"]["species_source"] == "model"
        # detection-level：detection 0 head 可见 → model；
        # detection 1 head 不可见 → model_unconfirmed
        det_by_species = {d["species"]: d for d in photo["detections"]}
        assert det_by_species["白鹭"]["species_source"] == "model"
        assert det_by_species["白鹭"]["is_best"] is True
        assert det_by_species["苍鹭"]["species_source"] == "model_unconfirmed"
        assert det_by_species["苍鹭"]["is_best"] is False

    async def test_group_consensus_upgrades_unconfirmed_when_model_already_agrees(
        self,
        real_client,
    ) -> None:
        """规则 #3：群内共识能"代审"head 不可见的鸟。
        即使模型 top-1 已与共识 winner 一致，head 不可见的单鸟图也应从
        'model_unconfirmed' 升级到 'group_consensus' 才能进羽迹。"""
        client, tmp = real_client
        lib_root = tmp / "lib_unconfirmed_consensus"
        for name in ("a.jpg", "b.jpg", "c.jpg", "d.jpg"):
            _make_jpeg(lib_root / name)
        await client.post("/library/import", json={"root_path": str(lib_root)})

        libs = (await client.get("/library")).json()
        lib_id = libs[0]["id"]
        photos = sorted(
            (await client.get(f"/library/{lib_id}")).json()["photos"],
            key=lambda p: p["file_name"],
        )

        def make_result(photo_id: str, head_visible: bool) -> str:
            detection = {
                "bbox": {"x1": 1, "y1": 2, "x2": 30, "y2": 40, "confidence": 0.9},
                "quality": {"clipiqa": 0.7, "hyperiqa": 0.8, "combined": 0.76},
                "grade": "select",
                "pose": _make_pose(head_visible=head_visible),
                "species": "暗绿绣眼鸟",
                "species_candidates": [
                    {
                        "canonical_sci": "Zosterops simplex",
                        "canonical_zh": "暗绿绣眼鸟",
                        "confidence": 0.92,
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

        # a/b/c head 可见，d head 不可见；4 张都识别同一物种 → 共识达成 winner = 该物种
        cases = [("a.jpg", True), ("b.jpg", True), ("c.jpg", True), ("d.jpg", False)]
        async with aiosqlite.connect(tmp / "test.db") as conn:
            for index, (file_name, head_visible) in enumerate(cases):
                photo = next(p for p in photos if p["file_name"] == file_name)
                await conn.execute(
                    "UPDATE photos SET scene_id = ?, file_mtime = ? WHERE id = ?",
                    (0, f"2026-04-23T07:00:0{index}+00:00", photo["id"]),
                )
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
                        "暗绿绣眼鸟",
                        make_result(photo["id"], head_visible),
                        "2026-04-23T07:00:00+00:00",
                    ),
                )
            await conn.commit()

        detail = (await client.get(f"/library/{lib_id}")).json()
        by_name = {p["file_name"]: p for p in detail["photos"]}

        # head 可见的 a 走普通 model 分支
        assert by_name["a.jpg"]["species_source"] == "model"
        # head 不可见的 d 在共识"代审"下从 model_unconfirmed 升级为 group_consensus，
        # 即使模型 top-1（暗绿绣眼鸟）已经与 winner 一致
        assert by_name["d.jpg"]["species_source"] == "group_consensus"
        assert by_name["d.jpg"]["group_species_latin"] == "Zosterops simplex"

        paged = (await client.get(f"/library/{lib_id}?limit=1&offset=3")).json()
        assert [p["file_name"] for p in paged["photos"]] == ["d.jpg"]
        assert paged["photos"][0]["species_source"] == "group_consensus"
        assert paged["photos"][0]["group_species_latin"] == "Zosterops simplex"

    async def test_v4_uncertain_candidate_is_promoted_by_group_consensus(
        self,
        real_client,
    ) -> None:
        """v4 uncertain 单张待审，但可信组内共识可以覆盖并计入羽迹。"""
        client, tmp = real_client
        lib_root = tmp / "lib_uncertain_consensus"
        for name in ("a.jpg", "b.jpg", "c.jpg", "d.jpg"):
            _make_jpeg(lib_root / name)
        await client.post("/library/import", json={"root_path": str(lib_root)})

        libs = (await client.get("/library")).json()
        lib_id = libs[0]["id"]
        photos = sorted(
            (await client.get(f"/library/{lib_id}")).json()["photos"],
            key=lambda p: p["file_name"],
        )

        def make_result(photo_id: str, state: str) -> str:
            detection = {
                "bbox": {"x1": 1, "y1": 2, "x2": 30, "y2": 40, "confidence": 0.9},
                "quality": {"clipiqa": 0.7, "hyperiqa": 0.8, "combined": 0.76},
                "grade": "select",
                "pose": _make_pose(head_visible=True),
                "species": "暗绿绣眼鸟" if state == "recognized" else None,
                "species_candidates": [
                    {
                        "canonical_sci": "Zosterops simplex",
                        "canonical_zh": "暗绿绣眼鸟",
                        "confidence": 0.92 if state == "recognized" else 0.38,
                        "recognition_state": state,
                        "reject_score": 0.12 if state == "recognized" else 0.71,
                        "top1_top2_margin": 0.22 if state == "recognized" else 0.04,
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

        cases = [
            ("a.jpg", "recognized"),
            ("b.jpg", "recognized"),
            ("c.jpg", "recognized"),
            ("d.jpg", "uncertain"),
        ]
        async with aiosqlite.connect(tmp / "test.db") as conn:
            for index, (file_name, state) in enumerate(cases):
                photo = next(p for p in photos if p["file_name"] == file_name)
                row_species = "暗绿绣眼鸟" if state == "recognized" else None
                await conn.execute(
                    "UPDATE photos SET scene_id = ?, file_mtime = ? WHERE id = ?",
                    (0, f"2026-04-23T07:00:0{index}+00:00", photo["id"]),
                )
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
                        row_species,
                        make_result(photo["id"], state),
                        "2026-04-23T07:00:00+00:00",
                    ),
                )
            await conn.commit()

        detail = (await client.get(f"/library/{lib_id}")).json()
        by_name = {p["file_name"]: p for p in detail["photos"]}

        assert by_name["a.jpg"]["species_source"] == "model"
        assert by_name["d.jpg"]["species_source"] == "group_consensus"
        assert by_name["d.jpg"]["best_detection"]["species_source"] == "group_consensus"
        assert by_name["d.jpg"]["species_latin"] == "Zosterops simplex"
        assert by_name["d.jpg"]["group_species_latin"] == "Zosterops simplex"
        assert by_name["d.jpg"]["group_species_evidence"] == 3

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
            for index, (file_name, pose) in enumerate(cases):
                photo = next(p for p in photos if p["file_name"] == file_name)
                # 每张 photo 给独立 scene_id，避免 group consensus 干扰 species_source
                # 计算（_apply_group_species_consensus 要求组内 ≥ 3 张才触发；单张组直接跳过）
                await conn.execute(
                    "UPDATE photos SET scene_id = ? WHERE id = ?",
                    (100 + index, photo["id"]),
                )
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

    async def test_delete_removes_thumbnail_cache_files(self, real_client) -> None:
        """删库要连缩略图一起清 —— DB 行被 CASCADE 带走后就再没人能定位这些文件。

        实测用户的 derived/thumbnails 已经涨到 3.2 GB,漏清就是永久泄漏。
        """
        from engine.services.thumbnail import thumbnail_cache_root

        client, tmp = real_client
        lib_root = tmp / "lib_thumbs"
        _make_jpeg(lib_root / "x.jpg")
        created = await client.post("/library/import", json={"root_path": str(lib_root)})
        lib_id = created.json()["id"]

        detail = await client.get(f"/library/{lib_id}")
        photo_ids = [photo["id"] for photo in detail.json()["photos"]]
        assert photo_ids

        # 造出缓存文件(import 的后台缩略图任务在测试里不保证跑完)
        cache_root = thumbnail_cache_root(tmp)
        made: list[Path] = []
        for photo_id in photo_ids:
            for kind in ("grid", "preview"):
                path = cache_root / kind / f"{photo_id}.jpg"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"thumb")
                made.append(path)
        assert all(path.exists() for path in made)

        assert (await client.delete(f"/library/{lib_id}")).status_code == 204

        assert not any(path.exists() for path in made), "缩略图应随图库一并清理"


# ---------- Pure-function tests for species override matching helpers ----------
# 这些是 stable manual species 的核心匹配逻辑（v6 schema bbox-based）— 不走 DB,
# 直接测函数。保护后续 pipeline_version bump 重排 detections 时 manual 标注归属
# 不会错配到另一只鸟。


def _det(index: int, x1: float, y1: float, x2: float, y2: float) -> dict:
    """detections_raw 里一个 detection 的最小 shape — 只用 bbox 字段。"""
    return {
        "index": index,
        "bbox": {"x1": x1, "y1": y1, "x2": x2, "y2": y2, "confidence": 0.9},
    }


def _ov(
    bird_index: int,
    sci: str,
    bbox: tuple[float, float, float, float] | None,
) -> dict:
    """SpeciesOverrideRecord 最小 shape。"""
    return {
        "bird_index": bird_index,
        "canonical_sci": sci,
        "canonical_zh": None,
        "canonical_en": None,
        "bbox": bbox,
    }


class TestMatchOverridesToDetections:
    """`_match_overrides_to_detections` 的纯函数单元测试。

    保护点：v6 schema 引入 bbox 后,manual species 的归属必须随鸟稳定 —
    pipeline_version bump 后 detections 数组重排,标注不应错配到另一只鸟。
    """

    def test_iou_above_threshold_matches(self) -> None:
        from engine.api.routes.library import _match_overrides_to_detections

        detections = [_det(0, 100, 100, 200, 200)]
        overrides = [_ov(0, "Sp.A", (100, 100, 200, 200))]  # IoU = 1.0

        matched = _match_overrides_to_detections(detections, overrides)

        assert 0 in matched
        assert matched[0]["canonical_sci"] == "Sp.A"

    def test_iou_below_threshold_silent_ignores(self) -> None:
        """新数据(bbox 不为 NULL)未匹配上 → silent 忽略,不 fallback 到 bird_index。
        这是核心约束 — bird_index 不再可信,宁可丢标注也不错配到另一只鸟。"""
        from engine.api.routes.library import _match_overrides_to_detections

        # 新轮检测的 bbox 与 override 的 bbox 完全不重叠
        detections = [_det(0, 0, 0, 100, 100)]
        overrides = [_ov(0, "Sp.A", (500, 500, 600, 600))]  # IoU = 0

        matched = _match_overrides_to_detections(detections, overrides)

        assert matched == {}, "新数据 bbox 不匹配应 silent 忽略,而非 fallback 到 bird_index"

    def test_bbox_match_wins_over_reordering(self) -> None:
        """detections 重排后,override 应跟着 bbox 走,不被 bird_index 锚住。

        scenario：
          v1 detections: [鸟A@左, 鸟B@右]，用户给 bird_index=0 (鸟A) 标了 Sp.A
          v2 detections: [鸟B@右, 鸟A@左]  ← 顺序反过来
          预期：override 应该匹配到 v2 的 detection_index=1（鸟A 还在原位），
                而不是 detection_index=0（鸟B）。
        """
        from engine.api.routes.library import _match_overrides_to_detections

        # v2 detections：鸟 B 在 idx=0，鸟 A 在 idx=1
        detections = [
            _det(0, 500, 100, 600, 200),  # 鸟 B
            _det(1, 100, 100, 200, 200),  # 鸟 A（跟 v1 同位置）
        ]
        # override 写入时是 v1 — bird_index=0,bbox 在鸟 A 位置
        overrides = [_ov(0, "Sp.A", (100, 100, 200, 200))]

        matched = _match_overrides_to_detections(detections, overrides)

        assert 1 in matched, "override 应跟 bbox 匹配到鸟 A 的新位置 (idx=1)"
        assert 0 not in matched, "鸟 B 不应被错配为 Sp.A"
        assert matched[1]["canonical_sci"] == "Sp.A"

    def test_greedy_one_to_one(self) -> None:
        """单个 override 只能匹配到一个 detection — 不会重复锚到多只鸟。"""
        from engine.api.routes.library import _match_overrides_to_detections

        detections = [
            _det(0, 100, 100, 200, 200),
            _det(1, 110, 110, 210, 210),  # 跟 idx 0 高度重叠
        ]
        overrides = [_ov(0, "Sp.A", (100, 100, 200, 200))]

        matched = _match_overrides_to_detections(detections, overrides)

        # 第一个 detection 占走了 override,第二个 detection 拿不到
        assert 0 in matched
        assert 1 not in matched
        assert len(matched) == 1

    def test_old_data_fallback_by_bird_index(self) -> None:
        """v5 老数据(bbox=NULL)按 bird_index 直接匹配 — 兼容性。"""
        from engine.api.routes.library import _match_overrides_to_detections

        detections = [
            _det(0, 100, 100, 200, 200),
            _det(1, 500, 500, 600, 600),
        ]
        overrides = [_ov(1, "Sp.B", None)]  # bbox=None → 老数据

        matched = _match_overrides_to_detections(detections, overrides)

        assert matched.get(1, {}).get("canonical_sci") == "Sp.B"

    def test_old_data_fallback_out_of_range_silent_ignores(self) -> None:
        """老数据 bird_index 越界(detections 缩减后)→ silent 忽略,不崩。"""
        from engine.api.routes.library import _match_overrides_to_detections

        detections = [_det(0, 100, 100, 200, 200)]
        overrides = [_ov(5, "Sp.X", None)]  # bird_index=5 越界

        matched = _match_overrides_to_detections(detections, overrides)

        assert matched == {}

    def test_old_data_fallback_respects_iou_taken_slot(self) -> None:
        """新 override 已用 IoU 占走某个 detection_index → 老 override 不再覆盖该 slot。

        scenario：detection 0 + 1，override A (bbox→idx 0)，override B (bird_index=0,bbox=None)。
        预期：A 占住 idx=0；B 老 fallback 看到 0 已被占,silent 忽略。
        """
        from engine.api.routes.library import _match_overrides_to_detections

        detections = [
            _det(0, 100, 100, 200, 200),
            _det(1, 500, 500, 600, 600),
        ]
        overrides = [
            _ov(0, "Sp.A", (100, 100, 200, 200)),  # IoU 占 idx 0
            _ov(0, "Sp.OLD", None),  # 老数据 bird_index=0,但 idx 0 已被占
        ]

        matched = _match_overrides_to_detections(detections, overrides)

        assert matched[0]["canonical_sci"] == "Sp.A"
        assert 1 not in matched

    def test_empty_inputs(self) -> None:
        from engine.api.routes.library import _match_overrides_to_detections

        assert _match_overrides_to_detections([], []) == {}
        assert _match_overrides_to_detections([_det(0, 0, 0, 100, 100)], []) == {}
        assert _match_overrides_to_detections([], [_ov(0, "X", None)]) == {}

    def test_detection_missing_bbox_skipped_no_crash(self) -> None:
        """detection_raw 没有 bbox 字段（早期数据 / 异常 row）→ 不该崩,仅跳过该 detection。"""
        from engine.api.routes.library import _match_overrides_to_detections

        detections = [{"index": 0}]  # 没 bbox 字段
        overrides = [_ov(0, "Sp.A", (100, 100, 200, 200))]

        # 不应抛 — 该 detection 被跳过,override 也不会匹配上 (silent)
        matched = _match_overrides_to_detections(detections, overrides)
        assert matched == {}


class TestIouTuple:
    """`_iou_tuple` 几何正确性 — 匹配阈值算对了才有意义。"""

    def test_identical_boxes_iou_one(self) -> None:
        from engine.api.routes.library import _iou_tuple

        assert _iou_tuple((0, 0, 100, 100), (0, 0, 100, 100)) == 1.0

    def test_disjoint_boxes_iou_zero(self) -> None:
        from engine.api.routes.library import _iou_tuple

        assert _iou_tuple((0, 0, 100, 100), (200, 200, 300, 300)) == 0.0

    def test_half_overlap(self) -> None:
        from engine.api.routes.library import _iou_tuple

        # 100x100 + 100x100，重叠 50x100；union = 100²+100²-50·100=15000；IoU=5000/15000≈0.333
        iou = _iou_tuple((0, 0, 100, 100), (50, 0, 150, 100))
        assert abs(iou - (5000.0 / 15000.0)) < 1e-6

    def test_zero_area_box_no_crash(self) -> None:
        """退化 box (零面积) → IoU=0,不抛 ZeroDivision。"""
        from engine.api.routes.library import _iou_tuple

        assert _iou_tuple((10, 10, 10, 10), (0, 0, 100, 100)) == 0.0
