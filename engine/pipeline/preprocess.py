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
    """Load standard image via Pillow."""
    with Image.open(path) as img:
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


def resize_letterbox(
    image: NDArray[np.float32],
    target_size: int,
) -> tuple[NDArray[np.float32], float, tuple[int, int]]:
    """Resize image with letterboxing to fit target_size x target_size.

    Args:
        image: Input image [H, W, 3] float32 0-1.
        target_size: Target square dimension (e.g. 1440).

    Returns:
        (resized_image, scale, (pad_top, pad_left))
    """
    h, w = image.shape[:2]
    scale = target_size / max(h, w)

    new_h = int(h * scale)
    new_w = int(w * scale)

    # Resize via Pillow (better quality than naive numpy resize)
    pil_img = Image.fromarray((image * 255).astype(np.uint8))
    pil_resized = pil_img.resize((new_w, new_h), Image.Resampling.LANCZOS)
    resized = np.asarray(pil_resized, dtype=np.float32) / 255.0

    # Create letterboxed canvas (pad with 0.5 gray, common for YOLO)
    canvas = np.full((target_size, target_size, 3), 0.5, dtype=np.float32)
    pad_top = (target_size - new_h) // 2
    pad_left = (target_size - new_w) // 2
    canvas[pad_top : pad_top + new_h, pad_left : pad_left + new_w] = resized

    return canvas, scale, (pad_top, pad_left)


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
