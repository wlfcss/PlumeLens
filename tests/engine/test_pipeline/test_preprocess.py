"""Tests for image preprocessing utilities."""

import numpy as np
import pytest
from engine.pipeline.preprocess import (
    YOLO_LETTERBOX_FILL,
    crop_bbox,
    resize_letterbox,
    to_batch,
    to_chw,
)


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
        img = np.random.default_rng(0).random((50, 50, 3), dtype=np.float32)
        result, _, _ = resize_letterbox(img, 100)
        assert result.dtype == np.float32

    def test_padding_uses_yolo_fill(self) -> None:
        """图像周围的填充区域应为 YOLO 标准 114/255 灰色。"""
        # 构造一张 100x200 风景图，letterbox 到 400x400 → 上下各 100px 填充
        img = np.ones((100, 200, 3), dtype=np.float32) * 0.9  # 非灰色的内容区
        result, _, (pad_top, pad_left) = resize_letterbox(img, 400)
        top_pad_sample = result[0:pad_top, :, :]
        assert np.allclose(top_pad_sample, 114.0 / 255.0)
        assert np.allclose(top_pad_sample, YOLO_LETTERBOX_FILL)
        assert pad_left == 0


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


class TestUint8FastPath:
    """Ensure uint8 lazy-float32 pipeline matches legacy float32 preprocessing."""

    def test_resize_letterbox_uint8_matches_float32(self) -> None:
        rng = np.random.default_rng(42)
        img_u8 = rng.integers(0, 256, size=(120, 200, 3), dtype=np.uint8)
        img_f32 = img_u8.astype(np.float32) / 255.0
        res_u8, scale_u8, pad_u8 = resize_letterbox(img_u8, 320)
        res_f32, scale_f32, pad_f32 = resize_letterbox(img_f32, 320)
        assert res_u8.dtype == np.float32
        assert scale_u8 == scale_f32
        assert pad_u8 == pad_f32
        assert np.max(np.abs(res_u8 - res_f32)) < 0.005

    def test_iqa_and_species_preprocess_accept_uint8(self) -> None:
        from engine.pipeline.quality import _preprocess_for_iqa
        from engine.pipeline.species import preprocess_for_dinov3

        rng = np.random.default_rng(7)
        crop_u8 = rng.integers(0, 256, size=(96, 128, 3), dtype=np.uint8)
        crop_f32 = crop_u8.astype(np.float32) / 255.0
        np.testing.assert_allclose(_preprocess_for_iqa(crop_u8), _preprocess_for_iqa(crop_f32))
        np.testing.assert_allclose(
            preprocess_for_dinov3(crop_u8, 64).numpy(),
            preprocess_for_dinov3(crop_f32, 64).numpy(),
        )
