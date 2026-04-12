"""Quality score → 4-tier grade classification."""

from __future__ import annotations

from engine.pipeline.models import QualityGrade

# Default thresholds (configurable via Settings)
DEFAULT_THRESHOLDS: tuple[float, float, float] = (0.33, 0.43, 0.60)


def grade(
    score: float,
    thresholds: tuple[float, float, float] = DEFAULT_THRESHOLDS,
) -> QualityGrade:
    """Map a combined quality score (0-1) to a 4-tier grade.

    Args:
        score: Combined IQA score (0.35 * CLIPIQA+ + 0.65 * HyperIQA).
        thresholds: (reject_max, record_max, usable_max). Scores >= usable_max are SELECT.

    Returns:
        QualityGrade enum value.
    """
    reject_max, record_max, usable_max = thresholds
    if score < reject_max:
        return QualityGrade.REJECT
    if score < record_max:
        return QualityGrade.RECORD
    if score < usable_max:
        return QualityGrade.USABLE
    return QualityGrade.SELECT
