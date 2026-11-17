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
