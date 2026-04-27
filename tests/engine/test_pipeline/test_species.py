"""Tests for v3 species classifier helpers + taxonomy.

注意：v3 切到 torch + transformers 后，完整的 SpeciesClassifier 加载需要真实
backbone safetensors + 8 head .pt（>800MB），不在 unit test 跑。这里只测：
- expand_bbox_to_square：纯几何，无依赖
- preprocess_for_dinov3：torch tensor 输出
- SpeciesTaxonomy：基于动态写入的 parquet 文件
- HeadOnlyClassifier.from_ckpt：基于 in-memory 构造的 state_dict
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
import torch
from engine.pipeline.species import (
    DEFAULT_IMAGE_SIZE,
    DEFAULT_MIN_CONFIDENCE,
    IMAGENET_MEAN,
    IMAGENET_STD,
    HeadOnlyClassifier,
    SpeciesTaxonomy,
    expand_bbox_to_square,
    preprocess_for_dinov3,
)


# ============================================================
# expand_bbox_to_square
# ============================================================
class TestExpandBboxToSquare:
    def test_center_bbox_small_enforces_min_side(self) -> None:
        left, top, right, bottom = expand_bbox_to_square(
            0.5, 0.5, 0.05, 0.05, 1000, 1000,
        )
        side_w = right - left
        side_h = bottom - top
        assert side_w == side_h
        assert side_w >= 300

    def test_bbox_near_edge_gets_clamped(self) -> None:
        left, top, right, bottom = expand_bbox_to_square(
            0.95, 0.95, 0.1, 0.1, 1000, 1000,
        )
        assert right <= 1000
        assert bottom <= 1000
        assert left >= 0
        assert top >= 0

    def test_returns_integer_coords(self) -> None:
        coords = expand_bbox_to_square(0.5, 0.5, 0.3, 0.3, 800, 600)
        for v in coords:
            assert isinstance(v, int)


# ============================================================
# preprocess_for_dinov3 — 输出 torch tensor
# ============================================================
class TestPreprocessForDinov3:
    def test_output_shape_and_dtype(self) -> None:
        img = np.random.rand(300, 400, 3).astype(np.float32)
        x = preprocess_for_dinov3(img, DEFAULT_IMAGE_SIZE)
        assert isinstance(x, torch.Tensor)
        assert tuple(x.shape) == (1, 3, DEFAULT_IMAGE_SIZE, DEFAULT_IMAGE_SIZE)
        assert x.dtype == torch.float32

    def test_imagenet_normalization_applied(self) -> None:
        img = np.ones((300, 400, 3), dtype=np.float32)
        x = preprocess_for_dinov3(img, 480)
        r_channel_mean = float(x[0, 0].mean())
        expected = (1.0 - IMAGENET_MEAN[0]) / IMAGENET_STD[0]
        assert r_channel_mean == pytest.approx(expected, abs=0.02)

    def test_default_size_is_480(self) -> None:
        assert DEFAULT_IMAGE_SIZE == 480


# ============================================================
# HeadOnlyClassifier — from_ckpt 推断结构 + load
# ============================================================
class TestHeadOnlyClassifier:
    def _make_synthetic_ckpt(self, tmp_path: Path) -> Path:
        """造一个 head ckpt，模拟 v3 LayerNorm + MLP-2048 + species/order/family/genus。"""
        feature_dim = 2048
        num_species = 1535
        num_orders = 31
        num_families = 124
        num_genera = 521
        mlp_hidden = 2048
        h = HeadOnlyClassifier(
            feature_dim=feature_dim,
            num_species=num_species,
            head_type="mlp",
            mlp_hidden=mlp_hidden,
            num_orders=num_orders,
            num_families=num_families,
            num_genera=num_genera,
        )
        ckpt = {"model_state": h.state_dict(), "epoch": 1, "args": {}, "metrics": {}}
        ck_path = tmp_path / "fake_head.pt"
        torch.save(ckpt, str(ck_path))
        return ck_path

    def test_from_ckpt_loads_correct_shape(self, tmp_path: Path) -> None:
        ck = self._make_synthetic_ckpt(tmp_path)
        head = HeadOnlyClassifier.from_ckpt(ck)
        assert head.species_head.weight.shape == (1535, 2048)
        assert head.head_type == "mlp"
        assert head.order_head is not None

    def test_forward_returns_species_logits(self, tmp_path: Path) -> None:
        ck = self._make_synthetic_ckpt(tmp_path)
        head = HeadOnlyClassifier.from_ckpt(ck)
        feat = torch.randn(2, 2048)
        out = head(feat)
        assert tuple(out.shape) == (2, 1535)


# ============================================================
# SpeciesTaxonomy — 真实读 parquet（in tmp_path）
# ============================================================
class TestSpeciesTaxonomy:
    def _write_taxonomy(self, deploy_dir: Path, num_classes: int = 5) -> None:
        """写两个 parquet：canonical_extended + species_list_1301（trained mask）。"""
        canonical = pa.table({
            "canonical_sci": [f"Species_{i:03d}" for i in range(num_classes)],
            "canonical_zh": [f"物种{i}" for i in range(num_classes)],
            "canonical_en": [f"sp_{i}" for i in range(num_classes)],
            "order_sci": ["ORDER_X"] * num_classes,
            "family_sci": ["FAMILY_X"] * num_classes,
            "family_zh": ["科X"] * num_classes,
            "iucn": ["LC"] * num_classes,
            "protect_level": [None] * num_classes,
            "note": [None] * num_classes,
        })
        pq.write_table(canonical, str(deploy_dir / "canonical_extended.parquet"))

        # 只有 even-index 的类有训练（model_output_id = 0, 2, 4, ...）
        # 注意：model_output_id 必须基于"按字典序排序后的 index"
        # Species_000 < Species_001 < ... ASCII 排序后，index 即名称中的数字
        trained_indices = [i for i in range(num_classes) if i % 2 == 0]
        trained = pa.table({
            "model_output_id": trained_indices,
            "canonical_sci": [f"Species_{i:03d}" for i in trained_indices],
        })
        pq.write_table(trained, str(deploy_dir / "species_list_1301.parquet"))

    def test_loads_canonical_and_trained_mask(self, tmp_path: Path) -> None:
        self._write_taxonomy(tmp_path, num_classes=5)
        tax = SpeciesTaxonomy(tmp_path)
        assert len(tax) == 5
        # 字典序：Species_000 → idx 0
        assert tax.sci_at(0) == "Species_000"
        assert tax.sci_at(4) == "Species_004"
        # trained mask: 偶数 index 为 True
        assert tax.trained_mask.tolist() == [True, False, True, False, True]

    def test_lookup_returns_metadata(self, tmp_path: Path) -> None:
        self._write_taxonomy(tmp_path, num_classes=3)
        tax = SpeciesTaxonomy(tmp_path)
        meta = tax.lookup("Species_001")
        assert meta is not None
        assert meta["canonical_zh"] == "物种1"
        assert meta["iucn"] == "LC"

    def test_lookup_missing_returns_none(self, tmp_path: Path) -> None:
        self._write_taxonomy(tmp_path, num_classes=3)
        tax = SpeciesTaxonomy(tmp_path)
        assert tax.lookup("MissingSpecies") is None


# ============================================================
# 健全性：constants 没飘
# ============================================================
def test_imagenet_constants_unchanged() -> None:
    assert IMAGENET_MEAN == (0.485, 0.456, 0.406)
    assert IMAGENET_STD == (0.229, 0.224, 0.225)


def test_default_min_confidence_low_enough_to_pass_train_predictions() -> None:
    # 0.01 既能挡 ghost class 偶然命中，又不会过滤训练良好的预测
    assert DEFAULT_MIN_CONFIDENCE == 0.01
