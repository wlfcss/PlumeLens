import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from engine.pipeline import windows_gpu


def test_missing_cache_does_not_load_optional_windows_component(tmp_path, monkeypatch):
    monkeypatch.setattr(windows_gpu.sys, "platform", "win32")
    monkeypatch.setattr(windows_gpu, "cache_root", lambda: tmp_path)
    monkeypatch.setattr(
        windows_gpu, "registered_device", lambda: pytest.fail("Unexpected discovery")
    )
    assert not windows_gpu.verified_model(str(tmp_path / "detector.onnx"))


@pytest.mark.parametrize("change", [None, "model", "cache", "device"])
def test_cache_requires_matching_model_hardware_and_bytes(tmp_path, monkeypatch, change):
    monkeypatch.setattr(windows_gpu.sys, "platform", "win32")
    monkeypatch.setattr(windows_gpu, "cache_root", lambda: tmp_path)
    device = SimpleNamespace(
        device=SimpleNamespace(vendor_id=4098, device_id=29772), ep_metadata={"version": "0.1.0"}
    )
    monkeypatch.setattr(windows_gpu, "registered_device", lambda: device)
    model = tmp_path / "detector.onnx"
    cache = tmp_path / "compiled.mxr"
    model.write_bytes(b"model")
    cache.write_bytes(b"cache")
    marker = {
        "device": windows_gpu.device_identity(device),
        "models": {
            model.name: {
                "sha256": windows_gpu.sha256(model),
                "cache_files": [
                    {
                        "name": cache.name,
                        "bytes": cache.stat().st_size,
                        "sha256": windows_gpu.sha256(cache),
                    }
                ],
            }
        },
    }
    (tmp_path / "verified.json").write_text(json.dumps(marker), encoding="utf-8")
    if change == "model":
        model.write_bytes(b"other")
    elif change == "cache":
        cache.write_bytes(b"other")
    elif change == "device":
        device.device.device_id = 123
    assert windows_gpu.verified_model(str(model)) is (change is None)


def test_setup_can_create_session_before_a_verification_marker_exists(tmp_path, monkeypatch):
    import onnxruntime as ort

    monkeypatch.setattr(windows_gpu, "cache_root", lambda: tmp_path)
    monkeypatch.setattr(windows_gpu, "registered_device", lambda: pytest.fail("No marker yet"))
    constructor = MagicMock()
    monkeypatch.setattr(ort, "InferenceSession", constructor)
    options, device = MagicMock(), object()
    session = windows_gpu.create_verified_session("model.onnx", options, device=device)
    assert session is constructor.return_value
    options.add_provider_for_devices.assert_called_once_with([device], {"cache_dir": str(tmp_path)})
