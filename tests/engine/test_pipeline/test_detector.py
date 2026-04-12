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
