from __future__ import annotations

import json


def test_scene_sort_prefers_exif_datetime_original_over_file_mtime() -> None:
    from engine.services.scene_grouper import _shot_sort_timestamp

    older_by_exif = {
        "id": "a",
        "created_at": "2026-05-09T12:00:00+00:00",
        "file_mtime": "2026-05-09T12:00:00+00:00",
        "exif_json": json.dumps({"DateTimeOriginal": "2026:04:23 10:10:01"}),
    }
    newer_by_exif = {
        "id": "b",
        "created_at": "2026-05-09T11:00:00+00:00",
        "file_mtime": "2026-05-09T11:00:00+00:00",
        "exif_json": json.dumps({"DateTimeOriginal": "2026:04:23 10:10:02"}),
    }

    assert _shot_sort_timestamp(older_by_exif) < _shot_sort_timestamp(newer_by_exif)


def test_scene_sort_falls_back_to_file_mtime_when_exif_missing() -> None:
    from engine.services.scene_grouper import _shot_sort_timestamp

    earlier = {
        "id": "a",
        "created_at": "2026-05-09T12:00:00+00:00",
        "file_mtime": 1_777_980_000.0,
        "exif_json": None,
    }
    later = {
        "id": "b",
        "created_at": "2026-05-09T10:00:00+00:00",
        "file_mtime": 1_777_983_600.0,
        "exif_json": None,
    }

    assert _shot_sort_timestamp(earlier) < _shot_sort_timestamp(later)


def test_scene_sort_accepts_numeric_file_mtime_strings() -> None:
    from engine.services.scene_grouper import _shot_sort_timestamp

    row = {
        "id": "a",
        "created_at": "2026-05-09T12:00:00+00:00",
        "file_mtime": "1777980000.25",
        "exif_json": None,
    }

    assert _shot_sort_timestamp(row) == 1_777_980_000.25


def test_scene_sort_uses_natural_file_name_for_same_exif_second() -> None:
    from engine.services.scene_grouper import _shot_sort_key

    base = {
        "created_at": "2026-05-09T12:00:00+00:00",
        "file_mtime": "2026-05-09T12:00:00+00:00",
        "exif_json": json.dumps({"DateTimeOriginal": "2026:05:04 09:53:09"}),
    }
    rows = [
        {**base, "id": "uuid-a", "file_name": "5Y3A9924.JPG"},
        {**base, "id": "uuid-b", "file_name": "5Y3A9921.JPG"},
        {**base, "id": "uuid-c", "file_name": "5Y3A9920.JPG"},
    ]

    assert [row["file_name"] for row in sorted(rows, key=_shot_sort_key)] == [
        "5Y3A9920.JPG",
        "5Y3A9921.JPG",
        "5Y3A9924.JPG",
    ]


def test_rapid_burst_soft_continuity_keeps_near_threshold_pair() -> None:
    from engine.pipeline.scene_grouping import SimilarityResult
    from engine.services.scene_grouper import _is_same_scene

    sim = SimilarityResult(
        feature_similarity=0.037,
        feature_confidence=1.0,
        similar=False,
        confidence=1.0,
    )

    assert _is_same_scene(sim, gap_seconds=1.0)
    assert not _is_same_scene(sim, gap_seconds=12.0)
