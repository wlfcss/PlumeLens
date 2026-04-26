"""Quality score → 4-tier grade classification + pose penalty."""

from __future__ import annotations

from engine.pipeline.models import PoseInfo, QualityGrade

# Default thresholds (configurable via Settings)
DEFAULT_THRESHOLDS: tuple[float, float, float] = (0.33, 0.43, 0.60)

# 4 档从低到高
_GRADE_ORDER: tuple[QualityGrade, ...] = (
    QualityGrade.REJECT,
    QualityGrade.RECORD,
    QualityGrade.USABLE,
    QualityGrade.SELECT,
)


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


def downgrade(g: QualityGrade, steps: int) -> QualityGrade:
    """降 N 档（floor 到 REJECT）。"""
    idx = _GRADE_ORDER.index(g)
    new_idx = max(0, idx - steps)
    return _GRADE_ORDER[new_idx]


def apply_pose_penalty(g: QualityGrade, pose: PoseInfo | None) -> QualityGrade:
    """根据头眼可见性降档：

      head 不可见 → -2 档（含眼也不可见的情况，不再叠加）
      eye 不可见  → -1 档
      都可见      → 不降档
      pose=None（模型缺失/推理失败）→ 不降档（保守，等 pose 模型补齐后重跑）

    鸟摄精选惯例：眼睛糊 / 头被截 / 头被遮 → 不能算精选。
    """
    if pose is None:
        return g
    if not pose.head_visible:
        return downgrade(g, 2)
    if not pose.eye_visible:
        return downgrade(g, 1)
    return g
