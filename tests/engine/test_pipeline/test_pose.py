"""Tests for PoseDetector (bird_visibility ONNX wrapper, mocked session)."""

from unittest.mock import MagicMock

import numpy as np
import pytest
from engine.pipeline.models import PoseInfo
from engine.pipeline.pose import EYE_PARTS, HEAD_PARTS, PART_NAMES, PoseDetector


def _make_mock_session(raw_output: np.ndarray) -> MagicMock:
    """Create a mock bird_visibility ONNX session returning [1, 300, 21]."""
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
    """Build one 21-dim detection row: (bbox, conf, cls, 5×(x, y, conf))."""
    assert len(kpts) == 5
    row = np.zeros(21, dtype=np.float32)
    row[0:4] = bbox
    row[4] = box_conf
    row[5] = 0  # class
    for i, (x, y, c) in enumerate(kpts):
        row[6 + i * 3] = x
        row[7 + i * 3] = y
        row[8 + i * 3] = c
    return row


class TestPoseDetectorBasic:
    def test_constants_alignment(self) -> None:
        assert PART_NAMES == ("bill", "crown", "nape", "left_eye", "right_eye")
        assert HEAD_PARTS == ("bill", "crown", "nape")
        assert EYE_PARTS == ("left_eye", "right_eye")

    def test_empty_below_threshold_returns_none(self) -> None:
        raw = np.zeros((300, 21), dtype=np.float32)
        raw[:, 4] = 0.01  # below box_threshold 0.05
        sess = _make_mock_session(raw)
        detector = PoseDetector(sess, input_size=640, box_threshold=0.05)
        img = np.random.rand(200, 200, 3).astype(np.float32)

        result = detector.detect(img)
        assert result is None


class TestPoseDetectorParsing:
    def test_single_detection_all_visible(self) -> None:
        # Square crop → no letterbox padding when input_size=640
        # Place bbox with high conf and all 5 keypoints well inside.
        raw = np.zeros((300, 21), dtype=np.float32)
        kpts = [(320, 320, 0.9) for _ in range(5)]
        raw[0] = _make_raw_row((100, 100, 540, 540), 0.9, kpts)
        sess = _make_mock_session(raw)
        detector = PoseDetector(
            sess, input_size=640,
            box_threshold=0.05, eye_threshold=0.45,
            head_threshold=0.35, head_eye_threshold=0.10,
        )
        img = np.random.rand(640, 640, 3).astype(np.float32)

        result = detector.detect(img)
        assert isinstance(result, PoseInfo)
        assert result.head_visible is True
        assert result.eye_visible is True
        assert result.bill.confidence == pytest.approx(0.9)

    def test_crop_origin_applied_to_keypoints(self) -> None:
        # Place one crisp keypoint at letterbox coord (320, 320).
        raw = np.zeros((300, 21), dtype=np.float32)
        kpts = [(320, 320, 0.9) for _ in range(5)]
        raw[0] = _make_raw_row((100, 100, 540, 540), 0.9, kpts)
        sess = _make_mock_session(raw)
        detector = PoseDetector(sess, input_size=640)
        img = np.random.rand(640, 640, 3).astype(np.float32)  # no scaling

        # crop 左上角在原图 (1000, 500) 处
        result = detector.detect(img, crop_origin=(1000.0, 500.0))
        assert result is not None
        # 还原到原图：letterbox(320,320) → crop(320,320) → orig(1320, 820)
        assert result.bill.x == pytest.approx(1320.0)
        assert result.bill.y == pytest.approx(820.0)


class TestVisibilityRules:
    """Exercise head/eye decision rules from MODEL_CARD §4.2."""

    @staticmethod
    def _detect_with_kpts(
        kpt_confs: dict[str, float], kpt_xy: tuple[float, float] = (320, 320),
    ) -> PoseInfo | None:
        raw = np.zeros((300, 21), dtype=np.float32)
        # bbox inside letterbox center, keypoints use per-part conf
        row_kpts = [(kpt_xy[0], kpt_xy[1], kpt_confs[name]) for name in PART_NAMES]
        raw[0] = _make_raw_row((100, 100, 540, 540), 0.9, row_kpts)
        sess = _make_mock_session(raw)
        detector = PoseDetector(
            sess, input_size=640,
            eye_threshold=0.45, head_threshold=0.35, head_eye_threshold=0.10,
            expanded_box_margin=0.15,
        )
        img = np.random.rand(640, 640, 3).astype(np.float32)
        return detector.detect(img)

    def test_eye_visible_requires_high_eye_conf(self) -> None:
        # 所有 head parts 高；双眼 conf 都低 → eye_visible=False
        res = self._detect_with_kpts({
            "bill": 0.9, "crown": 0.9, "nape": 0.9,
            "left_eye": 0.3, "right_eye": 0.3,
        })
        assert res is not None
        assert res.eye_visible is False
        # head 仍应 visible（3 个 head parts 满足）
        assert res.head_visible is True

    def test_head_visible_with_two_head_parts(self) -> None:
        # 2 个 head parts + 双眼低 → head_visible=True (rule A)
        res = self._detect_with_kpts({
            "bill": 0.9, "crown": 0.9, "nape": 0.1,
            "left_eye": 0.05, "right_eye": 0.05,
        })
        assert res is not None
        assert res.head_visible is True

    def test_head_visible_with_one_head_and_one_eye(self) -> None:
        # 1 个 head part + 1 个 eye 满足 head_eye_threshold → True (rule B)
        res = self._detect_with_kpts({
            "bill": 0.9, "crown": 0.1, "nape": 0.1,
            "left_eye": 0.15, "right_eye": 0.05,
        })
        assert res is not None
        assert res.head_visible is True

    def test_head_not_visible_with_only_one_head_part(self) -> None:
        # 1 个 head part + 双眼都低于 head_eye_threshold → False
        res = self._detect_with_kpts({
            "bill": 0.9, "crown": 0.1, "nape": 0.1,
            "left_eye": 0.05, "right_eye": 0.05,
        })
        assert res is not None
        assert res.head_visible is False

    def test_keypoint_outside_box_ignored(self) -> None:
        # 关键点在 bbox 外很远处 → 不算命中
        # bbox = (100, 100, 540, 540)，margin=0.15 → 扩展框 ~(34, 34, 606, 606)
        # 把所有关键点放到 (700, 700)，应该被判为 out of box
        res = self._detect_with_kpts(
            {
                "bill": 0.9, "crown": 0.9, "nape": 0.9,
                "left_eye": 0.9, "right_eye": 0.9,
            },
            kpt_xy=(700, 700),
        )
        assert res is not None
        assert res.head_visible is False
        assert res.eye_visible is False
