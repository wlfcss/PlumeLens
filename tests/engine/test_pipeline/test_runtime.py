"""Provider selection and the DirectML single-Run-per-session contract."""

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import MagicMock

import onnxruntime as ort
import pytest
from engine.pipeline.runtime import create_session, resolve_providers


@pytest.mark.parametrize(
    ("available", "requested", "expected"),
    [
        (["DmlExecutionProvider", "CPUExecutionProvider"], "auto", "DmlExecutionProvider"),
        (["CUDAExecutionProvider", "CPUExecutionProvider"], "auto", "CUDAExecutionProvider"),
        (["CoreMLExecutionProvider", "CPUExecutionProvider"], "auto", "CoreMLExecutionProvider"),
        (["CPUExecutionProvider"], "directml", "CPUExecutionProvider"),
        (["DmlExecutionProvider", "CPUExecutionProvider"], "cpu", "CPUExecutionProvider"),
    ],
)
def test_selects_installed_provider_and_falls_back_to_cpu(
    monkeypatch, available, requested, expected
):
    monkeypatch.setattr(ort, "get_available_providers", lambda: available)
    assert resolve_providers(requested)[0] == expected


def test_directml_disables_memory_patterns_and_serializes_concurrent_runs(monkeypatch):
    active = 0
    peak = 0
    guard = threading.Lock()

    def run(value):
        nonlocal active, peak
        with guard:
            active += 1
            peak = max(peak, active)
        time.sleep(0.01)
        with guard:
            active -= 1
        return value

    backend = MagicMock()
    backend.run.side_effect = run
    constructor = MagicMock(return_value=backend)
    monkeypatch.setattr(ort, "InferenceSession", constructor)
    session = create_session(
        "test.onnx", providers=["DmlExecutionProvider", "CPUExecutionProvider"]
    )
    options = constructor.call_args.kwargs["sess_options"]
    assert not options.enable_mem_pattern
    assert options.execution_mode == ort.ExecutionMode.ORT_SEQUENTIAL
    with ThreadPoolExecutor(max_workers=4) as pool:
        assert list(pool.map(session.run, range(16))) == list(range(16))
        other = create_session("second.onnx", providers=["DmlExecutionProvider"])
        assert list(
            pool.map(lambda value: (session if value % 2 else other).run(value), range(16))
        ) == list(range(16))
    assert peak == 1
    assert session.get_providers() == backend.get_providers()


def test_native_amd_initialization_failure_starts_compatible_cpu_session(monkeypatch):
    from engine.pipeline import windows_gpu

    monkeypatch.setattr(
        windows_gpu, "create_verified_session", MagicMock(side_effect=RuntimeError("stale driver"))
    )
    constructor = MagicMock()
    monkeypatch.setattr(ort, "InferenceSession", constructor)
    session = create_session(
        "test.onnx", providers=["AMDGPUExecutionProvider", "CPUExecutionProvider"]
    )
    assert session is constructor.return_value
    assert constructor.call_args.kwargs["providers"] == ["CPUExecutionProvider"]


def test_coreml_mlprogram_options_and_cache_dir_fallback(monkeypatch, tmp_path):
    monkeypatch.setattr(
        ort, "get_available_providers", lambda: ["CoreMLExecutionProvider", "CPUExecutionProvider"]
    )
    cache_dir = str(tmp_path / "coreml-cache")
    providers = resolve_providers(
        "auto",
        coreml_compute_units="CPUAndGPU",
        coreml_model_format="MLProgram",
        coreml_cache_dir=cache_dir,
    )
    assert providers == [
        (
            "CoreMLExecutionProvider",
            {
                "ModelFormat": "MLProgram",
                "MLComputeUnits": "CPUAndGPU",
                "ModelCacheDirectory": cache_dir,
            },
        ),
        "CPUExecutionProvider",
    ]

    calls = []
    fallback_session = MagicMock()

    def fake_session(path, **kwargs):
        calls.append(kwargs["providers"])
        if len(calls) == 1:
            raise RuntimeError("corrupted coreml cache")
        return fallback_session

    monkeypatch.setattr(ort, "InferenceSession", fake_session)
    session = create_session("test.onnx", providers=providers)
    assert session is fallback_session
    assert len(calls) == 2
    assert "ModelCacheDirectory" in calls[0][0][1]
    assert "ModelCacheDirectory" not in calls[1][0][1]
    assert calls[1][0][1]["ModelFormat"] == "MLProgram"


def test_configure_macos_scales_workers_and_respects_overrides(monkeypatch):
    from engine.core.config import Settings
    from engine.core.windows_resources import configure_macos, recommended_macos_workers

    assert recommended_macos_workers(8 * 1024**3, 8) == 2
    assert recommended_macos_workers(16 * 1024**3, 8) == 3
    assert recommended_macos_workers(64 * 1024**3, 16) == 4

    monkeypatch.setattr(
        "engine.core.windows_resources._macos_total_memory_bytes", lambda: 64 * 1024**3
    )
    monkeypatch.setattr("engine.core.windows_resources.logical_cpus", lambda: 16)
    auto_settings = Settings()
    profile = configure_macos(auto_settings)
    assert auto_settings.analysis_concurrency == 4
    assert profile["configuration"]["analysis_concurrency"] == 4

    manual_settings = Settings(analysis_concurrency=2)
    configure_macos(manual_settings)
    assert manual_settings.analysis_concurrency == 2


def test_record_provider_strips_coreml_cache_dir_for_stable_pipeline_version(tmp_path):
    from engine.core.config import Settings
    from engine.pipeline.manager import PipelineManager

    pm = PipelineManager(Settings(data_dir=tmp_path))
    sess = MagicMock()
    sess.get_providers.return_value = ["CoreMLExecutionProvider", "CPUExecutionProvider"]
    sess.get_provider_options.return_value = {
        "CoreMLExecutionProvider": {
            "ModelFormat": "MLProgram",
            "MLComputeUnits": "CPUAndGPU",
            "ModelCacheDirectory": str(tmp_path / "cache" / "coreml"),
        }
    }
    pm._record_provider("yolo", sess)
    opts = pm._provider_details["yolo"]["options"]["CoreMLExecutionProvider"]
    assert opts == {"ModelFormat": "MLProgram", "MLComputeUnits": "CPUAndGPU"}


def test_species_classify_throttles_mps_empty_cache(monkeypatch):
    import numpy as np
    import torch
    from engine.pipeline import species
    from engine.pipeline.species import SpeciesClassifier, SpeciesPolicy

    empty_calls = 0

    def fake_empty():
        nonlocal empty_calls
        empty_calls += 1

    monkeypatch.setattr(species, "preprocess_for_dinov3", lambda *a: torch.zeros((1, 3, 4, 4)))
    monkeypatch.setattr(species, "_MPS_EMPTY_CACHE_INTERVAL", 3)
    monkeypatch.setattr(torch.mps, "empty_cache", fake_empty)

    clf = object.__new__(SpeciesClassifier)
    clf.device = "mps"
    clf._dtype = torch.float32
    clf._infer_lock = threading.Lock()
    clf._infer_count = 0
    clf.image_size = 4
    clf._trained_mask = np.ones(2, dtype=bool)
    clf._min_confidence = 0.01
    clf._top_k = 2
    clf._policy = SpeciesPolicy.balanced_default()
    clf._taxonomy = MagicMock()
    clf._taxonomy.sci_at.side_effect = lambda idx: f"Sp_{idx}"
    clf._taxonomy.lookup.return_value = {}
    clf._model = MagicMock()
    clf._model.reject_detach_features = True
    clf._model.forward_features.return_value = torch.zeros((1, 4))
    clf._model.species_head.return_value = torch.tensor([[3.0, -1.0]])
    clf._model.reject_head.return_value = torch.tensor([[-3.0]])

    # Avoid real MPS tensor transfer in unit test by stubbing Tensor.to for 'mps'
    orig_to = torch.Tensor.to

    def _cpu_to(self, *args, **kwargs):
        if args and args[0] == "mps":
            return orig_to(self, "cpu")
        return orig_to(self, *args, **kwargs)

    monkeypatch.setattr(torch.Tensor, "to", _cpu_to)

    crop = np.zeros((4, 4, 3), dtype=np.uint8)
    for _ in range(5):
        clf.classify(crop)
    assert empty_calls == 1
    clf.classify(crop)
    assert empty_calls == 2
