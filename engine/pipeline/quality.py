# pyright: basic
"""Dual-model IQA: CLIPIQA+ and HyperIQA quality assessment."""

from __future__ import annotations

from typing import TypeAlias

import numpy as np
from numpy.typing import NDArray
from PIL import Image

from engine.pipeline.models import QualityScores

# Type alias for ONNX InferenceSession (avoid import at module level for testability)
OrtSession: TypeAlias = object  # onnxruntime.InferenceSession

# 两个 IQA 模型都基于 ImageNet 预训练（CLIP ViT / ResNet50），需一致的归一化
IMAGENET_MEAN: tuple[float, float, float] = (0.485, 0.456, 0.406)
IMAGENET_STD: tuple[float, float, float] = (0.229, 0.224, 0.225)

# pyiqa 的 HyperIQA.forward_patch 假设 224×224 单裁切；CLIPIQA+ 内部也按 224 处理
IQA_INPUT_SIZE = 224


def _preprocess_for_iqa(crop: NDArray[np.float32]) -> NDArray[np.float32]:
    """Resize to 224×224 + ImageNet normalize + CHW + batch → [1, 3, 224, 224]."""
    pil = Image.fromarray((crop * 255).astype(np.uint8))
    pil = pil.resize((IQA_INPUT_SIZE, IQA_INPUT_SIZE), Image.Resampling.BICUBIC)
    arr = np.asarray(pil, dtype=np.float32) / 255.0
    mean = np.asarray(IMAGENET_MEAN, dtype=np.float32).reshape(1, 1, 3)
    std = np.asarray(IMAGENET_STD, dtype=np.float32).reshape(1, 1, 3)
    arr = (arr - mean) / std
    chw = np.ascontiguousarray(arr.transpose(2, 0, 1))
    return chw[np.newaxis, ...]


class QualityAssessor:
    """Wraps CLIPIQA+ and HyperIQA ONNX models for image quality assessment.

    Both models: float32 [1, 3, 224, 224] ImageNet-normalized → [1, 1] score 0-1.
    Input crops are auto-resized + normalized inside this class.
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
            crop: Bird crop [H, W, 3] float32 0-1 (raw RGB pixels).

        Returns:
            QualityScores with individual and combined scores.
        """
        input_tensor = _preprocess_for_iqa(crop)  # [1, 3, 224, 224] normalized

        # CLIPIQA+: output [1, 1]
        clip_out = self._clipiqa.run(  # type: ignore[union-attr]
            [self._clip_out],
            {self._clip_in: input_tensor},
        )
        clip_score = float(clip_out[0].flat[0])

        # HyperIQA: output [1, 1]（forward_patch 最后 squeeze(-1) 后的形状）
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
