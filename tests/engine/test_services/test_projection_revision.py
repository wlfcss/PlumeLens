"""Hash batches must preserve pinned selection and export revisions."""

from __future__ import annotations

import hashlib
import json

import pytest
from engine.api.schemas.library import PhotoSummary
from engine.services import library_projection


@pytest.mark.parametrize("batch_size", [1, 2, 3, 7])
@pytest.mark.parametrize("photo_count", [0, 1, 4])
def test_projection_revision_preserves_legacy_json_digest(
    monkeypatch: pytest.MonkeyPatch, batch_size: int, photo_count: int
) -> None:
    monkeypatch.setattr(library_projection, "_PROJECTION_REVISION_BATCH_SIZE", batch_size)
    library_id = '观鸟 "2026"🐦'
    photos: list[PhotoSummary] = []
    legacy_rows = []
    for index in range(photo_count):
        name = f'林间景色-{index}"🐦.jpg'
        path = f"照片/{name}"
        photo = PhotoSummary(
            id=f"image-{index}",
            file_path=path,
            file_name=name,
            input_revision=index,
            file_hash=f"hash-{index}",
            format="JPG",
            width=None,
            height=None,
            thumb_grid=None,
            thumb_preview=None,
            companion_path=f"{path}.NEF",
            companion_format="NEF",
            companion_size=1024,
            created_at="2026-07-12",
            shot_at="2026-07-12T08:09:10+00:00",
            scene_id=None,
            pipeline_version="v42",
            grade="usable",
            quality_score=-0.0 if index == 0 else 0.75,
            bird_count=2,
            species="白鹭🐦",
            species_latin="Egretta garzetta",
            species_source="group_consensus",
            decision="select",
            analysis_status="done",
        )
        photo._selection_revision = f"selection-{index}"
        photos.append(photo)
        legacy_rows.append(
            (
                f"image-{index}",
                path,
                name,
                index,
                f"hash-{index}",
                "v42",
                f"{path}.NEF",
                "NEF",
                1024,
                "JPG",
                "2026-07-12T08:09:10+00:00",
                None,
                "done",
                "usable",
                "select",
                -0.0 if index == 0 else 0.75,
                2,
                "白鹭🐦",
                "Egretta garzetta",
                "group_consensus",
                f"selection-{index}",
            )
        )
    legacy_bytes = json.dumps(
        [library_id, legacy_rows], ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    assert library_projection.projection_revision(library_id, photos) == (
        hashlib.sha256(legacy_bytes).hexdigest()
    )
