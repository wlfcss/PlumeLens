"""Tests for DINOv3 species v4 helpers + taxonomy.

完整 SpeciesClassifier 需要真实 HF backbone + v4 adapter（>600MB），unit test 只覆盖：
- expand_bbox_to_square：纯几何
- preprocess_for_dinov3：384px tensor 输出
- SpeciesPolicy：v4 reject/recognition 三态阈值
- SpeciesTaxonomy：class_id 输出顺序与 legacy mask 兼容
- LoRALinear：LoRA wrapper shape 与 frozen base
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
import torch
import torch.nn as nn
from engine.pipeline.species import (
    DEFAULT_IMAGE_SIZE,
    DEFAULT_MIN_CONFIDENCE,
    IMAGENET_MEAN,
    IMAGENET_STD,
    LoRALinear,
    SpeciesPolicy,
    SpeciesTaxonomy,
    expand_bbox_to_square,
    preprocess_for_dinov3,
)


class TestExpandBboxToSquare:
    def test_center_bbox_uses_v4_margin_without_legacy_min_side(self) -> None:
        left, top, right, bottom = expand_bbox_to_square(0.5, 0.5, 0.05, 0.05, 1000, 1000)
        assert right - left == bottom - top
        assert right - left == 58

    def test_legacy_min_side_can_still_be_enabled(self) -> None:
        left, top, right, bottom = expand_bbox_to_square(
            0.5,
            0.5,
            0.05,
            0.05,
            1000,
            1000,
            min_side_frac=0.30,
        )
        assert right - left == bottom - top
        assert right - left >= 300

    def test_bbox_near_edge_gets_clamped(self) -> None:
        left, top, right, bottom = expand_bbox_to_square(0.95, 0.95, 0.1, 0.1, 1000, 1000)
        assert right <= 1000
        assert bottom <= 1000
        assert left >= 0
        assert top >= 0

    def test_returns_integer_coords(self) -> None:
        assert all(isinstance(v, int) for v in expand_bbox_to_square(0.5, 0.5, 0.3, 0.3, 800, 600))


class TestPreprocessForDinov3:
    def test_output_shape_and_dtype(self) -> None:
        img = np.random.rand(300, 400, 3).astype(np.float32)
        x = preprocess_for_dinov3(img, DEFAULT_IMAGE_SIZE)
        assert isinstance(x, torch.Tensor)
        assert tuple(x.shape) == (1, 3, DEFAULT_IMAGE_SIZE, DEFAULT_IMAGE_SIZE)
        assert x.dtype == torch.float32

    def test_imagenet_normalization_applied(self) -> None:
        img = np.ones((300, 400, 3), dtype=np.float32)
        x = preprocess_for_dinov3(img, DEFAULT_IMAGE_SIZE)
        r_channel_mean = float(x[0, 0].mean())
        expected = (1.0 - IMAGENET_MEAN[0]) / IMAGENET_STD[0]
        assert r_channel_mean == pytest.approx(expected, abs=0.02)

    def test_default_size_is_384(self) -> None:
        assert DEFAULT_IMAGE_SIZE == 384


class TestSpeciesPolicy:
    def test_balanced_policy_recognizes_confident_known_species(self) -> None:
        policy = SpeciesPolicy.balanced_default()
        assert policy.decide(reject_score=0.1, top1_prob=0.7, margin=0.3) == "recognized"

    def test_balanced_policy_sends_low_margin_to_review(self) -> None:
        policy = SpeciesPolicy.balanced_default()
        assert policy.decide(reject_score=0.1, top1_prob=0.7, margin=0.01) == "uncertain"

    def test_balanced_policy_hard_rejects_unknown(self) -> None:
        policy = SpeciesPolicy.balanced_default()
        assert policy.decide(reject_score=0.99, top1_prob=0.9, margin=0.8) == "unrecognized"

    def test_non_finite_scores_are_unrecognized(self) -> None:
        policy = SpeciesPolicy.balanced_default()
        assert policy.decide(reject_score=float("nan"), top1_prob=0.9, margin=0.8) == "unrecognized"


class TestLoRALinear:
    def test_forward_preserves_base_shape_and_freezes_base(self) -> None:
        base = nn.Linear(16, 8)
        layer = LoRALinear(base, r=4, alpha=8.0, dropout=0.0)
        x = torch.randn(2, 16)
        y = layer(x)
        assert tuple(y.shape) == (2, 8)
        assert all(not p.requires_grad for p in layer.base.parameters())
        assert layer.lora_A.weight.requires_grad
        assert layer.lora_B.weight.requires_grad


class TestSpeciesTaxonomy:
    def _write_v4_taxonomy(self, deploy_dir: Path, num_classes: int = 5) -> None:
        canonical = pa.table(
            {
                "class_id": pa.array([3, 1, 4, 0, 2][:num_classes], type=pa.int32()),
                "canonical_sci": [f"Species_{i:03d}" for i in [3, 1, 4, 0, 2][:num_classes]],
                "canonical_zh": [f"物种{i}" for i in [3, 1, 4, 0, 2][:num_classes]],
                "canonical_en": [f"sp_{i}" for i in [3, 1, 4, 0, 2][:num_classes]],
                "order_sci": ["ORDER_X"] * num_classes,
                "family_sci": ["FAMILY_X"] * num_classes,
                "family_zh": ["科X"] * num_classes,
                "iucn": ["LC"] * num_classes,
                "protect_level": [None] * num_classes,
                "scope": ["v12"] * num_classes,
                "note": [None] * num_classes,
            }
        )
        pq.write_table(canonical, str(deploy_dir / "canonical_extended.parquet"))

    def _write_legacy_taxonomy(self, deploy_dir: Path, num_classes: int = 5) -> None:
        canonical = pa.table(
            {
                "canonical_sci": [f"Species_{i:03d}" for i in range(num_classes)],
                "canonical_zh": [f"物种{i}" for i in range(num_classes)],
                "canonical_en": [f"sp_{i}" for i in range(num_classes)],
            }
        )
        pq.write_table(canonical, str(deploy_dir / "canonical_extended.parquet"))
        trained = pa.table(
            {
                "model_output_id": [0, 2, 4],
                "canonical_sci": ["Species_000", "Species_002", "Species_004"],
            }
        )
        pq.write_table(trained, str(deploy_dir / "species_list_1301.parquet"))

    def test_v4_uses_class_id_order_and_all_classes_are_trained(self, tmp_path: Path) -> None:
        self._write_v4_taxonomy(tmp_path)
        tax = SpeciesTaxonomy(tmp_path)
        assert len(tax) == 5
        assert tax.sci_at(0) == "Species_000"
        assert tax.sci_at(4) == "Species_004"
        assert tax.trained_mask.tolist() == [True, True, True, True, True]

    def test_legacy_taxonomy_still_supports_trained_mask(self, tmp_path: Path) -> None:
        self._write_legacy_taxonomy(tmp_path)
        tax = SpeciesTaxonomy(tmp_path)
        assert tax.trained_mask.tolist() == [True, False, True, False, True]

    def test_lookup_returns_metadata(self, tmp_path: Path) -> None:
        self._write_v4_taxonomy(tmp_path)
        tax = SpeciesTaxonomy(tmp_path)
        meta = tax.lookup("Species_001")
        assert meta is not None
        assert meta["canonical_zh"] == "物种1"
        assert meta["iucn"] == "LC"

    def test_lookup_missing_returns_none(self, tmp_path: Path) -> None:
        self._write_v4_taxonomy(tmp_path)
        tax = SpeciesTaxonomy(tmp_path)
        assert tax.lookup("MissingSpecies") is None


def test_imagenet_constants_unchanged() -> None:
    assert IMAGENET_MEAN == (0.485, 0.456, 0.406)
    assert IMAGENET_STD == (0.229, 0.224, 0.225)


def test_default_min_confidence_remains_review_friendly() -> None:
    assert DEFAULT_MIN_CONFIDENCE == 0.01
