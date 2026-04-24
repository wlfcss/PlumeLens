# pyright: basic
"""Bird species classification via DINOv3 ViT-L + 7-head ensemble."""

from __future__ import annotations

from pathlib import Path
from typing import TypeAlias

import numpy as np
from numpy.typing import NDArray
from PIL import Image

from engine.pipeline.models import SpeciesCandidate

OrtSession: TypeAlias = object  # onnxruntime.InferenceSession

# ImageNet 标准化参数（DINOv3 训练一致）
IMAGENET_MEAN: tuple[float, float, float] = (0.485, 0.456, 0.406)
IMAGENET_STD: tuple[float, float, float] = (0.229, 0.224, 0.225)

# DINOv3 双尺度
SCALES: tuple[int, int] = (512, 640)

# 低于该值的候选视为"未训练类别偶然命中"，由调用方过滤掉。
# 1/1516 ≈ 0.00066，未训练类别的 softmax 通常接近均匀；0.01 是保守下限。
DEFAULT_MIN_CONFIDENCE: float = 0.01


def expand_bbox_to_square(
    xc_norm: float,
    yc_norm: float,
    w_norm: float,
    h_norm: float,
    image_w: int,
    image_h: int,
    margin: float = 0.15,
    min_side_frac: float = 0.30,
) -> tuple[int, int, int, int]:
    """YOLO/VLM 归一化 bbox → 原图像素空间的方形裁切（含 15% margin）。

    来自 dinov3 MODEL_DELIVERY §6.3。所有计算**必须在像素空间**，
    混用 W-归一化 / H-归一化是历史 bug 源头。

    Args:
        xc_norm, yc_norm, w_norm, h_norm: 归一化 bbox 中心和宽高（0-1）
        image_w, image_h: 原图像素尺寸
        margin: 边界扩展比例（15% 默认）
        min_side_frac: 最小方形边长占原图短边的比例（防小目标失真）

    Returns:
        (l, t, r, b) 原图像素坐标（方形）
    """
    cx = xc_norm * image_w
    cy = yc_norm * image_h
    w_px = w_norm * image_w * (1 + margin)
    h_px = h_norm * image_h * (1 + margin)
    side = max(w_px, h_px, min_side_frac * min(image_w, image_h))
    side = min(side, float(min(image_w, image_h)))
    cx = min(max(cx, side / 2), image_w - side / 2)
    cy = min(max(cy, side / 2), image_h - side / 2)
    return (
        int(round(cx - side / 2)),
        int(round(cy - side / 2)),
        int(round(cx + side / 2)),
        int(round(cy + side / 2)),
    )


def preprocess_for_dinov3(
    image: NDArray[np.float32], size: int
) -> NDArray[np.float32]:
    """Resize + CenterCrop + ImageNet normalize，对标原项目 predictor.py。

    Args:
        image: RGB 图像 [H, W, 3] float32 0-1（已裁切到方形区域）
        size: 目标尺寸（512 或 640）

    Returns:
        [1, 3, size, size] float32，已 ImageNet 标准化
    """
    # 转 PIL 做 Resize(short side = size) + CenterCrop 以匹配原项目 torchvision 流程
    pil = Image.fromarray((image * 255).astype(np.uint8))
    w, h = pil.size
    if w < h:
        new_w, new_h = size, int(round(h * size / w))
    else:
        new_w, new_h = int(round(w * size / h)), size
    pil = pil.resize((new_w, new_h), Image.Resampling.BICUBIC)
    # CenterCrop
    left = (new_w - size) // 2
    top = (new_h - size) // 2
    pil = pil.crop((left, top, left + size, top + size))

    arr: NDArray[np.float32] = np.asarray(pil, dtype=np.float32) / 255.0
    # ImageNet 标准化
    mean = np.asarray(IMAGENET_MEAN, dtype=np.float32).reshape(1, 1, 3)
    std = np.asarray(IMAGENET_STD, dtype=np.float32).reshape(1, 1, 3)
    arr = (arr - mean) / std
    # HWC → CHW → batch
    chw = np.ascontiguousarray(arr.transpose(2, 0, 1))
    return chw[np.newaxis, ...]  # [1, 3, size, size]


class SpeciesTaxonomy:
    """轻量 parquet 读取器（用 pyarrow，避免引入 polars 重依赖）。"""

    def __init__(self, parquet_path: Path) -> None:
        import pyarrow.parquet as pq  # lazy import

        table = pq.read_table(str(parquet_path))
        # 按 canonical_sci 字典序排序，与模型训练时的 head 索引对齐
        rows = table.to_pylist()
        rows.sort(key=lambda r: r["canonical_sci"])
        self._rows: list[dict] = rows
        self._sci_to_row: dict[str, dict] = {r["canonical_sci"]: r for r in rows}

    def __len__(self) -> int:
        return len(self._rows)

    def sci_at(self, index: int) -> str:
        """Get canonical_sci at numeric index (model output index → species name)."""
        return self._rows[index]["canonical_sci"]

    def lookup(self, sci: str) -> dict | None:
        return self._sci_to_row.get(sci)


class SpeciesClassifier:
    """Orchestrate DINOv3 backbone + 7-head ensemble for species classification.

    Model: DINOv3-ViT-L/16 (frozen) + 7-head ensemble (4×512 + 3×640 seeds).

    Inputs (per call):
        - cropped image [H, W, 3] float32 0-1（由上游按方形化 bbox 裁切）

    Pipeline:
        1. For each scale in {512, 640}:
           preprocess → backbone ONNX → 2048-d feature
        2. ensemble ONNX(feat_512, feat_640) → [1, 1516] softmax
        3. top-K → taxonomy 元数据

    输入约束：调用方必须先用 expand_bbox_to_square() 把 YOLO bbox 转成方形 +
    margin 的 crop，再传入本类。

    **训练类过滤**：head 输出 1516 维对齐《中国鸟类名录 v12.0》全名单，但实际
    训练仅 1018 种有数据（另 498 个槽位权重保留在初始化状态）。构造时可传入
    trained_sci 集合，推理时把未训练类的概率清零，避免偶然的高分误报。
    """

    def __init__(
        self,
        backbone_session: OrtSession,
        ensemble_session: OrtSession,
        taxonomy: SpeciesTaxonomy,
        top_k: int = 5,
        min_confidence: float = DEFAULT_MIN_CONFIDENCE,
        trained_sci: set[str] | None = None,
    ) -> None:
        self._backbone = backbone_session
        self._ensemble = ensemble_session
        self._taxonomy = taxonomy
        self._top_k = top_k
        self._min_confidence = min_confidence

        # 预计算未训练类的 index mask（O(1) 查询）
        self._trained_mask: NDArray[np.bool_] | None = None
        if trained_sci is not None:
            mask = np.zeros(len(taxonomy), dtype=bool)
            for idx in range(len(taxonomy)):
                if taxonomy.sci_at(idx) in trained_sci:
                    mask[idx] = True
            self._trained_mask = mask

        # Cache IO names
        self._bb_in: str = backbone_session.get_inputs()[0].name  # type: ignore[union-attr]
        self._bb_out: str = backbone_session.get_outputs()[0].name  # type: ignore[union-attr]
        en_inputs = ensemble_session.get_inputs()  # type: ignore[union-attr]
        # Order: ("feat_512", "feat_640") — keep whatever order the export produced
        self._en_in_names: list[str] = [i.name for i in en_inputs]
        self._en_out: str = ensemble_session.get_outputs()[0].name  # type: ignore[union-attr]

    def classify(self, crop: NDArray[np.float32]) -> list[SpeciesCandidate]:
        """Run full DINOv3 pipeline on a cropped bird image.

        Args:
            crop: [H, W, 3] float32 0-1 (RGB, square-expanded bbox crop)

        Returns:
            Top-K SpeciesCandidate list (confidence 降序)。
            低于 min_confidence 的条目会被过滤，因此返回长度 ≤ top_k。
        """
        # 双尺度特征
        feats: dict[str, NDArray[np.float32]] = {}
        for size in SCALES:
            x = preprocess_for_dinov3(crop, size)
            out = self._backbone.run(  # type: ignore[union-attr]
                [self._bb_out], {self._bb_in: x}
            )
            feats[f"feat_{size}"] = out[0]  # (1, 2048)

        # Ensemble forward；按 ONNX 实际输入名组装 feed dict
        feed = {name: feats[name] for name in self._en_in_names}
        probs_out = self._ensemble.run([self._en_out], feed)  # type: ignore[union-attr]
        probs: NDArray[np.float32] = probs_out[0][0].copy()  # (1516,)

        # Zero out untrained classes so they never surface in top-K
        if self._trained_mask is not None:
            probs[~self._trained_mask] = 0.0

        # Top-K
        k = min(self._top_k, probs.shape[0])
        top_idx = np.argsort(probs)[-k:][::-1]

        candidates: list[SpeciesCandidate] = []
        for idx in top_idx:
            conf = float(probs[int(idx)])
            if conf < self._min_confidence:
                continue
            sci = self._taxonomy.sci_at(int(idx))
            meta = self._taxonomy.lookup(sci) or {}
            candidates.append(
                SpeciesCandidate(
                    canonical_sci=sci,
                    canonical_zh=meta.get("canonical_zh"),
                    canonical_en=meta.get("canonical_en"),
                    family_sci=meta.get("family_sci"),
                    family_zh=meta.get("family_zh"),
                    order_sci=meta.get("order_sci"),
                    iucn=meta.get("iucn"),
                    protect_level=meta.get("protect_level"),
                    confidence=conf,
                )
            )
        return candidates
