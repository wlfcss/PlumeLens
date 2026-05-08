# pyright: basic
"""Dual-model IQA: CLIPIQA+ and HyperIQA quality assessment."""

from __future__ import annotations

import math
from typing import TypeAlias

import numpy as np
from numpy.typing import NDArray
from PIL import Image

from engine.pipeline.models import QualityScores

# Type alias for ONNX InferenceSession (avoid import at module level for testability)
OrtSession: TypeAlias = object  # onnxruntime.InferenceSession

# pyiqa 的 CLIPIQA+/HyperIQA ONNX 图内部已经做各自的 normalization
# （CLIPIQA+ 用 CLIP mean/std，HyperIQA 用 ImageNet mean/std）。
# 这里仅负责把任意 crop 变成 raw RGB 0-1 的 224×224 tensor。
IQA_INPUT_SIZE = 224
IQA_NONFINITE_FALLBACK_SCORE = 0.5


def _preprocess_for_iqa(crop: NDArray[np.float32]) -> NDArray[np.float32]:
    """Resize to 224×224 raw RGB 0-1 + CHW + batch → [1, 3, 224, 224]."""
    pil = Image.fromarray((crop * 255).astype(np.uint8))
    pil = pil.resize((IQA_INPUT_SIZE, IQA_INPUT_SIZE), Image.Resampling.BICUBIC)
    arr = np.asarray(pil, dtype=np.float32) / 255.0
    chw = np.ascontiguousarray(arr.transpose(2, 0, 1))
    return chw[np.newaxis, ...]


def _sanitize_iqa_score(value: float) -> float:
    if not math.isfinite(value):
        return IQA_NONFINITE_FALLBACK_SCORE
    return max(0.0, min(1.0, value))


class QualityAssessor:
    """Wraps CLIPIQA+ and HyperIQA ONNX models for image quality assessment.

    Both models: float32 [1, 3, 224, 224] raw RGB 0-1 → [1, 1] score 0-1.
    Input crops are auto-resized in this class. ImageNet normalization lives inside
    the exported PyIQA ONNX graphs, so callers must not normalize before inference.

    CLIPIQA+ is fed a larger semantic/composition crop; HyperIQA is fed a tighter
    technical crop around the bird subject.
    """

    def __init__(
        self,
        clipiqa_session: OrtSession,
        hyperiqa_session: OrtSession,
        clipiqa_weight: float = 0.40,
        hyperiqa_weight: float = 0.60,
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

    def assess(
        self,
        semantic_crop: NDArray[np.float32],
        technical_crop: NDArray[np.float32] | None = None,
    ) -> QualityScores:
        """Assess quality using separate semantic and technical crops.

        Args:
            semantic_crop: Larger crop [H, W, 3] for CLIPIQA+.
            technical_crop: Tighter subject crop [H, W, 3] for HyperIQA.
                When omitted, falls back to semantic_crop for backward compatibility.

        Returns:
            QualityScores with individual and combined scores.
        """
        semantic_tensor = _preprocess_for_iqa(semantic_crop)
        technical_tensor = _preprocess_for_iqa(
            technical_crop if technical_crop is not None else semantic_crop
        )

        # CLIPIQA+: semantic / composition quality, output [1, 1]
        clip_out = self._clipiqa.run(  # type: ignore[union-attr]
            [self._clip_out],
            {self._clip_in: semantic_tensor},
        )
        clip_score = float(clip_out[0].flat[0])

        # HyperIQA: technical subject quality, output [1, 1]
        hyper_out = self._hyperiqa.run(  # type: ignore[union-attr]
            [self._hyper_out],
            {self._hyper_in: technical_tensor},
        )
        hyper_score = float(hyper_out[0].flat[0])

        # Clamp scores to [0, 1]. NaN/Inf must be handled before max/min:
        # Python comparisons leave NaN untouched, which would poison grading.
        clip_score = _sanitize_iqa_score(clip_score)
        hyper_score = _sanitize_iqa_score(hyper_score)

        combined = self._clipiqa_weight * clip_score + self._hyperiqa_weight * hyper_score

        return QualityScores(
            clipiqa=clip_score,
            hyperiqa=hyper_score,
            combined=combined,
        )
