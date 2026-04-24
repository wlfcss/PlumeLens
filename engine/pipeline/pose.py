# pyright: basic
"""Head/eye keypoint detection via bird_visibility (YOLO26l-pose)."""

from __future__ import annotations

from typing import TypeAlias

import numpy as np
from numpy.typing import NDArray

from engine.pipeline.models import Keypoint, PoseInfo
from engine.pipeline.preprocess import resize_letterbox, to_batch, to_chw

# Type alias for ONNX InferenceSession (avoid import at module level for testability)
OrtSession: TypeAlias = object  # onnxruntime.InferenceSession

# 关键点顺序固定：bill / crown / nape / left_eye / right_eye
# 与模型训练时一致，flip_idx = [0, 1, 2, 4, 3]
PART_NAMES: tuple[str, ...] = ("bill", "crown", "nape", "left_eye", "right_eye")
HEAD_PARTS: tuple[str, ...] = ("bill", "crown", "nape")
EYE_PARTS: tuple[str, ...] = ("left_eye", "right_eye")


class PoseDetector:
    """Wraps bird_visibility.onnx for head/eye keypoint detection.

    Model: bird_visibility v1.0 (YOLO26l-pose 衍生，28.6M 参数).

    Input:  float32 [1, 3, 640, 640] RGB 0-1, letterbox 114/255 填充
    Output: float32 [1, 300, 21] top-k 槽位
        每槽位 21 维 = 6 检测字段 (x1,y1,x2,y2,conf,cls) + 5×3 关键点 (x,y,conf)

    典型用法（方案 B，来自 YOLO det 的 crop 作为输入）：
        pose_info = pose_detector.detect(
            crop_image,              # YOLO det 的 bbox 裁切（含 padding）
            crop_origin=(x0, y0),    # crop 在原图中的左上角坐标（用于坐标还原）
        )

    派生二分类判定来自 MODEL_CARD §4.2，阈值来自 `bird_visibility_config.json`。
    """

    def __init__(
        self,
        session: OrtSession,
        input_size: int = 640,
        # crop 输入下 box_threshold 只用于"取最高置信度检测"，不作过滤；
        # 默认 0.05 对应校准值（单鸟场景）。多鸟全图模式应由调用方提高到 0.25。
        box_threshold: float = 0.05,
        eye_threshold: float = 0.45,
        head_threshold: float = 0.35,
        head_eye_threshold: float = 0.10,
        expanded_box_margin: float = 0.15,
    ) -> None:
        self._session = session
        self._input_size = input_size
        self._box_threshold = box_threshold
        self._eye_threshold = eye_threshold
        self._head_threshold = head_threshold
        self._head_eye_threshold = head_eye_threshold
        self._margin = expanded_box_margin
        # Cache input/output names
        self._input_name: str = session.get_inputs()[0].name  # type: ignore[union-attr]
        self._output_name: str = session.get_outputs()[0].name  # type: ignore[union-attr]

    def detect(
        self,
        crop_image: NDArray[np.float32],
        crop_origin: tuple[float, float] = (0.0, 0.0),
    ) -> PoseInfo | None:
        """Run keypoint detection on a single-bird crop.

        Args:
            crop_image: Pre-cropped image [H, W, 3] float32 0-1
                （由上游 YOLO det 按 bbox 裁切出的单鸟区域）
            crop_origin: crop 在原图中的左上角坐标 (x0, y0)；用于把
                关键点坐标还原到原图空间。crop_image 本身输入到模型前会
                再 letterbox 到 640。

        Returns:
            PoseInfo（坐标已还原到原图空间）；若置信度最高的检测低于
            阈值或为空，返回 None。
        """
        # Preprocess: letterbox to 640 → CHW → batch
        letterboxed, scale, (pad_top, pad_left) = resize_letterbox(
            crop_image, self._input_size
        )
        input_tensor = to_batch(to_chw(letterboxed))

        outputs = self._session.run(  # type: ignore[union-attr]
            [self._output_name],
            {self._input_name: input_tensor},
        )
        # shape: [1, 300, 21]；每行 21 维 = 6 检测 + 5×3 关键点
        raw: NDArray[np.float32] = outputs[0][0]  # [300, 21]

        # 取最高 conf 的那个检测作为本鸟（crop 输入下只关心一只）
        if raw.shape[0] == 0:
            return None
        best_idx = int(np.argmax(raw[:, 4]))
        det = raw[best_idx]
        box_conf = float(det[4])
        if box_conf < self._box_threshold:
            return None

        # 解析 bbox（letterbox 坐标系）
        bx1, by1, bx2, by2 = float(det[0]), float(det[1]), float(det[2]), float(det[3])

        # 解析 5 个关键点（letterbox 坐标系）
        kpt_raw = det[6:21].reshape(5, 3)  # [(x, y, conf) × 5]
        # 转换到原图坐标系（两次变换：letterbox → crop → 原图）
        crop_x0, crop_y0 = crop_origin
        kpts_by_name: dict[str, Keypoint] = {}
        for i, name in enumerate(PART_NAMES):
            lx, ly, kc = float(kpt_raw[i][0]), float(kpt_raw[i][1]), float(kpt_raw[i][2])
            # letterbox → crop 坐标
            cx = (lx - pad_left) / scale
            cy = (ly - pad_top) / scale
            # crop → 原图坐标
            ox = cx + crop_x0
            oy = cy + crop_y0
            kpts_by_name[name] = Keypoint(x=ox, y=oy, confidence=kc)

        # 在 crop 坐标系里做"框内"判定（bbox 也是 letterbox 坐标）
        # 转成 crop 空间做决策
        cb_x1 = (bx1 - pad_left) / scale
        cb_y1 = (by1 - pad_top) / scale
        cb_x2 = (bx2 - pad_left) / scale
        cb_y2 = (by2 - pad_top) / scale
        # 对应的关键点在 crop 空间坐标
        kpts_crop: dict[str, tuple[float, float, float]] = {
            name: (
                (float(kpt_raw[i][0]) - pad_left) / scale,
                (float(kpt_raw[i][1]) - pad_top) / scale,
                float(kpt_raw[i][2]),
            )
            for i, name in enumerate(PART_NAMES)
        }

        head_vis, eye_vis = self._judge_visibility(
            (cb_x1, cb_y1, cb_x2, cb_y2), kpts_crop
        )

        return PoseInfo(
            bill=kpts_by_name["bill"],
            crown=kpts_by_name["crown"],
            nape=kpts_by_name["nape"],
            left_eye=kpts_by_name["left_eye"],
            right_eye=kpts_by_name["right_eye"],
            head_visible=head_vis,
            eye_visible=eye_vis,
        )

    def _judge_visibility(
        self,
        bbox: tuple[float, float, float, float],
        kpts: dict[str, tuple[float, float, float]],
    ) -> tuple[bool, bool]:
        """实现 MODEL_CARD §4.2 的 head/eye 可见性决策规则。

        Args:
            bbox: (x1, y1, x2, y2) 检测框（与 kpts 同坐标系）
            kpts: {name: (x, y, conf)}

        Returns:
            (head_visible, eye_visible)
        """
        x1, y1, x2, y2 = bbox
        w = max(1e-6, x2 - x1)
        h = max(1e-6, y2 - y1)
        mx = self._margin * w
        my = self._margin * h

        def in_box(xy: tuple[float, float]) -> bool:
            x, y = xy
            return x1 - mx <= x <= x2 + mx and y1 - my <= y <= y2 + my

        # Eye 可见：任一眼 conf ≥ eye_threshold 且位于扩展框内
        eye_visible = any(
            kpts[n][2] >= self._eye_threshold and in_box((kpts[n][0], kpts[n][1]))
            for n in EYE_PARTS
        )

        # Head 可见：≥2 个 head_parts 高置信 且在框内，或
        #           ≥1 个 head_part 高置信 + ≥1 个 eye_part conf ≥ head_eye_threshold 且在框内
        head_hits = sum(
            1
            for n in HEAD_PARTS
            if kpts[n][2] >= self._head_threshold and in_box((kpts[n][0], kpts[n][1]))
        )
        eye_hits_for_head = sum(
            1
            for n in EYE_PARTS
            if kpts[n][2] >= self._head_eye_threshold and in_box((kpts[n][0], kpts[n][1]))
        )
        head_visible = head_hits >= 2 or (head_hits >= 1 and eye_hits_for_head >= 1)

        return head_visible, eye_visible
