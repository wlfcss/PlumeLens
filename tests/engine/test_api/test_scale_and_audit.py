"""Regression tests for Item 3 (compact-v1, pagination, batch hydration) and audit fixes."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import httpx
import pytest
from engine.core.database import Database
from engine.main import create_app
from engine.services.decisions import list_species_overrides, set_species_override
from engine.services.exporter import _unique_dest
from engine.services.library_summary import normalize_root_prefix
from engine.services.selection import SelectionProjectionCache
from PIL import Image


def _create_fixture_images(root: Path, count: int) -> list[Path]:
    root.mkdir(parents=True, exist_ok=True)
    paths: list[Path] = []
    for i in range(count):
        img_path = root / f"IMG_{i:04d}.JPG"
        Image.new("RGB", (64, 48), "gray").save(img_path)
        paths.append(img_path)
    return paths


async def _make_client(tmp_path: Path):
    db = Database(tmp_path / "audit.db")
    await db.connect()
    app = create_app()
    app.state.db = db
    app.state.pipeline = MagicMock(is_ready=False, pipeline_version="v-test")
    app.state.selection_projections = SelectionProjectionCache()
    transport = httpx.ASGITransport(app=app)
    client = httpx.AsyncClient(transport=transport, base_url="http://test")
    return client, db, app


async def _seed_library_photos(db: Database, root: Path, count: int = 5) -> None:
    image_paths = _create_fixture_images(root, count)
    async with db.transaction() as conn:
        await conn.execute(
            "INSERT INTO libraries (id, display_name, parent_path, root_path, status, "
            "created_at, last_opened_at) VALUES (?,?,?,?,?,?,?)",
            ("lib-1", "Test", str(root.parent), str(root), "ready", "2026-11-20", "2026-11-20"),
        )
        for i, img_path in enumerate(image_paths):
            pid = f"p{i}"
            await conn.execute(
                "INSERT INTO photos (id, file_path, file_name, file_size, file_mtime, format, "
                "width, height, scene_id, created_at, library_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    pid,
                    str(img_path),
                    img_path.name,
                    1024,
                    f"2026-11-20T08:0{i}:00",
                    "JPG",
                    64,
                    48,
                    1,
                    f"2026-11-20T08:0{i}:00",
                    "lib-1",
                ),
            )
            det = {
                "index": 0,
                "bbox": {"x1": 10.0, "y1": 10.0, "x2": 50.0, "y2": 40.0, "confidence": 0.92},
                "pose": {
                    "head_visible": True,
                    "eye_visible": True,
                    "body_visible": True,
                    "tail_visible": False,
                    "wings_visible": False,
                    "view_angle": "side",
                    "facing": "left",
                    "posture": "perched",
                    "posture_confidence": 0.9,
                    "posture_method": "classifier",
                },
                "quality": {"clipiqa": 0.8, "hyperiqa": 0.82, "combined": 0.81},
                "species": "普通翠鸟",
                "species_latin": "Alcedo atthis",
                "species_english": "Common Kingfisher",
                "species_candidates": [
                    {
                        "canonical_zh": "普通翠鸟",
                        "canonical_sci": "Alcedo atthis",
                        "canonical_en": "Common Kingfisher",
                        "confidence": 0.96,
                        "recognition_state": "recognized",
                    }
                ],
                "is_best": True,
            }
            payload = {
                "photo_id": pid,
                "bird_count": 1,
                "grade": "select",
                "quality_score": 0.81 - i * 0.01,
                "species": "普通翠鸟",
                "species_latin": "Alcedo atthis",
                "best_detection": det,
                "detections": [det],
            }
            await conn.execute(
                "INSERT INTO analysis_results (id, photo_id, pipeline_version, is_active, "
                "grade, quality_score, bird_count, species, result_json, created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    f"ar-{i}",
                    pid,
                    "v-test",
                    1,
                    "select",
                    0.81 - i * 0.01,
                    1,
                    "普通翠鸟",
                    json.dumps(payload),
                    "2026-11-20T08:10:00",
                ),
            )


@pytest.mark.asyncio
async def test_compact_v1_streaming_and_budget_headers(tmp_path: Path, monkeypatch) -> None:
    from engine.api.routes import library

    client, db, _app = await _make_client(tmp_path)
    try:
        root = tmp_path / "photos"
        await _seed_library_photos(db, root, count=5)
        monkeypatch.setattr(library, "_SUMMARY_STREAM_THRESHOLD", 1)
        monkeypatch.setattr(library, "_SUMMARY_ROWS_PER_CHUNK", 2)

        res = await client.get(
            "/library/lib-1?view=summary&include_selection_snapshot=true&summary_format=compact-v1",
            headers={"Accept": "application/x-ndjson"},
        )
        assert res.status_code == 200
        assert res.headers["content-type"] == "application/x-ndjson"
        assert "x-plumelens-projection-ms" in res.headers
        assert res.headers["x-plumelens-photo-count"] == "5"
        payload_bytes = int(res.headers["x-plumelens-payload-bytes"])

        legacy = await client.get(
            "/library/lib-1?view=summary&include_selection_snapshot=true",
            headers={"Accept": "application/x-ndjson"},
        )
        assert legacy.status_code == 200
        legacy_bytes = int(legacy.headers["x-plumelens-payload-bytes"])
        assert payload_bytes < legacy_bytes

        lines = res.text.splitlines()
        legacy_lines = legacy.text.splitlines()
        row_bytes = sum(len(line.encode("utf-8")) for line in lines[1:-1])
        legacy_row_bytes = sum(len(line.encode("utf-8")) for line in legacy_lines[1:-1])
        # Compact-v1 removes best_detection duplication, root prefix, and null/default keys.
        assert row_bytes < legacy_row_bytes * 0.75

        frames = [json.loads(line) for line in lines]
        header = frames[0]
        rows = [row for chunk in frames[1:-1] for row in chunk]
        assert header["summary_format"] == "compact-v1"
        assert frames[-1] == 5
        assert len(rows) == 5
        # Path prefix stripped and redundant top-level best_detection omitted.
        assert "rel_path" in rows[0] and "file_path" not in rows[0]
        assert "best_detection" not in rows[0]
        assert rows[0]["rel_path"].startswith("IMG_")
        assert normalize_root_prefix(str(root)).endswith("/")
    finally:
        await client.aclose()
        await db.close()


@pytest.mark.asyncio
async def test_selection_query_pagination_and_photo_batch(tmp_path: Path) -> None:
    client, db, _app = await _make_client(tmp_path)
    try:
        await _seed_library_photos(db, tmp_path / "photos", count=5)
        detail = (
            await client.get("/library/lib-1?view=summary&include_selection_snapshot=true")
        ).json()
        rev = detail["projection_revision"]

        page1 = (
            await client.post(
                f"/library/lib-1/selection/query?projection_revision={rev}&limit=2&offset=0",
                json={"sort": "score"},
            )
        ).json()
        assert page1["matched_count"] == 5
        assert len(page1["matched_photo_ids"]) == 2
        assert page1["offset"] == 0
        assert page1["limit"] == 2
        assert page1["next_offset"] == 2

        page3 = (
            await client.post(
                f"/library/lib-1/selection/query?projection_revision={rev}&limit=2&offset=4",
                json={"sort": "score"},
            )
        ).json()
        assert len(page3["matched_photo_ids"]) == 1
        assert page3["next_offset"] is None

        batch = await client.post(
            f"/library/lib-1/photos/batch?projection_revision={rev}",
            json={"photo_ids": page1["matched_photo_ids"], "view": "summary"},
        )
        assert batch.status_code == 200
        assert [p["id"] for p in batch.json()["photos"]] == page1["matched_photo_ids"]

        stale = await client.post(
            "/library/lib-1/photos/batch?projection_revision=" + "0" * 64,
            json={"photo_ids": ["p0"]},
        )
        assert stale.status_code == 409
    finally:
        await client.aclose()
        await db.close()


@pytest.mark.asyncio
async def test_clear_history_clears_selection_projection_cache(tmp_path: Path) -> None:
    client, db, app = await _make_client(tmp_path)
    try:
        await _seed_library_photos(db, tmp_path / "photos", count=2)
        res = await client.get("/library/lib-1?view=summary&include_selection_snapshot=true")
        assert res.status_code == 200
        rev = res.json()["projection_revision"]
        assert app.state.selection_projections.get("lib-1", rev) is not None

        cleared = await client.post("/settings/history/clear", json={"confirm": True})
        assert cleared.status_code == 200
        assert app.state.selection_projections.get("lib-1", rev) is None
    finally:
        await client.aclose()
        await db.close()


@pytest.mark.asyncio
async def test_species_override_reorder_preserves_other_bird(tmp_path: Path) -> None:
    db = Database(tmp_path / "overrides.db")
    await db.connect()
    try:
        await _seed_library_photos(db, tmp_path / "photos", count=1)
        # Bird A at left gets override at bird_index=0
        await set_species_override(
            db,
            "p0",
            0,
            {"canonical_sci": "Alcedo atthis", "canonical_zh": "普通翠鸟", "canonical_en": None},
            bbox=(10.0, 10.0, 50.0, 50.0),
        )
        # After reorder, Bird B (disjoint bbox) is at index 0; clearing it must keep Bird A.
        await set_species_override(db, "p0", 0, None, bbox=(300.0, 300.0, 400.0, 400.0))
        overrides = await list_species_overrides(db, "lib-1")
        assert len(overrides["p0"]) == 1
        assert overrides["p0"][0]["canonical_sci"] == "Alcedo atthis"

        # Writing Bird B at index 0 must allocate a fresh bird_index instead of overwriting Bird A
        await set_species_override(
            db,
            "p0",
            0,
            {"canonical_sci": "Ardea alba", "canonical_zh": "大白鹭", "canonical_en": None},
            bbox=(300.0, 300.0, 400.0, 400.0),
        )
        overrides = await list_species_overrides(db, "lib-1")
        assert len(overrides["p0"]) == 2
        assert {o["canonical_sci"] for o in overrides["p0"]} == {"Alcedo atthis", "Ardea alba"}
    finally:
        await db.close()


def test_unique_dest_avoids_quadratic_suffixes(tmp_path: Path) -> None:
    (tmp_path / "IMG_0001.JPG").write_bytes(b"a")
    (tmp_path / "IMG_0001-1.JPG").write_bytes(b"b")
    (tmp_path / "IMG_0001-2.JPG").write_bytes(b"c")
    used: set[Path] = set()
    candidate = _unique_dest(tmp_path, Path("IMG_0001.JPG"), used)
    assert candidate.name == "IMG_0001-3.JPG"
    assert Path("IMG_0001-3.JPG") in used
