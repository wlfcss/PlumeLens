"""场景分组算法基本测试（用合成图像）。"""

from __future__ import annotations

import numpy as np
from numpy.typing import NDArray


def _solid_color(w: int, h: int, color: tuple[int, int, int]) -> NDArray[np.uint8]:
    """生成纯色图（BGR）。"""
    img = np.zeros((h, w, 3), dtype=np.uint8)
    img[:, :] = color
    return img


def _noisy_pattern(seed: int, w: int = 800, h: int = 600) -> NDArray[np.uint8]:
    """生成带 AKAZE 可识别特征的伪随机纹理。"""
    rng = np.random.default_rng(seed)
    img = rng.integers(0, 255, (h, w, 3), dtype=np.uint8)
    # 加几个高对比度块（AKAZE 容易抓特征）
    for _ in range(20):
        x = int(rng.integers(0, w - 60))
        y = int(rng.integers(0, h - 60))
        img[y : y + 50, x : x + 50] = (
            int(rng.integers(0, 255)),
            int(rng.integers(0, 255)),
            int(rng.integers(0, 255)),
        )
    return img


class TestSimilarity:
    def test_identical_image_pair_is_similar(self) -> None:
        from engine.pipeline.scene_grouping import compute_similarity

        img = _noisy_pattern(seed=42)
        result = compute_similarity(img, img.copy())
        assert result.similar, f"identical images should be similar, got {result}"

    def test_completely_different_colors_not_similar(self) -> None:
        from engine.pipeline.scene_grouping import compute_similarity

        red = _solid_color(800, 600, (0, 0, 255))
        blue = _solid_color(800, 600, (255, 0, 0))
        result = compute_similarity(red, blue)
        # 纯色没有 AKAZE 特征 → 走颜色直方图，红 vs 蓝差距大
        assert not result.similar, f"red vs blue should not be similar, got {result}"

    def test_slight_perturbation_still_similar(self) -> None:
        """同一张图加轻微噪声仍应判为相似（连拍 frame 微抖动）。"""
        from engine.pipeline.scene_grouping import compute_similarity

        img = _noisy_pattern(seed=7)
        rng = np.random.default_rng(0)
        noise = rng.integers(-5, 6, img.shape, dtype=np.int16)
        perturbed = np.clip(img.astype(np.int16) + noise, 0, 255).astype(np.uint8)
        result = compute_similarity(img, perturbed)
        assert result.similar, f"slight noise should still be similar, got {result}"
