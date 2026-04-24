"""Tests for SpeciesClassifier and helpers (mocked ONNX sessions + in-memory taxonomy)."""

from unittest.mock import MagicMock

import numpy as np
import pytest
from engine.pipeline.species import (
    DEFAULT_MIN_CONFIDENCE,
    IMAGENET_MEAN,
    IMAGENET_STD,
    SCALES,
    SpeciesClassifier,
    SpeciesTaxonomy,
    expand_bbox_to_square,
    preprocess_for_dinov3,
)


class _FakeTaxonomy(SpeciesTaxonomy):
    """Bypass parquet read; inject rows directly for tests."""

    def __init__(self, rows: list[dict]) -> None:  # type: ignore[no-untyped-def]
        rows_sorted = sorted(rows, key=lambda r: r["canonical_sci"])
        self._rows = rows_sorted
        self._sci_to_row = {r["canonical_sci"]: r for r in rows_sorted}


def _make_backbone_session(feature: np.ndarray) -> MagicMock:
    sess = MagicMock()
    inp = MagicMock()
    inp.name = "pixel_values"
    out = MagicMock()
    out.name = "features"
    sess.get_inputs.return_value = [inp]
    sess.get_outputs.return_value = [out]
    sess.run.return_value = [feature]  # feature already shape (1, 2048)
    return sess


def _make_ensemble_session(
    probs: np.ndarray,
    input_names: tuple[str, ...] = ("feat_512", "feat_640"),
) -> MagicMock:
    sess = MagicMock()
    ins = []
    for n in input_names:
        i = MagicMock()
        i.name = n
        ins.append(i)
    out = MagicMock()
    out.name = "species_probs"
    sess.get_inputs.return_value = ins
    sess.get_outputs.return_value = [out]
    sess.run.return_value = [probs[np.newaxis, ...]]  # wrap to (1, N)
    return sess


class TestExpandBboxToSquare:
    def test_center_bbox_small_enforces_min_side(self) -> None:
        # 很小的 bbox，应该被 min_side_frac=0.30 拉大
        left, top, right, bottom = expand_bbox_to_square(
            0.5, 0.5, 0.05, 0.05, 1000, 1000,
        )
        side_w = right - left
        side_h = bottom - top
        assert side_w == side_h  # 方形
        assert side_w >= 300  # min 30% of 1000

    def test_bbox_near_edge_gets_clamped(self) -> None:
        # bbox 靠近右下边缘，crop 应该不会越界
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


class TestPreprocessForDinov3:
    def test_output_shape_and_dtype(self) -> None:
        img = np.random.rand(300, 400, 3).astype(np.float32)
        x = preprocess_for_dinov3(img, 512)
        assert x.shape == (1, 3, 512, 512)
        assert x.dtype == np.float32

    def test_imagenet_normalization_applied(self) -> None:
        # 全 1 的输入归一化后应该约等于 (1 - mean) / std
        img = np.ones((300, 400, 3), dtype=np.float32)
        x = preprocess_for_dinov3(img, 512)
        # 检查 R 通道均值（每通道 normalize 不同）
        r_channel_mean = x[0, 0].mean()
        expected = (1.0 - IMAGENET_MEAN[0]) / IMAGENET_STD[0]
        assert r_channel_mean == pytest.approx(expected, abs=0.02)

    def test_scales_constant_stable(self) -> None:
        assert SCALES == (512, 640)


class TestSpeciesTaxonomyFake:
    def test_sci_at_is_sorted(self) -> None:
        rows = [
            {"canonical_sci": "Zosterops simplex", "canonical_zh": "暗绿绣眼鸟"},
            {"canonical_sci": "Alcedo atthis", "canonical_zh": "翠鸟"},
            {"canonical_sci": "Passer cinnamomeus", "canonical_zh": "山麻雀"},
        ]
        tax = _FakeTaxonomy(rows)
        # 字典序：Alcedo < Passer < Zosterops
        assert tax.sci_at(0) == "Alcedo atthis"
        assert tax.sci_at(1) == "Passer cinnamomeus"
        assert tax.sci_at(2) == "Zosterops simplex"

    def test_lookup(self) -> None:
        tax = _FakeTaxonomy([{"canonical_sci": "X", "iucn": "LC"}])
        assert tax.lookup("X") == {"canonical_sci": "X", "iucn": "LC"}
        assert tax.lookup("missing") is None


class TestSpeciesClassifier:
    def _build(self, probs: np.ndarray, num_species: int, top_k: int = 5) -> SpeciesClassifier:
        rows = [
            {
                "canonical_sci": f"Species_{i:04d}",
                "canonical_zh": f"物种{i}",
                "canonical_en": None,
                "family_sci": None,
                "family_zh": None,
                "order_sci": None,
                "iucn": "LC",
                "protect_level": None,
            }
            for i in range(num_species)
        ]
        tax = _FakeTaxonomy(rows)
        feat = np.random.randn(1, 2048).astype(np.float32)
        return SpeciesClassifier(
            backbone_session=_make_backbone_session(feat),
            ensemble_session=_make_ensemble_session(probs),
            taxonomy=tax,
            top_k=top_k,
            min_confidence=DEFAULT_MIN_CONFIDENCE,
        )

    def test_returns_top_k_candidates_sorted(self) -> None:
        # 制作 1516 维概率，让 index 500 最高
        probs = np.full(1516, 0.0001, dtype=np.float32)
        probs[500] = 0.5
        probs[300] = 0.2
        probs[100] = 0.1
        classifier = self._build(probs, num_species=1516, top_k=5)

        img = np.random.rand(300, 300, 3).astype(np.float32)
        results = classifier.classify(img)

        # 低于 min_confidence=0.01 的会被过滤；剩 3 个
        assert len(results) == 3
        # 排序：confidence 降序
        assert results[0].confidence > results[1].confidence > results[2].confidence
        assert results[0].confidence == pytest.approx(0.5)

    def test_all_candidates_filtered_when_below_threshold(self) -> None:
        # 所有都低于 min_confidence
        probs = np.full(1516, 0.0001, dtype=np.float32)
        classifier = self._build(probs, num_species=1516)

        img = np.random.rand(200, 200, 3).astype(np.float32)
        results = classifier.classify(img)
        assert results == []

    def test_metadata_passthrough(self) -> None:
        probs = np.zeros(10, dtype=np.float32)
        probs[3] = 0.9
        classifier = self._build(probs, num_species=10)

        img = np.random.rand(100, 100, 3).astype(np.float32)
        results = classifier.classify(img)
        assert len(results) == 1
        # Species_0003 对应 index 3（字典序）
        assert results[0].canonical_sci == "Species_0003"
        assert results[0].canonical_zh == "物种3"
        assert results[0].iucn == "LC"

    def test_respects_ensemble_input_name_order(self) -> None:
        # 如果 ONNX 导出时把 feat_640 排在前面，classify 应该仍能正确调用
        probs = np.zeros(10, dtype=np.float32)
        probs[0] = 1.0
        ens_sess = _make_ensemble_session(probs, input_names=("feat_640", "feat_512"))
        classifier = SpeciesClassifier(
            backbone_session=_make_backbone_session(
                np.random.randn(1, 2048).astype(np.float32)
            ),
            ensemble_session=ens_sess,
            taxonomy=_FakeTaxonomy([
                {"canonical_sci": f"S_{i}"} for i in range(10)
            ]),
        )
        img = np.random.rand(200, 200, 3).astype(np.float32)
        results = classifier.classify(img)
        # 主要验证 feed dict 构造不报错
        assert len(results) == 1
