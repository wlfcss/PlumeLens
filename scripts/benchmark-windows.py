"""Compare installed Windows GPU backends with CPU on the shipped model assets."""

from __future__ import annotations

import argparse
import gc
import json
import platform
import statistics
import sys
import time
from functools import partial
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine.pipeline.runtime import create_session

ROOT = Path(__file__).resolve().parents[1]
MODELS = {
    "yolo": "yolo26l-bird-det.onnx",
    "pose": "bird_visibility11.onnx",
    "flight": "bird_flight_classifier.onnx",
    "clipiqa": "clipiqa_plus.onnx",
    "hyperiqa": "hyperiqa.onnx",
}


def timed(call, repeats, synchronize=lambda: None):
    call()
    synchronize()
    durations = []
    result = None
    for _ in range(repeats):
        synchronize()
        start = time.perf_counter()
        result = call()
        synchronize()
        durations.append((time.perf_counter() - start) * 1000)
    return result, statistics.median(durations)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--species", action="store_true")
    parser.add_argument("--species-only", action="store_true")
    parser.add_argument("--species-cpu-only", action="store_true")
    parser.add_argument("--reference", type=Path)
    parser.add_argument("--repeats", type=int, default=5)
    args = parser.parse_args()
    import onnxruntime as ort

    picture = next((ROOT / "resources/species-artwork").glob("*.webp"))
    image = Image.open(picture).convert("RGB")
    report = {
        "platform": platform.platform(),
        "onnxruntime": ort.__version__,
        "available_providers": ort.get_available_providers(),
        "sample": picture.name,
        "repeats": args.repeats,
        "models": {},
    }
    if "DmlExecutionProvider" not in ort.get_available_providers():
        raise RuntimeError("DirectML is not installed")
    for name, filename in ({} if args.species_only or args.species_cpu_only else MODELS).items():
        path = str(ROOT / "engine/models" / filename)
        cpu = create_session(path, providers=["CPUExecutionProvider"])
        gpu = create_session(path, providers=["DmlExecutionProvider", "CPUExecutionProvider"])
        info = cpu.get_inputs()[0]
        defaults = [1, 3, 224, 224]
        shape = [dim if isinstance(dim, int) else defaults[i] for i, dim in enumerate(info.shape)]
        pixels = np.asarray(image.resize((shape[-1], shape[-2])), dtype=np.float32) / 255
        inputs = {info.name: np.ascontiguousarray(pixels.transpose(2, 0, 1)[None])}
        expected, cpu_ms = timed(partial(cpu.run, None, inputs), args.repeats)
        actual, gpu_ms = timed(partial(gpu.run, None, inputs), args.repeats)
        finite = all(np.isfinite(value).all() for value in actual)
        # TopK output slots with equal/near-zero confidence may be permuted by
        # different backends. Compare meaningful detections, not empty slots.
        reference, observed = expected, actual
        if name == "yolo":
            reference = [expected[0][0][expected[0][0, :, 4] >= 0.5]]
            observed = [actual[0][0][actual[0][0, :, 4] >= 0.5]]
            reference = [rows[np.argsort(rows[:, 0])] for rows in reference]
            observed = [rows[np.argsort(rows[:, 0])] for rows in observed]
        elif name == "pose":
            reference = [expected[0][0, np.argmax(expected[0][0, :, 4])]]
            observed = [actual[0][0, np.argmax(actual[0][0, :, 4])]]
        same_shape = all(a.shape == b.shape for a, b in zip(reference, observed, strict=True))
        max_abs = (
            max(
                float(np.max(np.abs(a - b))) if a.size else 0.0
                for a, b in zip(reference, observed, strict=True)
            )
            if same_shape
            else None
        )
        close = same_shape and all(
            np.allclose(a, b, atol=0.02, rtol=0.005)
            for a, b in zip(reference, observed, strict=True)
        )
        result = {
            "cpu_ms": cpu_ms,
            "directml_ms": gpu_ms,
            "speedup": cpu_ms / gpu_ms,
            "max_abs_error": max_abs,
            "finite": finite,
            "within_tolerance": close,
            "providers": gpu.get_providers(),
            "compared_shapes": [list(a.shape) for a in reference],
        }
        report["models"][name] = result
        print(name, json.dumps(result), flush=True)
        args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
        del cpu, gpu
        gc.collect()
    if args.species or args.species_only or args.species_cpu_only:
        import torch

        torch.set_num_threads(4)
        import faulthandler

        faulthandler.dump_traceback_later(60, repeat=True)
        from engine.pipeline.species import SpeciesClassifier, preprocess_for_dinov3

        report["torch"] = torch.__version__
        report["hip"] = torch.version.hip
        if not args.species_cpu_only and (not torch.cuda.is_available() or not torch.version.hip):
            raise RuntimeError("AMD ROCm GPU is not available")
        if not args.species_cpu_only:
            report["gpu"] = torch.cuda.get_device_name(0)
        print("Loading species CPU reference", flush=True)
        classifier = SpeciesClassifier(ROOT / "engine/models/species", device="cpu")
        crop = np.asarray(image, dtype=np.float32) / 255
        x = preprocess_for_dinov3(crop)

        @torch.inference_mode()
        def forward(model, tensor):
            features = model.forward_features(tensor).float()
            return (
                torch.softmax(model.species_head(features), dim=1).cpu().numpy(),
                torch.sigmoid(model.reject_head(features)).cpu().numpy(),
            )

        print("Running species CPU reference", flush=True)
        if args.reference:
            reference = json.loads(args.reference.read_text(encoding="utf-8"))["species_reference"]
            expected = (
                np.array(reference["probabilities"], dtype=np.float32),
                np.array(reference["reject"], dtype=np.float32),
            )
            cpu_ms = reference["cpu_ms"]
        else:
            expected, cpu_ms = timed(lambda: forward(classifier._model, x), args.repeats)
        if args.species_cpu_only:
            report["species_reference"] = {
                "cpu_ms": cpu_ms,
                "probabilities": expected[0].tolist(),
                "reject": expected[1].tolist(),
                "torch": torch.__version__,
            }
            args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(f"CPU reference saved: {cpu_ms:.2f} ms", flush=True)
            faulthandler.cancel_dump_traceback_later()
            return
        print(f"Species CPU: {cpu_ms:.2f} ms; transferring model to AMD GPU", flush=True)
        classifier._model.backbone.to(device="cuda", dtype=torch.float32)
        classifier._model.species_head.to("cuda")
        classifier._model.reject_head.to("cuda")
        gpu_x = x.to(device="cuda", dtype=torch.float32)
        print("Running species on AMD GPU", flush=True)
        actual, gpu_ms = timed(
            lambda: forward(classifier._model, gpu_x), args.repeats, torch.cuda.synchronize
        )
        report["species"] = {
            "cpu_ms": cpu_ms,
            "rocm_ms": gpu_ms,
            "speedup": cpu_ms / gpu_ms,
            "cpu_top1": int(expected[0].argmax()),
            "rocm_top1": int(actual[0].argmax()),
            "max_probability_error": float(np.max(np.abs(expected[0] - actual[0]))),
            "reject_score_error": float(np.max(np.abs(expected[1] - actual[1]))),
            "finite": all(np.isfinite(value).all() for value in actual),
        }
        print("species", json.dumps(report["species"]), flush=True)
        faulthandler.cancel_dump_traceback_later()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
