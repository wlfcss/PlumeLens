"""Tests for quality score grading."""


from engine.pipeline.grader import grade
from engine.pipeline.models import QualityGrade


class TestGrader:
    """Test 4-tier quality grading with default thresholds."""

    def test_reject_below_threshold(self) -> None:
        assert grade(0.0) == QualityGrade.REJECT
        assert grade(0.10) == QualityGrade.REJECT
        assert grade(0.329) == QualityGrade.REJECT

    def test_record_at_boundary(self) -> None:
        assert grade(0.33) == QualityGrade.RECORD
        assert grade(0.38) == QualityGrade.RECORD
        assert grade(0.429) == QualityGrade.RECORD

    def test_usable_range(self) -> None:
        assert grade(0.43) == QualityGrade.USABLE
        assert grade(0.50) == QualityGrade.USABLE
        assert grade(0.599) == QualityGrade.USABLE

    def test_select_above_threshold(self) -> None:
        assert grade(0.60) == QualityGrade.SELECT
        assert grade(0.85) == QualityGrade.SELECT
        assert grade(1.0) == QualityGrade.SELECT

    def test_custom_thresholds(self) -> None:
        custom = (0.20, 0.50, 0.80)
        assert grade(0.15, custom) == QualityGrade.REJECT
        assert grade(0.30, custom) == QualityGrade.RECORD
        assert grade(0.60, custom) == QualityGrade.USABLE
        assert grade(0.90, custom) == QualityGrade.SELECT

    def test_edge_zero(self) -> None:
        assert grade(0.0) == QualityGrade.REJECT

    def test_edge_one(self) -> None:
        assert grade(1.0) == QualityGrade.SELECT
