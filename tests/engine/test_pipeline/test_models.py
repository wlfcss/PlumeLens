"""Tests for pipeline Pydantic data models (defaults, optionality, validation)."""

import pytest
from engine.pipeline.models import (
    BirdAnalysis,
    BoundingBox,
    Keypoint,
    PipelineResult,
    PoseInfo,
    QualityGrade,
    QualityScores,
    SpeciesCandidate,
)
from pydantic import ValidationError


def _make_bbox() -> BoundingBox:
    return BoundingBox(x1=10, y1=20, x2=100, y2=200, confidence=0.9)


def _make_scores(combined: float = 0.5) -> QualityScores:
    return QualityScores(clipiqa=0.4, hyperiqa=0.6, combined=combined)


class TestBirdAnalysisDefaults:
    """旧结构向后兼容：pose / species_candidates / species 都是可选的。"""

    def test_minimal_bird_analysis(self) -> None:
        ba = BirdAnalysis(bbox=_make_bbox(), quality=_make_scores(), grade=QualityGrade.USABLE)
        assert ba.pose is None
        assert ba.species_candidates == []
        assert ba.species is None

    def test_with_pose(self) -> None:
        kp = Keypoint(x=50.0, y=80.0, confidence=0.9)
        pose = PoseInfo(
            bill=kp, crown=kp, nape=kp, left_eye=kp, right_eye=kp,
            head_visible=True, eye_visible=True,
        )
        ba = BirdAnalysis(
            bbox=_make_bbox(), quality=_make_scores(), grade=QualityGrade.SELECT, pose=pose,
        )
        assert ba.pose is not None
        assert ba.pose.head_visible is True
        assert ba.pose.eye_visible is True

    def test_with_species_candidates(self) -> None:
        sc = SpeciesCandidate(
            canonical_sci="Passer cinnamomeus",
            canonical_zh="山麻雀",
            iucn="LC",
            confidence=0.88,
        )
        ba = BirdAnalysis(
            bbox=_make_bbox(), quality=_make_scores(), grade=QualityGrade.SELECT,
            species_candidates=[sc], species="Passer cinnamomeus",
        )
        assert len(ba.species_candidates) == 1
        assert ba.species_candidates[0].canonical_zh == "山麻雀"


class TestSpeciesCandidate:
    """物种候选字段默认值与必填项。"""

    def test_minimal(self) -> None:
        sc = SpeciesCandidate(canonical_sci="Alcedo atthis", confidence=0.72)
        assert sc.canonical_zh is None
        assert sc.protect_level is None
        assert sc.iucn is None

    def test_full(self) -> None:
        sc = SpeciesCandidate(
            canonical_sci="Nipponia nippon",
            canonical_zh="朱鹮",
            canonical_en="crested ibis",
            family_sci="Threskiornithidae",
            family_zh="鹮科",
            order_sci="PELECANIFORMES",
            iucn="EN",
            protect_level="一级",
            confidence=0.95,
        )
        assert sc.protect_level == "一级"
        assert sc.iucn == "EN"


class TestPoseInfoRequiresAllKeypoints:
    """PoseInfo 的 5 个关键点都必填，缺任一应触发 ValidationError。"""

    def test_missing_keypoint_fails(self) -> None:
        kp = Keypoint(x=0.0, y=0.0, confidence=0.5)
        with pytest.raises(ValidationError):
            PoseInfo(
                bill=kp, crown=kp, nape=kp, left_eye=kp,  # 缺 right_eye
                head_visible=True, eye_visible=True,
            )  # type: ignore[call-arg]


class TestPipelineResult:
    """整体结果包装。"""

    def test_empty_detections(self) -> None:
        res = PipelineResult(
            photo_id="abc", detections=[], best=None, bird_count=0,
            pipeline_version="v1-deadbeef", duration_ms=123.0,
        )
        assert res.best is None
        assert res.bird_count == 0
