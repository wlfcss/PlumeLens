# pyright: basic
"""Prepare and verify the optional native AMD GPU detector before enabling it."""

from __future__ import annotations

import argparse
import gc
import json
import os
import statistics
import sys
import threading
import time
from importlib import import_module
from pathlib import Path

import numpy as np
from PIL import Image

from engine.pipeline.windows_gpu import (
    cache_root,
    create_verified_session,
    device_identity,
    registered_device,
    sha256,
)

ROOT = (
    Path(sys.executable).resolve().parent.parent
    if getattr(sys, "frozen", False)
    else Path(__file__).resolve().parents[2]
)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--models-dir",
        type=Path,
        default=ROOT / ("models" if getattr(sys, "frozen", False) else "engine/models"),
    )
    parser.add_argument(
        "--artwork-dir",
        type=Path,
        default=ROOT
        / ("species-artwork" if getattr(sys, "frozen", False) else "resources/species-artwork"),
    )
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    if args.cache_dir:
        os.environ["PLUMELENS_GPU_CACHE_DIR"] = str(args.cache_dir.resolve())
    root = cache_root()
    root.mkdir(parents=True, exist_ok=True)
    marker = root / "verified.json"
    marker.unlink(missing_ok=True)
    # Keep DLL initialization order consistent with normal application startup.
    import_module("torch")
    import onnxruntime as ort
    import windowsml  # pyright: ignore[reportMissingImports]  # Windows-only dependency

    with windowsml.EpCatalog() as catalog:
        providers = [
            provider
            for provider in catalog.find_all_providers()
            if provider.name == "AMDGPUExecutionProvider"
        ]
        if not providers:
            raise RuntimeError("Windows ML does not expose an AMD GPU provider for this device")
        provider = providers[0]
        if provider.ready_state != windowsml.EpReadyState.Ready:
            done = threading.Event()
            operation = provider.ensure_ready_async(
                on_complete=done.set,
                on_progress=lambda progress: print(f"AMD component: {progress:.0f}%", flush=True),
            )
            if not done.wait(240):
                operation.cancel()
                raise TimeoutError("AMD GPU component download timed out")
            operation.wait()
        library_path = provider.library_path

    device = registered_device(library_path)
    if device is None:
        raise RuntimeError("No compatible AMD GPU device")
    model = args.models_dir.resolve() / "yolo26l-bird-det.onnx"
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    print("Preparing AMD detector cache (first run may take several minutes)", flush=True)
    started = time.perf_counter()
    session = create_verified_session(str(model), options, device=device)
    prepare_seconds = time.perf_counter() - started
    cpu = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"], sess_options=options)
    info = session.get_inputs()[0]
    shape = info.shape
    image_paths = sorted(args.artwork_dir.glob("*.webp"))[:4]
    errors = []
    durations = []
    test_inputs = None
    for image_path in image_paths:
        with Image.open(image_path) as image:
            pixels = (
                np.asarray(image.convert("RGB").resize((shape[-1], shape[-2])), dtype=np.float32)
                / 255
            )
        test_inputs = {info.name: np.ascontiguousarray(pixels.transpose(2, 0, 1)[None])}
        cpu_output = cpu.run(None, test_inputs)[0]
        gpu_output = session.run(None, test_inputs)[0]
        if not isinstance(cpu_output, np.ndarray) or not isinstance(gpu_output, np.ndarray):
            raise RuntimeError("Detector returned a non-dense output")
        expected, actual = cpu_output[0], gpu_output[0]
        expected = expected[expected[:, 4] >= 0.2]
        actual = actual[actual[:, 4] >= 0.2]
        expected = expected[np.argsort(expected[:, 0])]
        actual = actual[np.argsort(actual[:, 0])]
        if expected.shape != actual.shape or not np.allclose(
            expected, actual, atol=0.02, rtol=0.005
        ):
            raise RuntimeError(f"AMD detector parity failed: {image_path.name}")
        errors.append(float(np.max(np.abs(expected - actual))) if expected.size else 0.0)
        started = time.perf_counter()
        session.run(None, test_inputs)
        durations.append((time.perf_counter() - started) * 1000)
    del session
    gc.collect()
    warm_options = ort.SessionOptions()
    warm_options.intra_op_num_threads = 4
    started = time.perf_counter()
    warm = create_verified_session(str(model), warm_options, device=device)
    if test_inputs is None:
        raise RuntimeError("Missing validation artwork")
    warm.run(None, test_inputs)
    warm_seconds = time.perf_counter() - started
    if warm_seconds > 30:
        raise RuntimeError("Compiled AMD cache was not reused; refusing to enable slow startup")
    caches = [
        {"name": path.name, "bytes": path.stat().st_size, "sha256": sha256(path)}
        for path in root.glob("*.mxr")
    ]
    if not caches:
        raise RuntimeError("AMD compiler did not create a persistent cache")
    report = {
        "device": device_identity(device),
        "models": {model.name: {"sha256": sha256(model), "cache_files": caches}},
        "prepare_seconds": prepare_seconds,
        "warm_seconds": warm_seconds,
        "median_ms": statistics.median(durations),
        "max_detection_error": max(errors),
        "onnxruntime": ort.__version__,
    }
    if args.output:
        args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    temporary = marker.with_suffix(".tmp")
    temporary.write_text(json.dumps(report, indent=2), encoding="utf-8")
    temporary.replace(marker)
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    main()
