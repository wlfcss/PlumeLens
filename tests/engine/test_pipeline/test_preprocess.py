"""Tests for image preprocessing utilities."""

import numpy as np
import pytest

from engine.pipeline.preprocess import crop_bbox, resize_letterbox, to_batch, to_chw


class TestResizeLetterbox:
    """Test letterbox resizing for YOLO input."""

    def test_square_image(self) -> None:
        img = np.random.rand(100, 100, 3).astype(np.float32)
        result, scale, (pad_top, pad_left) = resize_letterbox(img, 200)
        assert result.shape == (200, 200, 3)
        assert scale == pytest.approx(2.0)
        assert pad_top == 0
        assert pad_left == 0

    def test_landscape_image(self) -> None:
        img = np.random.rand(100, 200, 3).astype(np.float32)
        result, scale, (pad_top, pad_left) = resize_letterbox(img, 400)
        assert result.shape == (400, 400, 3)
        assert scale == pytest.approx(2.0)
        # Width fills 400, height = 200, pad_top = (400-200)/2 = 100
        assert pad_top == 100
        assert pad_left == 0

    def test_portrait_image(self) -> None:
        img = np.random.rand(200, 100, 3).astype(np.float32)
        result, scale, (pad_top, pad_left) = resize_letterbox(img, 400)
        assert result.shape == (400, 400, 3)
        assert pad_top == 0
        assert pad_left == 100

    def test_output_dtype(self) -> None:
        img = np.random.rand(50, 50, 3).astype(np.float32)
        result, _, _ = resize_letterbox(img, 100)
        assert result.dtype == np.float32


class TestCropBbox:
    """Test bounding box cropping."""

    def test_basic_crop(self) -> None:
        img = np.random.rand(100, 100, 3).astype(np.float32)
        crop = crop_bbox(img, 10, 20, 50, 60)
        assert crop.shape == (40, 40, 3)

    def test_crop_clamps_to_bounds(self) -> None:
        img = np.random.rand(100, 100, 3).astype(np.float32)
        crop = crop_bbox(img, -10, -10, 50, 50)
        assert crop.shape == (50, 50, 3)

    def test_expand_ratio(self) -> None:
        img = np.random.rand(200, 200, 3).astype(np.float32)
        crop_normal = crop_bbox(img, 50, 50, 100, 100)
        crop_expanded = crop_bbox(img, 50, 50, 100, 100, expand_ratio=2.0)
        # Expanded crop should be larger
        assert crop_expanded.shape[0] > crop_normal.shape[0]
        assert crop_expanded.shape[1] > crop_normal.shape[1]

    def test_degenerate_box(self) -> None:
        img = np.random.rand(100, 100, 3).astype(np.float32)
        crop = crop_bbox(img, 50, 50, 50, 50)  # zero-area box
        assert crop.shape[0] >= 1
        assert crop.shape[1] >= 1

    def test_returns_copy(self) -> None:
        img = np.random.rand(100, 100, 3).astype(np.float32)
        crop = crop_bbox(img, 10, 10, 50, 50)
        crop[0, 0, 0] = 999.0
        assert img[10, 10, 0] != 999.0


class TestTransforms:
    """Test CHW and batch transforms."""

    def test_to_chw(self) -> None:
        img = np.random.rand(100, 200, 3).astype(np.float32)
        result = to_chw(img)
        assert result.shape == (3, 100, 200)

    def test_to_batch(self) -> None:
        img = np.random.rand(3, 100, 200).astype(np.float32)
        result = to_batch(img)
        assert result.shape == (1, 3, 100, 200)

    def test_chw_contiguous(self) -> None:
        img = np.random.rand(100, 200, 3).astype(np.float32)
        result = to_chw(img)
        assert result.flags["C_CONTIGUOUS"]
