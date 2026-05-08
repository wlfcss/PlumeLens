"""Tests for quality score grading + pose adjustment."""

from engine.pipeline.grader import (
    apply_pose_adjustment,
    apply_pose_penalty,
    downgrade,
    grade,
    upgrade,
)
from engine.pipeline.models import Keypoint, PoseInfo, QualityGrade


def _make_pose(
    *,
    head_visible: bool = True,
    eye_visible: bool = True,
    posture: str = "unknown",
) -> PoseInfo:
    """简化构造 PoseInfo,只需要可见性 + posture 三个字段控制。"""
    zero_kp = Keypoint(x=0.0, y=0.0, confidence=0.0)
    return PoseInfo(
        bill=zero_kp,
        crown=zero_kp,
        nape=zero_kp,
        left_eye=zero_kp,
        right_eye=zero_kp,
        head_visible=head_visible,
        eye_visible=eye_visible,
        posture=posture,
    )


class TestGrader:
    """Test 4-tier quality grading with default thresholds."""

    def test_reject_below_threshold(self) -> None:
        assert grade(0.0) == QualityGrade.REJECT
        assert grade(0.10) == QualityGrade.REJECT
        assert grade(0.449) == QualityGrade.REJECT

    def test_record_at_boundary(self) -> None:
        assert grade(0.45) == QualityGrade.RECORD
        assert grade(0.52) == QualityGrade.RECORD
        assert grade(0.599) == QualityGrade.RECORD

    def test_usable_range(self) -> None:
        assert grade(0.60) == QualityGrade.USABLE
        assert grade(0.68) == QualityGrade.USABLE
        assert grade(0.749) == QualityGrade.USABLE

    def test_select_above_threshold(self) -> None:
        assert grade(0.75) == QualityGrade.SELECT
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


class TestGradeShifts:
    """downgrade / upgrade 边界。"""

    def test_downgrade_floors_at_reject(self) -> None:
        assert downgrade(QualityGrade.REJECT, 5) == QualityGrade.REJECT
        assert downgrade(QualityGrade.SELECT, 2) == QualityGrade.RECORD
        assert downgrade(QualityGrade.SELECT, 5) == QualityGrade.REJECT

    def test_upgrade_ceils_at_select(self) -> None:
        assert upgrade(QualityGrade.SELECT, 1) == QualityGrade.SELECT
        assert upgrade(QualityGrade.SELECT, 5) == QualityGrade.SELECT
        assert upgrade(QualityGrade.RECORD, 1) == QualityGrade.USABLE
        assert upgrade(QualityGrade.RECORD, 2) == QualityGrade.SELECT

    def test_zero_step_is_noop(self) -> None:
        assert downgrade(QualityGrade.USABLE, 0) == QualityGrade.USABLE
        assert upgrade(QualityGrade.USABLE, 0) == QualityGrade.USABLE


class TestPoseAdjustmentDowngrade:
    """v1 兼容降档:头不可见 -2 / 眼不可见 -1。"""

    def test_no_pose_no_adjustment(self) -> None:
        """pose=None(模型缺失/失败)→ 保持原档。"""
        assert apply_pose_adjustment(QualityGrade.SELECT, None) == QualityGrade.SELECT
        assert apply_pose_adjustment(QualityGrade.REJECT, None) == QualityGrade.REJECT

    def test_head_not_visible_downgrades_two(self) -> None:
        pose = _make_pose(head_visible=False, eye_visible=False)
        assert apply_pose_adjustment(QualityGrade.SELECT, pose) == QualityGrade.RECORD
        assert apply_pose_adjustment(QualityGrade.USABLE, pose) == QualityGrade.REJECT

    def test_eye_not_visible_downgrades_one(self) -> None:
        pose = _make_pose(head_visible=True, eye_visible=False)
        assert apply_pose_adjustment(QualityGrade.SELECT, pose) == QualityGrade.USABLE
        assert apply_pose_adjustment(QualityGrade.RECORD, pose) == QualityGrade.REJECT

    def test_head_eye_visible_perched_no_change(self) -> None:
        """头眼齐全 + 栖息 → 保持原档。"""
        pose = _make_pose(head_visible=True, eye_visible=True, posture="perched")
        assert apply_pose_adjustment(QualityGrade.USABLE, pose) == QualityGrade.USABLE
        assert apply_pose_adjustment(QualityGrade.RECORD, pose) == QualityGrade.RECORD

    def test_head_eye_visible_unknown_posture_no_change(self) -> None:
        """头眼齐全 + posture=unknown → 不升档(保守)。"""
        pose = _make_pose(head_visible=True, eye_visible=True, posture="unknown")
        assert apply_pose_adjustment(QualityGrade.USABLE, pose) == QualityGrade.USABLE


class TestFlyModeUpgrade:
    """v2 新增飞版自动升档:head+eye 可见 + posture=flying → +1 档。"""

    def test_flying_upgrades_one_step(self) -> None:
        pose = _make_pose(head_visible=True, eye_visible=True, posture="flying")
        # RECORD → USABLE
        assert apply_pose_adjustment(QualityGrade.RECORD, pose) == QualityGrade.USABLE
        # USABLE → SELECT
        assert apply_pose_adjustment(QualityGrade.USABLE, pose) == QualityGrade.SELECT
        # REJECT → RECORD(画质差但飞版有抓拍价值)
        assert apply_pose_adjustment(QualityGrade.REJECT, pose) == QualityGrade.RECORD

    def test_flying_at_select_caps(self) -> None:
        """已是 SELECT 顶档,飞版不会再升(ceil 到 SELECT)。"""
        pose = _make_pose(head_visible=True, eye_visible=True, posture="flying")
        assert apply_pose_adjustment(QualityGrade.SELECT, pose) == QualityGrade.SELECT

    def test_flying_but_eye_invisible_still_downgrades(self) -> None:
        """飞版但眼不可见(脸糊或脸被遮)→ 降档优先,不升档。"""
        pose = _make_pose(head_visible=True, eye_visible=False, posture="flying")
        # 降档逻辑先生效 → -1 档,飞版规则跳过
        assert apply_pose_adjustment(QualityGrade.SELECT, pose) == QualityGrade.USABLE
        assert apply_pose_adjustment(QualityGrade.USABLE, pose) == QualityGrade.RECORD

    def test_flying_but_head_invisible_still_downgrades(self) -> None:
        """飞版但头不可见(被云遮挡或转头剪影)→ -2 档,不升档。"""
        pose = _make_pose(head_visible=False, eye_visible=False, posture="flying")
        assert apply_pose_adjustment(QualityGrade.SELECT, pose) == QualityGrade.RECORD


class TestBackwardCompat:
    """旧 API apply_pose_penalty 应仍可调用,实际指向新函数。"""

    def test_apply_pose_penalty_alias(self) -> None:
        assert apply_pose_penalty is apply_pose_adjustment

    def test_old_callsite_still_works(self) -> None:
        pose = _make_pose(head_visible=True, eye_visible=True, posture="flying")
        # 老代码路径仍能用旧名调用,语义切换为新 adjustment(含升档)
        assert apply_pose_penalty(QualityGrade.USABLE, pose) == QualityGrade.SELECT
