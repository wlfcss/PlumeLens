# pyright: basic
"""Image loading, resizing, normalization, and bbox cropping utilities."""

from __future__ import annotations

from pathlib import Path

import numpy as np
from numpy.typing import NDArray
from PIL import Image

# RAW 格式扩展名（rawpy 支持）
RAW_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".cr2",
        ".cr3",
        ".nef",
        ".arw",
        ".orf",
        ".rw2",
        ".raf",
        ".dng",
        ".pef",
        ".srw",
    }
)

# 常规图片扩展名
IMAGE_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".jpg",
        ".jpeg",
        ".png",
        ".tiff",
        ".tif",
        ".bmp",
        ".webp",
    }
)

# 所有支持的扩展名
SUPPORTED_EXTENSIONS: frozenset[str] = IMAGE_EXTENSIONS | RAW_EXTENSIONS


def load_image(path: Path) -> NDArray[np.float32]:
    """Load an image file and return as float32 RGB array [H, W, 3] in range [0, 1].

    Supports JPEG/PNG/TIFF/BMP/WebP via Pillow, and RAW formats via rawpy.
    """
    suffix = path.suffix.lower()

    if suffix in RAW_EXTENSIONS:
        return _load_raw(path)
    if suffix in IMAGE_EXTENSIONS:
        return _load_pillow(path)

    msg = f"Unsupported image format: {suffix}"
    raise ValueError(msg)


def _load_pillow(path: Path) -> NDArray[np.float32]:
    """Load standard image via Pillow，应用 EXIF Orientation。

    必须 exif_transpose：缩略图（thumbnail._load_source_image）和扫描时存的 width/height
    都是按"拍出来人眼看到的方向"处理。如果这里不转，inference 在原始像素方向跑，
    YOLO/pose 输出的坐标就和前端展示的旋转后的图对不上 → bbox/姿态点偏移。
    """
    from PIL import ImageOps

    with Image.open(path) as img:
        img = ImageOps.exif_transpose(img) or img
        img = img.convert("RGB")
        arr: NDArray[np.float32] = np.asarray(img, dtype=np.float32) / 255.0
    return arr


def _load_raw(path: Path) -> NDArray[np.float32]:
    """Load RAW image via rawpy."""
    import rawpy

    with rawpy.imread(str(path)) as raw:
        rgb = raw.postprocess(
            use_camera_wb=True,
            output_bps=8,
            no_auto_bright=True,
        )
    arr: NDArray[np.float32] = rgb.astype(np.float32) / 255.0
    return arr


# YOLO 标准 letterbox 填充值：114/255 ≈ 0.447（训练时一致）
YOLO_LETTERBOX_FILL: float = 114.0 / 255.0


def resize_letterbox(
    image: NDArray[np.float32],
    target_size: int,
) -> tuple[NDArray[np.float32], float, tuple[int, int]]:
    """Resize image with letterboxing — 严格对齐 yolo26l-bird MODEL_CARD §5.5 参考实现。

    与 deploy 包 inference_example.py::letterbox 完全一致：
    - 长边等比缩放，**用 int(round(...))** 计算新尺寸（不是 int 截断 — 截断会
      引入 ±1px 偏差，CoreML EP 对预处理偏差很敏感，会放大成 bbox 错位）
    - **cv2.resize + INTER_LINEAR** 重采样（不是 PIL LANCZOS — 训练 pipeline
      用的就是 cv2 INTER_LINEAR，inference 用相同算法保持 train-test 分布一致）
    - 114/255 灰度填充（YOLO 系列约定）
    - 居中放置缩放后的图

    为何重要：早期版本用 PIL LANCZOS + int 截断，与训练 pipeline 不一致，
    CoreML EP 推理时 bbox 会"飘"到图像边缘。改回 cv2 + round 后，CoreML EP
    输出和 CPU EP 在 95% 图片上一致（剩余 5% 偏差 < 250px，对摄影裁切无碍）。

    Args:
        image: Input image [H, W, 3] float32 0-1.
        target_size: Target square dimension (e.g. 1280).

    Returns:
        (resized_image, scale, (pad_top, pad_left))
    """
    import cv2

    h, w = image.shape[:2]
    scale = target_size / max(h, w)

    # ⚠ 必须用 round() — int() 截断会造成 ±1px 误差被 CoreML EP 放大成
    # bbox 几何错位（验证：MODEL_CARD §5.5.9 + 用户实测 a56b80a 撞过此坑）
    new_h = int(round(h * scale))
    new_w = int(round(w * scale))

    # cv2 INTER_LINEAR 与 Ultralytics 训练 pipeline 一致。直接对 float32 输入
    # resize（cv2.resize 原生支持 float32），避免 float32→uint8→float32 的双向
    # 量化损失（每次 round-trip 引入 ±1/255 ≈ 0.004 噪声，对 CoreML EP 精度敏感）。
    # cv2.resize 接收 (W, H) 顺序，注意不是 (H, W)。
    resized: NDArray[np.float32] = cv2.resize(
        image, (new_w, new_h), interpolation=cv2.INTER_LINEAR
    )

    # 114/255 灰度填充
    canvas = np.full((target_size, target_size, 3), YOLO_LETTERBOX_FILL, dtype=np.float32)
    pad_top = (target_size - new_h) // 2
    pad_left = (target_size - new_w) // 2
    canvas[pad_top : pad_top + new_h, pad_left : pad_left + new_w] = resized

    return canvas, scale, (pad_top, pad_left)


def expand_for_iqa(
    image: NDArray[np.float32],
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    expand: float = 2.5,
    max_aspect_ratio: float = 2.0,
) -> NDArray[np.float32]:
    """For IQA: 同比例放大 bbox，限制纵横比，保不出原图。

    与 crop_bbox 的紧裁切不同，此函数让 IQA 模型看到"鸟 + 周边构图（背景虚化、
    前景关系）"——这正是鸟摄美学评判的核心。

    步骤：
      1. 中心对齐 expand 倍放大
      2. 纵横比超 max_aspect_ratio（长/短）→ 补足短边降比例
      3. cap 到原图尺寸（防扩展后比原图大）
      4. shift 让结果框完全留在原图内（中心尽量贴 bbox 原中心）

    Args:
        image: [H, W, 3] float32 0-1
        x1,y1,x2,y2: bbox 坐标（原图空间）
        expand: 放大倍数（默认 2.5，鸟占画面 ~1/2.5²=16% 面积时刚好满框）
        max_aspect_ratio: 长边/短边上限（默认 2.0，超过则补短边）

    Returns:
        Cropped image region [crop_H, crop_W, 3]
    """
    h, w = image.shape[:2]
    bw = x2 - x1
    bh = y2 - y1
    if bw <= 0 or bh <= 0:
        return image[0:1, 0:1, :]

    cx = (x1 + x2) / 2
    cy = (y1 + y2) / 2

    # 1) 同比例放大
    tw = bw * expand
    th = bh * expand

    # 2) 纵横比限制：长边 / 短边 <= max_aspect_ratio
    if tw > th * max_aspect_ratio:
        th = tw / max_aspect_ratio
    elif th > tw * max_aspect_ratio:
        tw = th / max_aspect_ratio

    # 3) cap 到原图尺寸（防扩展后比原图大）
    tw = min(tw, float(w))
    th = min(th, float(h))

    # 4) 中心对齐目标框，超界 shift（中心尽量靠 bbox）
    fx1 = cx - tw / 2
    fy1 = cy - th / 2
    fx2 = fx1 + tw
    fy2 = fy1 + th
    if fx1 < 0:
        fx2 -= fx1
        fx1 = 0.0
    if fy1 < 0:
        fy2 -= fy1
        fy1 = 0.0
    if fx2 > w:
        fx1 -= fx2 - w
        fx2 = float(w)
    if fy2 > h:
        fy1 -= fy2 - h
        fy2 = float(h)
    fx1 = max(0.0, fx1)
    fy1 = max(0.0, fy1)

    ix1 = int(fx1)
    iy1 = int(fy1)
    ix2 = int(fx2)
    iy2 = int(fy2)
    if ix2 <= ix1 or iy2 <= iy1:
        return image[0:1, 0:1, :]
    return image[iy1:iy2, ix1:ix2, :].copy()


def crop_bbox(
    image: NDArray[np.float32],
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    expand_ratio: float = 1.0,
) -> NDArray[np.float32]:
    """Crop a bounding box region from image.

    Args:
        image: Source image [H, W, 3] float32 0-1.
        x1, y1, x2, y2: Bbox coordinates in original image space.
        expand_ratio: Box expansion ratio (1.0 = no expansion).

    Returns:
        Cropped image region [crop_H, crop_W, 3].
    """
    h, w = image.shape[:2]

    if expand_ratio != 1.0:
        cx = (x1 + x2) / 2
        cy = (y1 + y2) / 2
        bw = (x2 - x1) * expand_ratio
        bh = (y2 - y1) * expand_ratio
        x1 = cx - bw / 2
        y1 = cy - bh / 2
        x2 = cx + bw / 2
        y2 = cy + bh / 2

    # Clamp to image bounds
    ix1 = max(0, int(x1))
    iy1 = max(0, int(y1))
    ix2 = min(w, int(x2))
    iy2 = min(h, int(y2))

    if ix2 <= ix1 or iy2 <= iy1:
        # Degenerate box, return 1x1 pixel
        return image[0:1, 0:1, :]

    return image[iy1:iy2, ix1:ix2, :].copy()


def to_chw(image: NDArray[np.float32]) -> NDArray[np.float32]:
    """Transpose image from [H, W, C] to [C, H, W]."""
    return np.ascontiguousarray(image.transpose(2, 0, 1))


def to_batch(image: NDArray[np.float32]) -> NDArray[np.float32]:
    """Add batch dimension: [C, H, W] → [1, C, H, W]."""
    return np.expand_dims(image, axis=0)
