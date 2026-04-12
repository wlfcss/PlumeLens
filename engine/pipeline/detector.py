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

    Input:  float32 [1, 3, 1440, 1440] RGB 0-1
    Output: float32 [1, 300, 6] → (x1, y1, x2, y2, conf, class_id)
    """

    def __init__(self, session: OrtSession, input_size: int = 1440) -> None:
        self._session = session
        self._input_size = input_size
        # Cache input/output names
        self._input_name: str = session.get_inputs()[0].name  # type: ignore[union-attr]
        self._output_name: str = session.get_outputs()[0].name  # type: ignore[union-attr]

    def detect(
        self,
        image: NDArray[np.float32],
        confidence_threshold: float = 0.35,
    ) -> list[BoundingBox]:
        """Run bird detection on an image.

        Args:
            image: Input image [H, W, 3] float32 0-1.
            confidence_threshold: Minimum confidence to keep a detection.

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

        return boxes
