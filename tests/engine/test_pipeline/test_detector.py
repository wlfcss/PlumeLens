"""Tests for YOLO bird detector (mocked ONNX session)."""

from unittest.mock import MagicMock

import numpy as np
import pytest
from engine.pipeline.detector import BirdDetector


def _make_mock_session(raw_output: np.ndarray) -> MagicMock:
    """Create a mock ONNX session that returns specified output."""
    session = MagicMock()
    mock_input = MagicMock()
    mock_input.name = "images"
    mock_output = MagicMock()
    mock_output.name = "output0"
    session.get_inputs.return_value = [mock_input]
    session.get_outputs.return_value = [mock_output]
    # run() returns list of arrays; first element is [1, N, 6]
    session.run.return_value = [raw_output[np.newaxis, ...]]
    return session


class TestBirdDetector:
    """Test detection with mocked ONNX sessions."""

    def test_no_detections(self) -> None:
        # All confidences below threshold
        raw = np.zeros((300, 6), dtype=np.float32)
        raw[:, 4] = 0.1  # low confidence
        session = _make_mock_session(raw)
        detector = BirdDetector(session, input_size=640)

        image = np.random.rand(480, 640, 3).astype(np.float32)
        boxes = detector.detect(image, confidence_threshold=0.35)
        assert boxes == []

    def test_single_detection(self) -> None:
        raw = np.zeros((300, 6), dtype=np.float32)
        # Place one high-confidence box in the center of 640x640 letterboxed space
        raw[0] = [200, 200, 400, 400, 0.9, 0]
        session = _make_mock_session(raw)
        detector = BirdDetector(session, input_size=640)

        # Square image, so no letterbox padding
        image = np.random.rand(640, 640, 3).astype(np.float32)
        boxes = detector.detect(image, confidence_threshold=0.35)
        assert len(boxes) == 1
        assert boxes[0].confidence == pytest.approx(0.9)

    def test_filters_by_confidence(self) -> None:
        raw = np.zeros((300, 6), dtype=np.float32)
        raw[0] = [100, 100, 200, 200, 0.8, 0]
        raw[1] = [300, 300, 400, 400, 0.2, 0]  # below threshold
        session = _make_mock_session(raw)
        detector = BirdDetector(session, input_size=640)

        image = np.random.rand(640, 640, 3).astype(np.float32)
        boxes = detector.detect(image, confidence_threshold=0.35)
        assert len(boxes) == 1

    def test_coordinates_clamped(self) -> None:
        raw = np.zeros((300, 6), dtype=np.float32)
        # Box extends beyond image
        raw[0] = [-50, -50, 2000, 2000, 0.9, 0]
        session = _make_mock_session(raw)
        detector = BirdDetector(session, input_size=640)

        image = np.random.rand(480, 640, 3).astype(np.float32)
        boxes = detector.detect(image, confidence_threshold=0.35)
        assert len(boxes) == 1
        assert boxes[0].x1 >= 0
        assert boxes[0].y1 >= 0

    def test_iou_dedup_drops_near_duplicate_keeping_highest_conf(self) -> None:
        """YOLO26 NMS-free 在密集场景仍可能 over-detect 同一只鸟（多个高度
        重叠 bbox）。v1.1 沿用的 dedup 应保留 conf 最高那个，IoU > 0.5 视为重复。"""
        raw = np.zeros((300, 6), dtype=np.float32)
        # 3 个几乎完全重叠的框（同一只鸟），不同 conf；共享同一个区域
        raw[0] = [100, 100, 300, 300, 0.88, 0]  # 200×200 base
        raw[1] = [102, 102, 298, 298, 0.69, 0]  # 96.04% overlap → IoU ≈ 0.92
        raw[2] = [105, 105, 295, 295, 0.55, 0]  # IoU ≈ 0.86
        # 一个完全独立的框（远处另一只鸟，不应被合并）
        raw[3] = [400, 400, 500, 500, 0.78, 0]
        session = _make_mock_session(raw)
        detector = BirdDetector(session, input_size=640, iou_dedup_threshold=0.5)

        image = np.random.rand(640, 640, 3).astype(np.float32)
        boxes = detector.detect(image, confidence_threshold=0.35)

        # 期望：3 个重叠合并为 1（保留 0.88），独立的远处框保留
        assert len(boxes) == 2
        confidences = sorted([b.confidence for b in boxes], reverse=True)
        assert confidences[0] == pytest.approx(0.88)
        assert confidences[1] == pytest.approx(0.78)

    def test_iou_dedup_does_not_merge_legit_adjacent_birds(self) -> None:
        """两只轻微相邻的鸟不该被误合 — 只杀 ghost duplicate。"""
        raw = np.zeros((300, 6), dtype=np.float32)
        # 两个相邻 bbox，IoU ~0.2 以下 — 真鸟群场景
        raw[0] = [100, 100, 250, 250, 0.85, 0]
        raw[1] = [225, 100, 375, 250, 0.80, 0]
        session = _make_mock_session(raw)
        detector = BirdDetector(session, input_size=640, iou_dedup_threshold=0.5)

        image = np.random.rand(640, 640, 3).astype(np.float32)
        boxes = detector.detect(image, confidence_threshold=0.35)

        # 期望：两只鸟都保留
        assert len(boxes) == 2

    def test_iou_dedup_disabled_when_threshold_geq_one(self) -> None:
        """阈值 >= 1.0 直接 short-circuit，保留所有 bboxes（用于回归测试 / 调试）。"""
        raw = np.zeros((300, 6), dtype=np.float32)
        raw[0] = [100, 100, 300, 300, 0.88, 0]
        raw[1] = [101, 101, 299, 299, 0.69, 0]  # 几乎完全重叠
        session = _make_mock_session(raw)
        detector = BirdDetector(session, input_size=640, iou_dedup_threshold=1.0)

        image = np.random.rand(640, 640, 3).astype(np.float32)
        boxes = detector.detect(image, confidence_threshold=0.35)

        assert len(boxes) == 2  # 不去重
