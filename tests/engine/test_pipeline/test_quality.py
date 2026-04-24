"""Tests for dual-model IQA quality assessor (mocked ONNX sessions)."""

from unittest.mock import MagicMock

import numpy as np
import pytest
from engine.pipeline.quality import QualityAssessor


def _make_iqa_session(output_value: float, output_shape: tuple[int, ...]) -> MagicMock:
    """Create a mock IQA ONNX session."""
    session = MagicMock()
    mock_input = MagicMock()
    mock_input.name = "input"
    mock_output = MagicMock()
    mock_output.name = "output"
    session.get_inputs.return_value = [mock_input]
    session.get_outputs.return_value = [mock_output]
    session.run.return_value = [np.full(output_shape, output_value, dtype=np.float32)]
    return session


class TestQualityAssessor:
    """Test quality scoring with mocked ONNX sessions."""

    def test_combined_score_weighted(self) -> None:
        clipiqa_session = _make_iqa_session(0.8, (1, 1))
        hyperiqa_session = _make_iqa_session(0.6, (1, 1, 1))
        assessor = QualityAssessor(
            clipiqa_session, hyperiqa_session,
            clipiqa_weight=0.35, hyperiqa_weight=0.65,
        )

        crop = np.random.rand(100, 100, 3).astype(np.float32)
        scores = assessor.assess(crop)

        assert scores.clipiqa == pytest.approx(0.8)
        assert scores.hyperiqa == pytest.approx(0.6)
        assert scores.combined == pytest.approx(0.35 * 0.8 + 0.65 * 0.6)

    def test_scores_clamped(self) -> None:
        # Simulate model returning slightly out of range
        clipiqa_session = _make_iqa_session(1.1, (1, 1))
        hyperiqa_session = _make_iqa_session(-0.1, (1, 1, 1))
        assessor = QualityAssessor(
            clipiqa_session, hyperiqa_session,
            clipiqa_weight=0.35, hyperiqa_weight=0.65,
        )

        crop = np.random.rand(50, 50, 3).astype(np.float32)
        scores = assessor.assess(crop)

        assert scores.clipiqa == 1.0
        assert scores.hyperiqa == 0.0

    def test_equal_weights(self) -> None:
        clipiqa_session = _make_iqa_session(0.5, (1, 1))
        hyperiqa_session = _make_iqa_session(0.5, (1, 1, 1))
        assessor = QualityAssessor(
            clipiqa_session, hyperiqa_session,
            clipiqa_weight=0.5, hyperiqa_weight=0.5,
        )

        crop = np.random.rand(80, 80, 3).astype(np.float32)
        scores = assessor.assess(crop)
        assert scores.combined == pytest.approx(0.5)
