"""Pipeline identity, runtime fallback, RAW geometry and classifier calibration regressions."""

from __future__ import annotations

import hashlib
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import numpy as np
import pytest
import rawpy
import torch
from engine.core.config import Settings
from engine.pipeline import manager, preprocess, species
from engine.pipeline.manager import PipelineManager, _file_checksum
from engine.pipeline.species import SpeciesClassifier, SpeciesPolicy
from engine.services.scanner import _probe_image_meta
from engine.services.thumbnail import _load_source_image
from PIL import Image, ImageOps


def test_checksum_includes_weight_tail(tmp_path: Path):
    first, second = tmp_path / "first", tmp_path / "second"
    first.write_bytes(b"x" * 65536 + b"A")
    second.write_bytes(b"x" * 65536 + b"B")
    assert _file_checksum(first) == hashlib.sha256(first.read_bytes()).hexdigest()
    assert _file_checksum(first) != _file_checksum(second)


def test_version_keeps_provider_model_assignment_runtime_and_config(monkeypatch, tmp_path: Path):
    pipeline = PipelineManager(Settings(data_dir=tmp_path, api_token="must-not-be-serialized"))
    monkeypatch.setattr(manager, "package_version", lambda name: "runtime-v1")
    pipeline._model_providers = {"yolo": "CoreML", "pose": "CPU"}
    first = pipeline._compute_version({"weights": "one", "backbone_config": "config-a"})
    assert pipeline._compute_version({"backbone_config": "config-a", "weights": "one"}) == first
    assert "api_token" not in pipeline.version_descriptor["parameters"]
    pipeline._model_providers = {"pose": "CoreML", "yolo": "CPU"}
    assert pipeline._compute_version({"weights": "one", "backbone_config": "config-a"}) != first
    pipeline._model_providers = {"yolo": "CoreML", "pose": "CPU"}
    assert pipeline._compute_version({"weights": "one", "backbone_config": "config-b"}) != first
    monkeypatch.setattr(manager, "package_version", lambda name: "runtime-v2")
    assert pipeline._compute_version({"weights": "one", "backbone_config": "config-a"}) != first


async def test_auto_coreml_uses_verified_digest_loads_fallback_and_releases_it(
    monkeypatch, tmp_path
):
    model = tmp_path / "yolo26l-bird-det.onnx"
    model.write_bytes(b"dummy weights")
    digest = hashlib.sha256(model.read_bytes()).hexdigest()
    monkeypatch.setattr(manager, "verify_manifest", lambda path: {model.name: digest})
    monkeypatch.setattr(
        manager, "_file_checksum", lambda path: pytest.fail("rehashed verified asset")
    )
    monkeypatch.setattr(
        manager,
        "resolve_providers",
        lambda *args, **kwargs: [
            "CoreMLExecutionProvider",
            "CPUExecutionProvider",
        ],
    )
    sessions = []

    def create_session(path, providers, **_options):
        session = MagicMock()
        session.get_providers.return_value = providers
        session.get_provider_options.return_value = {
            providers[0]: {"MLComputeUnits": "CPUAndGPU"} if "CoreML" in providers[0] else {},
        }
        sessions.append(session)
        return session

    import onnxruntime

    monkeypatch.setattr(onnxruntime, "InferenceSession", create_session)
    pipeline = PipelineManager(Settings(models_dir=tmp_path, yolo_provider="auto"))
    await pipeline.initialize()
    assert len(sessions) == 2
    assert sessions[1].get_providers() == ["CPUExecutionProvider"]
    assert pipeline.version_descriptor["assets"]["yolo"] == digest
    assert pipeline.version_descriptor["provider_details"]["yolo"]["options"] == {
        "CoreMLExecutionProvider": {"MLComputeUnits": "CPUAndGPU"},
    }
    pipeline._detector.detect = MagicMock(side_effect=RuntimeError("CoreML failure"))
    pipeline._detector_cpu_fallback.detect = MagicMock(return_value=[])
    image = tmp_path / "photo.jpg"
    Image.new("RGB", (32, 24)).save(image)
    assert (await pipeline.analyze(image)).bird_count == 0
    pipeline._detector_cpu_fallback.detect.assert_called_once()
    pipeline.close()
    assert pipeline._detector_cpu_fallback is None
    assert not pipeline.is_ready and not any(pipeline.model_status.values())
    assert pipeline.model_providers == {}


@pytest.mark.parametrize("value", range(1, 9))
def test_raw_orientation_matches_metadata_thumbnail_and_pillow(monkeypatch, tmp_path, value):
    sensor = np.arange(18, dtype=np.uint8).reshape(2, 3, 3) * 10
    reference = Image.fromarray(sensor)
    reference.getexif()[0x0112] = value
    expected = np.asarray(ImageOps.exif_transpose(reference))
    probe = MagicMock()
    probe.__enter__.return_value = probe
    probe.getexif.return_value = {0x0112: value}
    monkeypatch.setattr(Image, "open", lambda path: probe)
    raw = MagicMock()
    raw.__enter__.return_value = raw
    raw.sizes = SimpleNamespace(width=3, height=2, flip=6)
    raw.postprocess.return_value = sensor
    raw.extract_thumb.side_effect = OSError("no embedded preview")
    monkeypatch.setattr(rawpy, "imread", lambda path: raw)
    path = tmp_path / "photo.dng"
    actual = preprocess._load_raw(path)
    np.testing.assert_array_equal(np.rint(actual * 255).astype(np.uint8), expected)
    np.testing.assert_array_equal(np.asarray(_load_source_image(path)), expected)
    meta = _probe_image_meta(path)
    assert (meta["width"], meta["height"]) == (expected.shape[1], expected.shape[0])
    assert all(call.kwargs["user_flip"] == 0 for call in raw.postprocess.call_args_list)


@pytest.mark.parametrize("raw_flip,exif", [(0, 1), (3, 3), (5, 8), (6, 6)])
def test_raw_without_pillow_exif_retains_internal_direction(monkeypatch, tmp_path, raw_flip, exif):
    sensor = np.arange(18, dtype=np.uint8).reshape(2, 3, 3) * 10
    monkeypatch.setattr(Image, "open", MagicMock(side_effect=OSError("RAW EXIF unavailable")))
    raw = MagicMock()
    raw.__enter__.return_value = raw
    raw.sizes = SimpleNamespace(width=3, height=2, flip=raw_flip)
    raw.postprocess.return_value = sensor
    raw.extract_thumb.side_effect = OSError("no embedded preview")
    monkeypatch.setattr(rawpy, "imread", lambda path: raw)
    path = tmp_path / "photo.dng"
    reference = Image.fromarray(sensor)
    reference.getexif()[0x0112] = exif
    expected = np.asarray(ImageOps.exif_transpose(reference))
    actual = preprocess._load_raw(path)
    np.testing.assert_array_equal(np.rint(actual * 255).astype(np.uint8), expected)
    np.testing.assert_array_equal(np.asarray(_load_source_image(path)), expected)
    meta = _probe_image_meta(path)
    assert (meta["width"], meta["height"]) == (expected.shape[1], expected.shape[0])


def test_requesting_one_candidate_does_not_inflate_recognition_margin(monkeypatch):
    monkeypatch.setattr(species, "preprocess_for_dinov3", lambda *args: torch.zeros((1, 3, 4, 4)))
    classifier = object.__new__(SpeciesClassifier)
    classifier.device = "cpu"
    classifier._dtype = torch.float32
    classifier._infer_lock = threading.Lock()
    classifier.image_size = 4
    classifier._trained_mask = np.ones(3, dtype=bool)
    classifier._min_confidence = 0.01
    classifier._policy = SpeciesPolicy.balanced_default()
    classifier._taxonomy = MagicMock()
    classifier._taxonomy.sci_at.side_effect = lambda idx: f"Species_{idx}"
    classifier._taxonomy.lookup.return_value = {}
    classifier._model = MagicMock()
    classifier._model.forward_features.return_value = torch.zeros((1, 4))
    classifier._model.species_head.return_value = torch.tensor([[2.0, 1.95, -5.0]])
    classifier._model.reject_head.return_value = torch.tensor([[-3.0]])
    classifier._top_k = 1
    one = classifier.classify(np.zeros((4, 4, 3), dtype=np.float32))
    classifier._top_k = 3
    three = classifier.classify(np.zeros((4, 4, 3), dtype=np.float32))
    assert len(one) == 1 and len(three) == 2
    assert one[0].recognition_state == three[0].recognition_state == "uncertain"
    assert one[0].top1_top2_margin == pytest.approx(three[0].top1_top2_margin)


async def test_backbone_config_is_in_loaded_pipeline_identity(monkeypatch, tmp_path):
    species_dir = tmp_path / "species"
    files = [
        "backbone/model.safetensors",
        "backbone/config.json",
        "v4/seed42_adapter.pt",
        "canonical_extended.parquet",
        "v4_calibration_policy.json",
    ]
    for name in files:
        path = species_dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"dummy asset")
    monkeypatch.setattr(manager, "verify_manifest", lambda path: {})
    classifier = SimpleNamespace(
        device="cpu", _dtype=torch.float32, num_classes=3, policy_name="test"
    )
    monkeypatch.setattr(manager, "SpeciesClassifier", lambda **kwargs: classifier)
    first = PipelineManager(Settings(models_dir=tmp_path))
    await first.initialize()
    assert "dinov3_species_v4_config" in first.version_descriptor["assets"]
    (species_dir / "backbone/config.json").write_bytes(b"changed config")
    second = PipelineManager(Settings(models_dir=tmp_path))
    await second.initialize()
    assert first.pipeline_version != second.pipeline_version
