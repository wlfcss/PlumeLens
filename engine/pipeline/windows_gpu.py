# pyright: basic
"""Optional, verified Windows ML AMD GPU acceleration with compiled-model caching."""

from __future__ import annotations

import hashlib
import json
import os
import sys
from functools import lru_cache
from pathlib import Path

import structlog

logger = structlog.get_logger()
_dll_directories: list[object] = []


def cache_root() -> Path:
    configured = os.environ.get("PLUMELENS_GPU_CACHE_DIR")
    if configured:
        return Path(configured)
    return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "PlumeLens" / "gpu-cache"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


@lru_cache(maxsize=2)
def registered_device(library_path: str | None = None):
    if sys.platform != "win32":
        return None
    import onnxruntime as ort

    if library_path is None:
        report = json.loads((cache_root() / "verified.json").read_text(encoding="utf-8"))
        library_path = str(report["device"]["ep"]["library_path"])
    if not Path(library_path).is_file():
        return None
    # ensure_ready is a setup operation: even an installed EP begins NotReady
    # in a fresh catalog process. Load the already verified installed DLL here.
    directory = os.add_dll_directory(str(Path(library_path).parent))
    ort.register_execution_provider_library("AMDGPUExecutionProvider", library_path)
    for device in ort.get_ep_devices():
        if device.ep_name == "AMDGPUExecutionProvider":
            _dll_directories.append(directory)
            return device
    directory.close()
    return None


def device_identity(device) -> dict:
    return {
        "vendor_id": device.device.vendor_id,
        "device_id": device.device.device_id,
        "ep": dict(device.ep_metadata),
    }


def verified_model(path: str) -> bool:
    """Only use a warm, validated cache; a cold compiler can take minutes."""
    if sys.platform != "win32":
        return False
    root = cache_root()
    marker = root / "verified.json"
    if not marker.is_file():
        return False
    try:
        report = json.loads(marker.read_text(encoding="utf-8"))
        model = Path(path)
        item = report["models"].get(model.name)
        if not item or item["sha256"] != sha256(model):
            return False
        device = registered_device()
        if device is None or report["device"] != device_identity(device):
            return False
        return bool(item["cache_files"]) and all(
            (root / entry["name"]).is_file()
            and (root / entry["name"]).stat().st_size == entry["bytes"]
            and sha256(root / entry["name"]) == entry["sha256"]
            for entry in item["cache_files"]
        )
    except Exception as error:
        logger.warning("AMD GPU cache unavailable; using compatible backend", error=str(error))
        return False


def create_verified_session(path: str, options, *, device=None):
    import onnxruntime as ort

    if device is None:
        device = registered_device()
    if device is None:
        raise RuntimeError("Windows AMD GPU provider is not ready")
    root = cache_root()
    os.environ["ORT_MIGRAPHX_CACHE_DIR"] = str(root)
    options.add_provider_for_devices([device], {"cache_dir": str(root)})
    os.environ.setdefault("ORT_MIGRAPHX_PROBLEM_CACHE", str(root / "problem_cache.json"))
    return ort.InferenceSession(path, sess_options=options)
