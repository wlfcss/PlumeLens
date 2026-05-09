# pyright: basic
"""YOLO bird detection model wrapper."""

from __future__ import annotations

from typing import TypeAlias

import numpy as np
from numpy.typing import NDArray

from engine.pipeline.models import BoundingBox
from engine.pipeline.preprocess import resize_letterbox, to_batch, to_chw

# Type alias for ONNX InferenceSession (avoid import at module level for testability)
OrtSession: TypeAlias = object  # onnxruntime.InferenceSession


class BirdDetector:
    """Wraps YOLOv26l-bird-det.onnx for bird detection.

    Model: yolo26l-bird v1.1 (single class, NMS-free end-to-end).

    Input:  float32 [1, 3, 1280, 1280] RGB 0-1, letterboxed with 114/255 fill
    Output: float32 [1, 300, 6] → (x1, y1, x2, y2, conf, class_id)
            Top-k 300 slots (NMS-free end-to-end); low-confidence slots filled
            with conf ~0 and filtered by caller. Bbox in letterboxed coords.
    """

    def __init__(
        self,
        session: OrtSession,
        input_size: int = 1280,
        iou_dedup_threshold: float = 0.5,
    ) -> None:
        self._session = session
        self._input_size = input_size
        # YOLO26 NMS-free 模型在密集场景（花丛/鸟群）仍可能 over-detect 同一只鸟，
        # 输出多个高度重叠的 bbox。本阈值用于 confidence 过滤后的 IoU dedup。
        self._iou_dedup_threshold = iou_dedup_threshold
        # Cache input/output names
        self._input_name: str = session.get_inputs()[0].name  # type: ignore[union-attr]
        self._output_name: str = session.get_outputs()[0].name  # type: ignore[union-attr]

    def detect(
        self,
        image: NDArray[np.float32],
        confidence_threshold: float = 0.5,
    ) -> list[BoundingBox]:
        """Run bird detection on an image.

        Args:
            image: Input image [H, W, 3] float32 0-1.
            confidence_threshold: Minimum confidence to keep a detection.
                0.5 for photography (recommended), 0.25 for high-recall.

        Returns:
            List of BoundingBox in original image coordinates.
        """
        orig_h, orig_w = image.shape[:2]

        # Preprocess: letterbox resize → CHW → batch
        letterboxed, scale, (pad_top, pad_left) = resize_letterbox(image, self._input_size)
        input_tensor = to_batch(to_chw(letterboxed))

        # Run inference
        outputs = self._session.run(  # type: ignore[union-attr]
            [self._output_name],
            {self._input_name: input_tensor},
        )
        # outputs[0] shape: [1, 300, 6] → (x1, y1, x2, y2, conf, class_id)
        # 300 是导出时的 top-k 槽位；NMS-free 但空槽位 conf≈0，由下游阈值过滤
        raw_dets: NDArray[np.float32] = outputs[0][0]  # [300, 6]

        # Filter by confidence
        boxes: list[BoundingBox] = []
        for det in raw_dets:
            conf = float(det[4])
            if conf < confidence_threshold:
                continue

            # Convert from letterboxed coords to original image coords
            lx1, ly1, lx2, ly2 = det[0], det[1], det[2], det[3]
            ox1 = (float(lx1) - pad_left) / scale
            oy1 = (float(ly1) - pad_top) / scale
            ox2 = (float(lx2) - pad_left) / scale
            oy2 = (float(ly2) - pad_top) / scale

            # Clamp to image bounds
            ox1 = max(0.0, min(float(orig_w), ox1))
            oy1 = max(0.0, min(float(orig_h), oy1))
            ox2 = max(0.0, min(float(orig_w), ox2))
            oy2 = max(0.0, min(float(orig_h), oy2))

            if ox2 > ox1 and oy2 > oy1:
                boxes.append(
                    BoundingBox(
                        x1=ox1,
                        y1=oy1,
                        x2=ox2,
                        y2=oy2,
                        confidence=conf,
                        class_id=int(det[5]),
                    )
                )

        return _dedup_iou(boxes, self._iou_dedup_threshold)


def _iou(a: BoundingBox, b: BoundingBox) -> float:
    """Intersection-over-Union of two axis-aligned boxes (original image coords)."""
    inter_x1 = max(a.x1, b.x1)
    inter_y1 = max(a.y1, b.y1)
    inter_x2 = min(a.x2, b.x2)
    inter_y2 = min(a.y2, b.y2)
    inter_w = max(0.0, inter_x2 - inter_x1)
    inter_h = max(0.0, inter_y2 - inter_y1)
    inter = inter_w * inter_h
    if inter <= 0:
        return 0.0
    area_a = (a.x2 - a.x1) * (a.y2 - a.y1)
    area_b = (b.x2 - b.x1) * (b.y2 - b.y1)
    union = area_a + area_b - inter
    if union <= 0:
        return 0.0
    return inter / union


def _dedup_iou(boxes: list[BoundingBox], iou_threshold: float) -> list[BoundingBox]:
    """Greedy NMS-style dedup: drop boxes whose IoU with any already-kept higher-conf
    box exceeds the threshold. Used as a defensive post-process for YOLO26 NMS-free
    output, which may still emit near-duplicate bboxes in dense bird scenes.

    v1.1 inherits the v1.0.1 post-process threshold of 0.5: observed ghost
    duplicates are IoU >0.95, while legitimate adjacent birds are typically
    below 0.2 in the validation notes.
    """
    if iou_threshold >= 1.0 or len(boxes) <= 1:
        return boxes
    sorted_boxes = sorted(boxes, key=lambda b: b.confidence, reverse=True)
    kept: list[BoundingBox] = []
    for box in sorted_boxes:
        if all(_iou(box, k) <= iou_threshold for k in kept):
            kept.append(box)
    return kept
