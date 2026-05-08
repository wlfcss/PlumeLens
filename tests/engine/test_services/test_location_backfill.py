"""Tests for GPS location backfill filtering."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from engine.core.database import Database


@pytest.fixture
async def db(tmp_path: Path) -> Database:
    database = Database(tmp_path / "location.db")
    await database.connect()
    await database.conn.execute(
        "INSERT INTO libraries (id, display_name, parent_path, root_path, "
        "created_at, last_opened_at) VALUES "
        "('lib-location', 'Location', '/tmp', '/tmp/location', '2026-04-24', '2026-04-24')"
    )
    yield database
    await database.close()


async def _insert_photo(db: Database, photo_id: str, exif: dict[str, Any]) -> None:
    await db.conn.execute(
        "INSERT INTO photos (id, file_path, file_name, file_size, file_mtime, file_hash, "
        "exif_json, created_at, library_id) "
        "VALUES (?, ?, ?, 100, '2026-04-24', ?, ?, '2026-04-24', 'lib-location')",
        (
            photo_id,
            f"/tmp/location/{photo_id}.jpg",
            f"{photo_id}.jpg",
            f"hash-{photo_id}",
            json.dumps(exif),
        ),
    )


async def test_location_backfill_ignores_empty_gps_container(
    db: Database,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from engine.services import location_backfill

    calls: list[tuple[float, float, str]] = []

    async def fake_reverse(lat: float, lon: float, lang: str) -> dict[str, object] | None:
        calls.append((lat, lon, lang))
        return {"display_name": "中国上海市浦东新区世纪公园", "source": "test"}

    monkeypatch.setattr(location_backfill, "reverse", fake_reverse)

    await _insert_photo(
        db,
        "empty-gps",
        {"GPSInfo": {"GPSVersionID": "\u0002\u0003", "GPSSatellites": ""}},
    )
    await _insert_photo(
        db,
        "valid-gps",
        {
            "GPSInfo": {
                "GPSLatitudeRef": "N",
                "GPSLatitude": [31, 14, 0],
                "GPSLongitudeRef": "E",
                "GPSLongitude": [121, 28, 0],
            }
        },
    )
    await db.conn.commit()

    result = await location_backfill.backfill_library_locations(db, "lib-location")

    assert result == {"total": 1, "filled": 1, "skipped": 0, "unresolved": 0}
    assert len(calls) == 1
    async with db.conn.execute(
        "SELECT id, country FROM photos ORDER BY id",
    ) as cur:
        rows = await cur.fetchall()
    assert [(row["id"], row["country"]) for row in rows] == [
        ("empty-gps", None),
        ("valid-gps", "中国"),
    ]


async def test_location_backfill_marks_unresolved_gps_once(
    db: Database,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from engine.services import location_backfill
    from engine.services.geo_constants import UNRESOLVED_COUNTRY

    calls: list[tuple[float, float, str]] = []

    async def fake_reverse(lat: float, lon: float, lang: str) -> dict[str, object] | None:
        calls.append((lat, lon, lang))
        return None

    monkeypatch.setattr(location_backfill, "reverse", fake_reverse)

    await _insert_photo(
        db,
        "unresolved-gps",
        {
            "GPSInfo": {
                "GPSLatitudeRef": "N",
                "GPSLatitude": [31, 14, 0],
                "GPSLongitudeRef": "E",
                "GPSLongitude": [121, 28, 0],
            }
        },
    )
    await db.conn.commit()

    first = await location_backfill.backfill_library_locations(db, "lib-location")
    second = await location_backfill.backfill_library_locations(db, "lib-location")

    assert first == {"total": 1, "filled": 0, "skipped": 0, "unresolved": 1}
    assert second == {"total": 0, "filled": 0, "skipped": 0, "unresolved": 0}
    assert len(calls) == 1
    async with db.conn.execute("SELECT country FROM photos WHERE id = 'unresolved-gps'") as cur:
        row = await cur.fetchone()
    assert row["country"] == UNRESOLVED_COUNTRY


def test_location_gps_parser_accepts_exif_rationals() -> None:
    from engine.services.location_backfill import _parse_gps_from_exif

    coords = _parse_gps_from_exif(
        json.dumps(
            {
                "GPSInfo": {
                    "GPSLatitudeRef": "N",
                    "GPSLatitude": [
                        {"numerator": 31, "denominator": 1},
                        {"numerator": 14, "denominator": 1},
                        {"numerator": 30, "denominator": 1},
                    ],
                    "GPSLongitudeRef": "E",
                    "GPSLongitude": [[121, 1], [28, 1], [15, 1]],
                }
            }
        )
    )

    assert coords is not None
    assert coords[0] == pytest.approx(31.2416666667)
    assert coords[1] == pytest.approx(121.4708333333)


def test_location_gps_parser_rejects_missing_refs() -> None:
    from engine.services.location_backfill import _parse_gps_from_exif

    coords = _parse_gps_from_exif(
        json.dumps(
            {
                "GPSInfo": {
                    "GPSLatitude": [31, 14, 30],
                    "GPSLongitude": [121, 28, 15],
                }
            }
        )
    )

    assert coords is None


async def test_location_backfill_marks_broken_gps_once(db: Database) -> None:
    from engine.services import location_backfill
    from engine.services.geo_constants import UNRESOLVED_COUNTRY

    await _insert_photo(
        db,
        "broken-gps",
        {
            "GPSInfo": {
                "GPSLatitude": [31, 14, 30],
                "GPSLongitude": [121, 28, 15],
            }
        },
    )
    await db.conn.commit()

    first = await location_backfill.backfill_library_locations(db, "lib-location")
    second = await location_backfill.backfill_library_locations(db, "lib-location")

    assert first == {"total": 1, "filled": 0, "skipped": 0, "unresolved": 1}
    assert second == {"total": 0, "filled": 0, "skipped": 0, "unresolved": 0}
    async with db.conn.execute("SELECT country FROM photos WHERE id = 'broken-gps'") as cur:
        row = await cur.fetchone()
    assert row["country"] == UNRESOLVED_COUNTRY
