"""A single display-orientation convention for RAW metadata, previews and inference."""

from pathlib import Path

import numpy as np
from numpy.typing import NDArray
from PIL import Image

_TRANSPOSE = {
    2: Image.Transpose.FLIP_LEFT_RIGHT,
    3: Image.Transpose.ROTATE_180,
    4: Image.Transpose.FLIP_TOP_BOTTOM,
    5: Image.Transpose.TRANSPOSE,
    6: Image.Transpose.ROTATE_270,
    7: Image.Transpose.TRANSVERSE,
    8: Image.Transpose.ROTATE_90,
}
# LibRaw flip values describe the rotation applied by default postprocess.
_RAW_FLIP_TO_EXIF = {0: 1, 3: 3, 5: 8, 6: 6}


def exif_orientation(image: Image.Image) -> int | None:
    try:
        value = image.getexif().get(0x0112)
        return int(value) if value is not None and int(value) in range(1, 9) else None
    except (OSError, ValueError, TypeError):
        return None


def raw_orientation(path: Path, raw_flip: int) -> int:
    """Prefer explicit EXIF; retain LibRaw's internal orientation when PIL cannot read it."""
    try:
        with Image.open(path) as probe:
            orientation = exif_orientation(probe)
        if orientation is not None:
            return orientation
    except (OSError, ValueError):
        pass
    return _RAW_FLIP_TO_EXIF.get(raw_flip, 1)


def orient_image(image: Image.Image, orientation: int) -> Image.Image:
    operation = _TRANSPOSE.get(orientation)
    return image.transpose(operation) if operation is not None else image


def orient_array(arr: NDArray[np.uint8], orientation: int) -> NDArray[np.uint8]:
    """Pure-NumPy equivalent of orient_image(Image.fromarray(arr), orientation).

    Avoids the PIL Image.fromarray + transpose + np.asarray round-trip that triples
    peak RAM on 45 MP RAW images (536-670 MB -> 134-268 MB).
    """
    if orientation == 2:
        return np.ascontiguousarray(arr[:, ::-1])
    if orientation == 3:
        return np.ascontiguousarray(arr[::-1, ::-1])
    if orientation == 4:
        return np.ascontiguousarray(arr[::-1, :])
    if orientation == 5:
        return np.ascontiguousarray(arr.transpose(1, 0, 2))
    if orientation == 6:
        return np.ascontiguousarray(arr.transpose(1, 0, 2)[:, ::-1])
    if orientation == 7:
        return np.ascontiguousarray(arr[::-1, ::-1].transpose(1, 0, 2))
    if orientation == 8:
        return np.ascontiguousarray(arr.transpose(1, 0, 2)[::-1, :])
    return np.ascontiguousarray(arr)


def display_dimensions(width: int, height: int, orientation: int) -> tuple[int, int]:
    return (height, width) if orientation in (5, 6, 7, 8) else (width, height)
