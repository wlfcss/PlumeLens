# pyright: basic
"""Dual-model IQA: CLIPIQA+ and HyperIQA quality assessment."""

from __future__ import annotations

from typing import TypeAlias

import numpy as np
from numpy.typing import NDArray

from engine.pipeline.models import QualityScores
from engine.pipeline.preprocess import to_batch, to_chw

# Type alias for ONNX InferenceSession (avoid import at module level for testability)
OrtSession: TypeAlias = object  # onnxruntime.InferenceSession


class QualityAssessor:
    """Wraps CLIPIQA+ and HyperIQA ONNX models for image quality assessment.

    CLIPIQA+: float32 [1, 3, H, W] dynamic → [1, 1] score 0-1
    HyperIQA: float32 [1, 3, H, W] dynamic → [1, 1, 1] score 0-1
    """

    def __init__(
        self,
        clipiqa_session: OrtSession,
        hyperiqa_session: OrtSession,
        clipiqa_weight: float = 0.35,
        hyperiqa_weight: float = 0.65,
    ) -> None:
        self._clipiqa = clipiqa_session
        self._hyperiqa = hyperiqa_session
        self._clipiqa_weight = clipiqa_weight
        self._hyperiqa_weight = hyperiqa_weight

        # Cache I/O names
        self._clip_in: str = clipiqa_session.get_inputs()[0].name  # type: ignore[union-attr]
        self._clip_out: str = clipiqa_session.get_outputs()[0].name  # type: ignore[union-attr]
        self._hyper_in: str = hyperiqa_session.get_inputs()[0].name  # type: ignore[union-attr]
        self._hyper_out: str = hyperiqa_session.get_outputs()[0].name  # type: ignore[union-attr]

    def assess(self, crop: NDArray[np.float32]) -> QualityScores:
        """Assess quality of a bird crop using both IQA models.

        Args:
            crop: Bird crop [H, W, 3] float32 0-1.

        Returns:
            QualityScores with individual and combined scores.
        """
        input_tensor = to_batch(to_chw(crop))  # [1, 3, H, W]

        # CLIPIQA+: output [1, 1]
        clip_out = self._clipiqa.run(  # type: ignore[union-attr]
            [self._clip_out],
            {self._clip_in: input_tensor},
        )
        clip_score = float(clip_out[0].flat[0])

        # HyperIQA: output [1, 1, 1]
        hyper_out = self._hyperiqa.run(  # type: ignore[union-attr]
            [self._hyper_out],
            {self._hyper_in: input_tensor},
        )
        hyper_score = float(hyper_out[0].flat[0])

        # Clamp scores to [0, 1]
        clip_score = max(0.0, min(1.0, clip_score))
        hyper_score = max(0.0, min(1.0, hyper_score))

        combined = self._clipiqa_weight * clip_score + self._hyperiqa_weight * hyper_score

        return QualityScores(
            clipiqa=clip_score,
            hyperiqa=hyper_score,
            combined=combined,
        )
