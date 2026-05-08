"""Tests for PoseDetector v2.0 (bird_visibility11 ONNX wrapper, mocked session)."""

from unittest.mock import MagicMock

import numpy as np
import pytest
from engine.pipeline.models import PoseInfo
from engine.pipeline.pose import (
    BODY_PARTS,
    EYE_PARTS,
    HEAD_PARTS,
    PART_NAMES,
    TAIL_PART,
    WING_PARTS,
    PoseDetector,
    _ROW_WIDTH,
)

# v2 ONNX 输出维度:6 + 11×3 = 39。从 pose.py 内部常量 import 防止 PART_NAMES
# 长度未来变更(如 v3 加点)时测试硬编码漂移 — 改 PART_NAMES 后 test 会自动跟随。
_NUM_KPTS = len(PART_NAMES)


def _make_mock_session(raw_output: np.ndarray) -> MagicMock:
    """Create a mock bird_visibility11 ONNX session returning [1, 300, 39]."""
    session = MagicMock()
    mock_input = MagicMock()
    mock_input.name = "images"
    mock_output = MagicMock()
    mock_output.name = "output0"
    session.get_inputs.return_value = [mock_input]
    session.get_outputs.return_value = [mock_output]
    session.run.return_value = [raw_output[np.newaxis, ...]]
    return session


def _make_raw_row(
    bbox: tuple[float, float, float, float],
    box_conf: float,
    kpts: list[tuple[float, float, float]],
) -> np.ndarray:
    """Build one 39-dim detection row: (bbox 4, conf, cls, 11×(x, y, conf))."""
    assert len(kpts) == _NUM_KPTS
    row = np.zeros(_ROW_WIDTH, dtype=np.float32)
    row[0:4] = bbox
    row[4] = box_conf
    row[5] = 0
    for i, (x, y, c) in enumerate(kpts):
        row[6 + i * 3] = x
        row[7 + i * 3] = y
        row[8 + i * 3] = c
    return row


def _kpts_uniform(conf: float, xy: tuple[float, float] = (320, 320)) -> list[tuple[float, float, float]]:
    """所有 11 个关键点用同一 conf + 同一 xy。"""
    return [(xy[0], xy[1], conf) for _ in range(_NUM_KPTS)]


def _make_detector(**kwargs) -> tuple[PoseDetector, np.ndarray]:
    """Build detector with sane v2 defaults + dummy 640×640 image."""
    sess = kwargs.pop("session")
    img = np.random.rand(640, 640, 3).astype(np.float32)
    detector = PoseDetector(
        sess,
        input_size=640,
        box_threshold=0.05,
        eye_threshold=0.45,
        head_threshold=0.45,
        head_eye_threshold=0.40,
        body_threshold=0.30,
        tail_threshold=0.40,
        wing_threshold=0.40,
        expanded_box_margin=0.15,
        **kwargs,
    )
    return detector, img


# ---------------------------------------------------------------------------
# 输出维度 + 基础解析
# ---------------------------------------------------------------------------


class TestPoseDetectorBasic:
    def test_constants_alignment(self) -> None:
        """v2 关键点列表必须严格对齐:5 头 + 6 身 = 11。"""
        assert len(PART_NAMES) == 11
        assert PART_NAMES[:5] == ("bill", "crown", "nape", "left_eye", "right_eye")
        assert PART_NAMES[5:] == ("belly", "breast", "back", "tail", "left_wing", "right_wing")
        assert HEAD_PARTS == ("bill", "crown", "nape")
        assert EYE_PARTS == ("left_eye", "right_eye")
        assert BODY_PARTS == ("belly", "breast", "back")
        assert WING_PARTS == ("left_wing", "right_wing")
        assert TAIL_PART == "tail"

    def test_empty_below_threshold_returns_none(self) -> None:
        raw = np.zeros((300, _ROW_WIDTH), dtype=np.float32)
        raw[:, 4] = 0.01
        detector, img = _make_detector(session=_make_mock_session(raw))
        assert detector.detect(img) is None

    def test_wrong_output_width_returns_none(self) -> None:
        """旧 v1 维度 21 应直接返回 None,不能被错误解析。"""
        raw = np.zeros((300, 21), dtype=np.float32)
        raw[0, 4] = 0.9
        detector, img = _make_detector(session=_make_mock_session(raw))
        assert detector.detect(img) is None


class TestPoseDetectorParsing:
    def test_single_detection_all_visible(self) -> None:
        raw = np.zeros((300, _ROW_WIDTH), dtype=np.float32)
        raw[0] = _make_raw_row((100, 100, 540, 540), 0.9, _kpts_uniform(0.9))
        detector, img = _make_detector(session=_make_mock_session(raw))
        result = detector.detect(img)
        assert isinstance(result, PoseInfo)
        assert result.head_visible is True
        assert result.eye_visible is True
        assert result.body_visible is True
        assert result.tail_visible is True
        assert result.wings_visible is True
        # 11 个关键点都解析出来
        assert result.bill.confidence == pytest.approx(0.9)
        assert result.belly.confidence == pytest.approx(0.9)
        assert result.left_wing.confidence == pytest.approx(0.9)

    def test_crop_origin_applied_to_all_keypoints(self) -> None:
        raw = np.zeros((300, _ROW_WIDTH), dtype=np.float32)
        raw[0] = _make_raw_row((100, 100, 540, 540), 0.9, _kpts_uniform(0.9))
        detector, img = _make_detector(session=_make_mock_session(raw))
        result = detector.detect(img, crop_origin=(1000.0, 500.0))
        assert result is not None
        # 所有 11 个关键点都应原位移加 (1000, 500)
        for kp in (result.bill, result.belly, result.left_wing, result.tail):
            assert kp.x == pytest.approx(1320.0)
            assert kp.y == pytest.approx(820.0)


# ---------------------------------------------------------------------------
# 头/眼可见性(继承 v1 规则,阈值 v2 调整)
# ---------------------------------------------------------------------------


class TestHeadEyeRules:
    @staticmethod
    def _detect(kpt_confs: dict[str, float]) -> PoseInfo | None:
        """每个关键点用对应 conf,xy 都在 bbox 中心。"""
        raw = np.zeros((300, _ROW_WIDTH), dtype=np.float32)
        kpts = [(320.0, 320.0, kpt_confs[name]) for name in PART_NAMES]
        raw[0] = _make_raw_row((100, 100, 540, 540), 0.9, kpts)
        detector, img = _make_detector(session=_make_mock_session(raw))
        return detector.detect(img)

    def test_eye_visible_requires_high_eye_conf(self) -> None:
        confs = {n: (0.9 if n in HEAD_PARTS else 0.3) for n in PART_NAMES}
        confs.update({"left_eye": 0.3, "right_eye": 0.3})
        confs.update({n: 0.9 for n in (*BODY_PARTS, TAIL_PART, *WING_PARTS)})
        res = self._detect(confs)
        assert res is not None
        assert res.eye_visible is False  # 双眼都 < 0.45
        assert res.head_visible is True  # 3 个 head_parts 满足

    def test_head_visible_with_two_head_parts(self) -> None:
        confs = {n: 0.0 for n in PART_NAMES}
        confs.update({"bill": 0.9, "crown": 0.9})  # 2 个 head + 双眼/nape 都 0
        res = self._detect(confs)
        assert res is not None
        assert res.head_visible is True

    def test_head_visible_with_one_head_and_one_eye(self) -> None:
        confs = {n: 0.0 for n in PART_NAMES}
        confs.update({"bill": 0.9, "left_eye": 0.5})  # 1 head + 1 eye(>=0.40 head_eye_threshold)
        res = self._detect(confs)
        assert res is not None
        assert res.head_visible is True

    def test_head_not_visible_with_one_head_only(self) -> None:
        confs = {n: 0.0 for n in PART_NAMES}
        confs["bill"] = 0.9
        res = self._detect(confs)
        assert res is not None
        assert res.head_visible is False  # 仅 1 head + 0 eye


# ---------------------------------------------------------------------------
# v2 新增 visibility:body / tail / wings
# ---------------------------------------------------------------------------


class TestNewVisibilityRules:
    @staticmethod
    def _detect(kpt_confs: dict[str, float]) -> PoseInfo | None:
        raw = np.zeros((300, _ROW_WIDTH), dtype=np.float32)
        kpts = [(320.0, 320.0, kpt_confs.get(name, 0.0)) for name in PART_NAMES]
        raw[0] = _make_raw_row((100, 100, 540, 540), 0.9, kpts)
        detector, img = _make_detector(session=_make_mock_session(raw))
        return detector.detect(img)

    def test_body_visible_any_body_part(self) -> None:
        res = self._detect({"belly": 0.5})
        assert res is not None
        assert res.body_visible is True

    def test_body_not_visible_when_all_below_threshold(self) -> None:
        res = self._detect({"belly": 0.2, "breast": 0.1, "back": 0.0})
        assert res is not None
        assert res.body_visible is False

    def test_tail_visible_above_threshold(self) -> None:
        res = self._detect({"tail": 0.5})
        assert res is not None
        assert res.tail_visible is True

    def test_wings_visible_any_side(self) -> None:
        res = self._detect({"left_wing": 0.5})
        assert res is not None
        assert res.wings_visible is True

    def test_keypoints_outside_box_ignored(self) -> None:
        """v2 也保留 v1 的"框内"判定 — 关键点远离 bbox 不算命中。"""
        raw = np.zeros((300, _ROW_WIDTH), dtype=np.float32)
        # bbox = (100, 100, 540, 540),margin 0.15 → 扩展 (34, 34, 606, 606)
        # 把所有关键点放到 (700, 700) 远在框外
        kpts = [(700.0, 700.0, 0.9) for _ in range(_NUM_KPTS)]
        raw[0] = _make_raw_row((100, 100, 540, 540), 0.9, kpts)
        detector, img = _make_detector(session=_make_mock_session(raw))
        res = detector.detect(img)
        assert res is not None
        assert res.head_visible is False
        assert res.eye_visible is False
        assert res.body_visible is False
        assert res.tail_visible is False
        assert res.wings_visible is False


# ---------------------------------------------------------------------------
# v2 新增 posture 派生:view_angle / facing / posture
# ---------------------------------------------------------------------------


class TestPostureDerivation:
    @staticmethod
    def _detect_with_kpts(
        bbox: tuple[float, float, float, float],
        explicit: dict[str, tuple[float, float, float]],
    ) -> PoseInfo | None:
        """部分关键点显式指定 (x, y, conf),其它默认 0。"""
        raw = np.zeros((300, _ROW_WIDTH), dtype=np.float32)
        kpts = []
        for name in PART_NAMES:
            if name in explicit:
                kpts.append(explicit[name])
            else:
                kpts.append((0.0, 0.0, 0.0))
        raw[0] = _make_raw_row(bbox, 0.9, kpts)
        detector, img = _make_detector(session=_make_mock_session(raw))
        return detector.detect(img)

    def test_view_angle_side_with_one_eye(self) -> None:
        """仅一只眼可见 + 头可见 → side。"""
        bbox = (100.0, 100.0, 540.0, 540.0)
        res = self._detect_with_kpts(
            bbox,
            {
                "bill": (250.0, 320.0, 0.9),
                "crown": (300.0, 300.0, 0.9),
                "nape": (350.0, 300.0, 0.9),
                "left_eye": (290.0, 310.0, 0.9),  # 仅左眼可见
            },
        )
        assert res is not None
        assert res.view_angle == "side"

    def test_view_angle_back_with_no_eyes(self) -> None:
        """双眼不可见 + crown + nape 都可见 → back。"""
        bbox = (100.0, 100.0, 540.0, 540.0)
        res = self._detect_with_kpts(
            bbox,
            {
                "crown": (300.0, 300.0, 0.9),
                "nape": (350.0, 300.0, 0.9),
            },
        )
        assert res is not None
        assert res.view_angle == "back"

    def test_facing_left_when_bill_left_of_nape(self) -> None:
        """side 视角下,bill.x < nape.x → facing=left。"""
        bbox = (100.0, 100.0, 540.0, 540.0)
        res = self._detect_with_kpts(
            bbox,
            {
                "bill": (200.0, 320.0, 0.9),  # bill 偏左
                "crown": (300.0, 300.0, 0.9),
                "nape": (400.0, 300.0, 0.9),  # nape 偏右
                "left_eye": (290.0, 310.0, 0.9),
            },
        )
        assert res is not None
        assert res.view_angle == "side"
        assert res.facing == "left"

    def test_posture_flying_wide_bbox_wings_spread(self) -> None:
        """aspect > 1.3 + 双翼可见 + 翼跨度 ≥ 50% bbox 宽 → flying。"""
        # bbox 宽 600, 高 200 → aspect 3.0
        bbox = (100.0, 200.0, 700.0, 400.0)
        res = self._detect_with_kpts(
            bbox,
            {
                "left_wing": (200.0, 300.0, 0.9),  # 翼间距 = 400px > 600 * 0.5 = 300
                "right_wing": (600.0, 300.0, 0.9),
            },
        )
        assert res is not None
        assert res.posture == "flying"

    def test_posture_perched_when_wings_tucked(self) -> None:
        """方形 bbox + 翼不可见 → perched。"""
        # 方形 bbox 50×50,aspect 1.0 < 1.05
        bbox = (250.0, 250.0, 300.0, 300.0)
        res = self._detect_with_kpts(
            bbox,
            {
                "bill": (270.0, 270.0, 0.9),
                "crown": (275.0, 275.0, 0.9),
                "nape": (280.0, 280.0, 0.9),
                "left_eye": (272.0, 272.0, 0.9),
            },
        )
        assert res is not None
        assert res.posture == "perched"

    def test_posture_not_flying_when_wings_too_close(self) -> None:
        """aspect 大但翼跨度 < 50% bbox 宽 → 不算 flying。"""
        bbox = (100.0, 200.0, 700.0, 400.0)  # 宽 600,aspect 3.0
        res = self._detect_with_kpts(
            bbox,
            {
                "left_wing": (390.0, 300.0, 0.9),  # 翼跨度仅 20px,远 < 300
                "right_wing": (410.0, 300.0, 0.9),
            },
        )
        assert res is not None
        assert res.posture != "flying"
