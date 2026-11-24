"""Unit tests for PipelineManager._analyze_sync orchestration and gating."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import numpy as np
import pytest
from engine.core.config import Settings
from engine.pipeline.manager import PipelineManager
from engine.pipeline.models import (
    BoundingBox,
    Keypoint,
    PoseInfo,
    QualityGrade,
    QualityScores,
    SpeciesCandidate,
)
from PIL import Image


def _make_pose(
    *,
    head_visible: bool = True,
    eye_visible: bool = True,
    posture: str = "perched",
) -> PoseInfo:
    kp = Keypoint(x=10.0, y=10.0, confidence=0.9 if head_visible else 0.05)
    eye = Keypoint(x=12.0, y=10.0, confidence=0.9 if eye_visible else 0.05)
    return PoseInfo(
        bill=kp,
        crown=kp,
        nape=kp,
        left_eye=eye,
        right_eye=eye,
        head_visible=head_visible,
        eye_visible=eye_visible,
        posture=posture,  # type: ignore[arg-type]
    )


def _save_image(tmp_path: Path, name: str = "bird.jpg") -> Path:
    path = tmp_path / name
    Image.fromarray(np.full((200, 300, 3), 128, dtype=np.uint8)).save(path, "JPEG")
    return path


def test_analyze_sync_zero_birds_returns_empty_result(tmp_path: Path) -> None:
    pm = PipelineManager(Settings(data_dir=tmp_path))
    pm._detector = MagicMock()
    pm._detector.detect.return_value = []
    pm._pipeline_version = "v2-unit"

    res = pm._analyze_sync(_save_image(tmp_path), photo_id="p-empty")
    assert res.bird_count == 0
    assert res.best is None
    assert res.detections == []
    assert (res.image_width, res.image_height) == (300, 200)


def test_analyze_sync_falls_back_to_cpu_detector_and_picks_highest_combined_bird(
    tmp_path: Path,
) -> None:
    pm = PipelineManager(Settings(data_dir=tmp_path, species_min_grade="record"))
    pm._pipeline_version = "v2-unit"
    pm._detector = MagicMock()
    pm._detector.detect.side_effect = RuntimeError("CoreML GatherElements crash")

    box_low = BoundingBox(x1=10, y1=10, x2=80, y2=80, confidence=0.9)
    box_high = BoundingBox(x1=120, y1=20, x2=240, y2=160, confidence=0.85)
    pm._detector_cpu_fallback = MagicMock()
    pm._detector_cpu_fallback.detect.return_value = [box_low, box_high]

    pm._assessor = MagicMock()
    pm._assessor.assess.side_effect = [
        QualityScores(clipiqa=0.4, hyperiqa=0.4, combined=0.4),
        QualityScores(clipiqa=0.85, hyperiqa=0.85, combined=0.85),
    ]
    pm._pose = MagicMock()
    pm._pose.detect.side_effect = [
        RuntimeError("pose model transient failure"),
        _make_pose(head_visible=True, eye_visible=True, posture="flying"),
    ]
    pm._species = MagicMock()
    pm._species.classify.return_value = [
        SpeciesCandidate(
            canonical_sci="Alcedo atthis",
            canonical_zh="普通翠鸟",
            confidence=0.92,
            recognition_state="recognized",
        )
    ]

    res = pm._analyze_sync(_save_image(tmp_path), photo_id="p-multi")
    assert res.bird_count == 2
    assert res.best is not None
    assert res.best.bbox == box_high
    assert res.best.grade == QualityGrade.SELECT
    assert res.best.species == "普通翠鸟"
    # First bird survived pose exception cleanly and did not run species (grade REJECT < RECORD)
    assert res.detections[0].pose is None
    assert res.detections[0].grade == QualityGrade.REJECT
    assert pm._species.classify.call_count == 1


def test_analyze_sync_missing_iqa_uses_neutral_score_and_handles_uncertain_species(
    tmp_path: Path,
) -> None:
    pm = PipelineManager(Settings(data_dir=tmp_path))
    pm._pipeline_version = "v2-unit"
    pm._detector = MagicMock()
    pm._detector.detect.return_value = [BoundingBox(x1=20, y1=20, x2=150, y2=150, confidence=0.95)]
    pm._assessor = None
    pm._pose = None
    pm._species = MagicMock()
    pm._species.classify.return_value = [
        SpeciesCandidate(
            canonical_sci="Egretta garzetta",
            canonical_zh="白鹭",
            confidence=0.41,
            recognition_state="uncertain",
        )
    ]

    res = pm._analyze_sync(_save_image(tmp_path), photo_id="p-no-iqa")
    assert res.best is not None
    assert res.best.quality.combined == pytest.approx(0.5)
    assert res.best.grade == QualityGrade.RECORD
    # Uncertain species preserves candidates for review without populating confirmed species name
    assert res.best.species is None
    assert len(res.best.species_candidates) == 1


def test_analyze_sync_isolates_species_exception_and_rejects_closed_pipeline(
    tmp_path: Path,
) -> None:
    pm = PipelineManager(Settings(data_dir=tmp_path))
    pm._detector = MagicMock()
    pm._detector.detect.return_value = [BoundingBox(x1=20, y1=20, x2=150, y2=150, confidence=0.95)]
    pm._species = MagicMock()
    pm._species.classify.side_effect = RuntimeError("MPS OOM")

    res = pm._analyze_sync(_save_image(tmp_path), photo_id="p-sp-err")
    assert res.best is not None
    assert res.best.species is None
    assert res.best.species_candidates == []

    pm.close()
    with pytest.raises(RuntimeError, match="Pipeline closed"):
        pm._analyze_sync(_save_image(tmp_path, "b.jpg"), photo_id="p-closed")
