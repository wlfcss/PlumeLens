"""Tests for /archive geo aggregation."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from httpx import ASGITransport, AsyncClient


def _gps(lat_sec: int = 0, lon_sec: int = 0) -> str:
    return json.dumps(
        {
            "GPSInfo": {
                "GPSLatitudeRef": "N",
                "GPSLatitude": [31, 14, lat_sec],
                "GPSLongitudeRef": "E",
                "GPSLongitude": [121, 28, lon_sec],
            }
        }
    )


def _gps_rational() -> str:
    return json.dumps(
        {
            "GPSInfo": {
                "GPSLatitudeRef": "S",
                "GPSLatitude": [[31, 1], [14, 1], [30, 1]],
                "GPSLongitudeRef": "W",
                "GPSLongitude": [
                    {"numerator": 121, "denominator": 1},
                    {"numerator": 28, "denominator": 1},
                    {"numerator": 15, "denominator": 1},
                ],
            }
        }
    )


def _pose(head_visible: bool) -> dict:
    kp = {"x": 10.0, "y": 10.0, "confidence": 0.9}
    return {
        "bill": kp,
        "crown": kp,
        "nape": kp,
        "left_eye": kp,
        "right_eye": kp,
        "head_visible": head_visible,
        "eye_visible": head_visible,
    }


def _result(species: str, sci: str, *, head_visible: bool = True, score: float = 0.8) -> str:
    return json.dumps(
        {
            "detections": [
                {
                    "bbox": {"x1": 10, "y1": 20, "x2": 110, "y2": 120, "confidence": 0.9},
                    "pose": _pose(head_visible),
                    "quality": {"clipiqa": score, "hyperiqa": score, "combined": score},
                    "grade": "select",
                    "species": species,
                    "species_candidates": [
                        {
                            "canonical_sci": sci,
                            "canonical_zh": species,
                            "canonical_en": None,
                            "confidence": score,
                        }
                    ],
                }
            ],
            "best": None,
            "bird_count": 1,
        }
    )


@pytest.fixture
async def archive_client(tmp_path: Path):
    from engine.core.config import settings
    from engine.core.database import Database
    from engine.main import create_app

    settings.data_dir = tmp_path
    app = create_app()
    db = Database(tmp_path / "archive.db")
    await db.connect()
    app.state.db = db
    app.state.pipeline = MagicMock()

    await db.conn.execute(
        "INSERT INTO libraries "
        "(id, display_name, parent_path, root_path, created_at, last_opened_at) "
        "VALUES "
        "('lib-archive', 'Archive', '/tmp', '/tmp/archive', '2026-04-24', '2026-04-24')"
    )
    photos = [
        ("p1", "keep.jpg", "select", "须浮鸥", "Chlidonias hybrida", True, None),
        ("p2", "reject.jpg", "reject", "白鹭", "Egretta garzetta", True, None),
        ("p3", "hidden.jpg", "select", "苍鹭", "Ardea cinerea", False, None),
        ("p4", "manual.jpg", "select", "苍鹭", "Ardea cinerea", False, "Zosterops simplex"),
    ]
    for idx, (pid, name, grade, species, sci, head_visible, _override) in enumerate(photos):
        await db.conn.execute(
            "INSERT INTO photos (id, file_path, file_name, file_size, file_mtime, file_hash, "
            "exif_json, country, province, city, place, created_at, library_id) "
            "VALUES (?, ?, ?, 100, ?, ?, ?, "
            "'中国', '上海市', '上海市', '测试湿地', ?, 'lib-archive')",
            (
                pid,
                f"/tmp/archive/{name}",
                name,
                f"2026-04-24T00:0{idx}:00",
                f"hash-{pid}",
                _gps(idx, idx),
                "2026-04-24",
            ),
        )
        await db.conn.execute(
            "INSERT INTO analysis_results (id, photo_id, pipeline_version, result_json, "
            "quality_score, grade, bird_count, species, created_at, is_active) "
            "VALUES (?, ?, 'v1', ?, 0.8, ?, 1, ?, '2026-04-24', 1)",
            (f"ar-{pid}", pid, _result(species, sci, head_visible=head_visible), grade, species),
        )
    await db.conn.execute(
        "INSERT INTO photos (id, file_path, file_name, file_size, file_mtime, file_hash, "
        "exif_json, created_at, library_id) "
        "VALUES ('p-empty-gps', '/tmp/archive/empty-gps.jpg', 'empty-gps.jpg', 100, "
        "'2026-04-24T00:10:00', 'hash-empty-gps', ?, '2026-04-24', 'lib-archive')",
        (json.dumps({"GPSInfo": {"GPSVersionID": "\u0002\u0003", "GPSSatellites": ""}}),),
    )
    await db.conn.execute(
        "INSERT INTO photos (id, file_path, file_name, file_size, file_mtime, file_hash, "
        "exif_json, created_at, library_id) "
        "VALUES ('p-no-gps', '/tmp/archive/no-gps.jpg', 'no-gps.jpg', 100, "
        "'2026-04-24T00:11:00', 'hash-no-gps', ?, '2026-04-24', 'lib-archive')",
        (json.dumps({"Make": "Canon"}),),
    )
    await db.conn.execute(
        "INSERT INTO photo_species_overrides (photo_id, bird_index, canonical_sci, canonical_zh, "
        "canonical_en, bbox_x1, bbox_y1, bbox_x2, bbox_y2, updated_at) "
        "VALUES ('p4', 0, 'Zosterops simplex', '暗绿绣眼鸟', 'Swinhoe''s white-eye', "
        "10, 20, 110, 120, '2026-04-24')"
    )
    await db.conn.commit()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
    await db.close()


async def test_geo_counts_only_archive_eligible_effective_species(
    archive_client: AsyncClient,
) -> None:
    provinces = (await archive_client.get("/archive/geo/provinces")).json()
    assert provinces == [{"province": "上海市", "photo_count": 2, "species_count": 2}]

    spots = (await archive_client.get("/archive/geo/spots?province=上海市&city=上海市")).json()
    # Same physical place should merge even when photos were taken at slightly
    # different GPS coordinates inside that place.
    assert len(spots) == 1
    assert spots[0]["place"] == "测试湿地"
    assert spots[0]["photo_count"] == 2
    assert spots[0]["species_count"] == 2
    species = {item["latin_name"] for spot in spots for item in spot["species"]}
    assert species == {"Chlidonias hybrida", "Zosterops simplex"}


async def test_geo_summary_ignores_empty_gps_container(
    archive_client: AsyncClient,
) -> None:
    summary = (await archive_client.get("/archive/geo/summary")).json()
    assert summary == {
        "total_with_gps": 4,
        "resolved": 4,
        "pending": 0,
        "photos_without_gps": 2,
    }


def test_archive_gps_parser_accepts_exif_rationals() -> None:
    from engine.api.routes.archive import _gps_from_exif

    coords = _gps_from_exif(_gps_rational())

    assert coords is not None
    assert coords[0] == pytest.approx(-31.2416666667)
    assert coords[1] == pytest.approx(-121.4708333333)
