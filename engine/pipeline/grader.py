"""Quality score → 4-tier grade classification + pose penalty."""

from __future__ import annotations

from engine.pipeline.models import PoseInfo, QualityGrade

# Default thresholds (configurable via Settings)
DEFAULT_THRESHOLDS: tuple[float, float, float] = (0.45, 0.60, 0.75)

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


def upgrade(g: QualityGrade, steps: int) -> QualityGrade:
    """升 N 档(ceil 到 SELECT)。"""
    idx = _GRADE_ORDER.index(g)
    new_idx = min(len(_GRADE_ORDER) - 1, idx + steps)
    return _GRADE_ORDER[new_idx]


def apply_pose_adjustment(g: QualityGrade, pose: PoseInfo | None) -> QualityGrade:
    """根据 pose 模型输出调整自动评级。

    降档(鸟摄精选惯例 — 眼糊 / 头被截 / 头被遮 不能算精选):
      head 不可见 → -2 档(含眼也不可见的情况,不再叠加)
      eye  不可见 → -1 档

    升档(v2 模型新增 — 飞版优于栖版):
      head + eye 都可见 + posture == flying → +1 档
      原因:飞版需要技术 + 抓拍 + 运气,在画质相同时应给予更高认可。
      flying 判定故意严格(aspect>1.3 + 双翼可见 + 翼跨度 >= bbox 宽 50%),
      错判为 perched 只是不升档,代价小;反向错判会污染精选墙。

    pose=None(模型缺失/推理失败)→ 不调整,保守等模型补齐后重跑。
    """
    if pose is None:
        return g
    # 降档优先级最高 — 头/眼不可见时不考虑升档(可能是飞鸟但脸被云遮住,仍不算精选)
    if not pose.head_visible:
        return downgrade(g, 2)
    if not pose.eye_visible:
        return downgrade(g, 1)
    # 头眼齐全 → 看姿态。仅"明确飞行"才升档;perched / unknown 都保持原档
    if pose.posture == "flying":
        return upgrade(g, 1)
    return g


# Backward-compat alias — 保留 v1 API 让外部工具/历史调用不破。
# 旧名 apply_pose_penalty 仅含降档逻辑,新代码请用 apply_pose_adjustment。
apply_pose_penalty = apply_pose_adjustment
