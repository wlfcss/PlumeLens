"""Regression tests for Wave 0 pipeline safety guards (NaN/Inf, extreme aspect, manifest)."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from engine.core.manifest import ManifestError, reset_cache_for_tests
from engine.pipeline.detector import BirdDetector
from engine.pipeline.pose import PoseDetector
from engine.pipeline.preprocess import resize_letterbox
from engine.pipeline.quality import _preprocess_for_iqa


class _FakeSession:
    def __init__(self, output: np.ndarray) -> None:
        self._output = output

    def get_inputs(self) -> list[SimpleNamespace]:
        return [SimpleNamespace(name="images")]

    def get_outputs(self) -> list[SimpleNamespace]:
        return [SimpleNamespace(name="output0")]

    def run(self, _outputs: list[str], _inputs: dict[str, np.ndarray]) -> list[np.ndarray]:
        return [self._output]


def test_detector_skips_nan_and_inf_rows() -> None:
    raw = np.zeros((1, 4, 6), dtype=np.float32)
    raw[0, 0] = [np.nan, 10, 100, 100, 0.99, 0]
    raw[0, 1] = [10, 10, np.inf, 100, 0.95, 0]
    raw[0, 2] = [10, 10, 100, 100, np.nan, 0]
    raw[0, 3] = [100, 100, 300, 300, 0.90, 0]

    detector = BirdDetector(_FakeSession(raw), input_size=640)
    image = np.zeros((640, 640, 3), dtype=np.uint8)
    boxes = detector.detect(image, confidence_threshold=0.5)
    assert len(boxes) == 1
    assert boxes[0].confidence == pytest.approx(0.90, abs=1e-4)


def test_pose_ignores_nan_conf_rows_and_zeros_nan_keypoints() -> None:
    raw = np.zeros((1, 2, 39), dtype=np.float32)
    # Row 0 has NaN confidence (raw argmax would mistakenly select index 0)
    raw[0, 0, 4] = np.nan
    # Row 1 has valid bbox, but one NaN keypoint
    raw[0, 1, :6] = [10, 10, 200, 200, 0.85, 0]
    raw[0, 1, 6:9] = [np.nan, 50.0, 0.9]  # bill keypoint is NaN
    raw[0, 1, 9:12] = [80.0, 60.0, 0.95]  # crown keypoint is valid

    detector = PoseDetector(_FakeSession(raw), input_size=640)
    crop = np.zeros((320, 320, 3), dtype=np.uint8)
    pose = detector.detect(crop, crop_origin=(0, 0))
    assert pose is not None
    assert pose.bill.confidence == 0.0
    assert pose.crown.confidence == pytest.approx(0.95, abs=1e-4)


def test_resize_letterbox_guards_zero_and_extreme_aspect() -> None:
    with pytest.raises(ValueError, match="Invalid image dimensions"):
        resize_letterbox(np.zeros((0, 100, 3), dtype=np.uint8), target_size=640)

    thin = np.full((1, 4000, 3), 128, dtype=np.uint8)
    canvas, _scale, _pads = resize_letterbox(thin, target_size=640)
    assert canvas.shape == (640, 640, 3)


def test_iqa_preprocess_clips_float32_without_wraparound() -> None:
    crop = np.full((32, 32, 3), 1.5, dtype=np.float32)
    crop[0, 0] = [-0.5, 0.0, 1.5]
    tensor = _preprocess_for_iqa(crop)
    assert tensor.shape == (1, 3, 224, 224)
    assert float(tensor.min()) >= 0.0
    assert float(tensor.max()) <= 1.0


def test_species_classifier_requires_manifest_assets_before_torch_load(tmp_path: Path) -> None:
    from engine.pipeline.species import SpeciesClassifier

    reset_cache_for_tests()
    deploy_dir = tmp_path / "species"
    (deploy_dir / "backbone").mkdir(parents=True)
    (deploy_dir / "v4").mkdir(parents=True)
    (deploy_dir / "backbone" / "model.safetensors").write_bytes(b"fake-backbone")
    (deploy_dir / "v4" / "seed42_adapter.pt").write_bytes(b"fake-adapter")

    # Minimal taxonomy parquet so __init__ reaches verify_manifest before torch.load
    import pyarrow as pa
    import pyarrow.parquet as pq

    table = pa.table(
        {
            "class_id": [0],
            "canonical_sci": ["Passer montanus"],
            "canonical_zh": ["麻雀"],
            "canonical_en": ["Eurasian Tree Sparrow"],
        }
    )
    pq.write_table(table, deploy_dir / "canonical_extended.parquet")

    with pytest.raises(ManifestError, match="Trusted manifest missing"):
        SpeciesClassifier(deploy_dir=deploy_dir, device="cpu")
