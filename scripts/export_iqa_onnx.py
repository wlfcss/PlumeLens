"""Export CLIPIQA+ and HyperIQA to inline-weights ONNX from pyiqa.

为什么要这个脚本：项目早期携带的 IQA ONNX (<1 MB) 用 external_data 格式保存
权重但 `.onnx.data` 伴随文件从未入库，导致 onnxruntime 加载时失败。所有单元测试
用 mocked session 绕过，这个 bug 从 2026-04-12 到 2026-04-25 才被 PyInstaller
真实运行发现。

本脚本重新从 pyiqa 预训练权重导出为 inline-weights ONNX（~293 MB + ~104 MB）。

HyperIQA 需要 wrapper 绕过内部 uniform_crop（tracing 不兼容 F.interpolate 的
scale_factor 参数）；改用 `HyperNet.forward_patch()` 直接做 224×224 单裁切推理。

Usage:
    # 临时独立环境避免污染项目依赖
    uv venv /tmp/iqa-export --python 3.11
    VIRTUAL_ENV=/tmp/iqa-export uv pip install --python /tmp/iqa-export/bin/python \\
        torch torchvision pyiqa onnx onnxruntime pillow onnxscript
    /tmp/iqa-export/bin/python scripts/export_iqa_onnx.py --out-dir engine/models

输入/输出契约（供 engine/pipeline/quality.py 对齐）：
    输入: float32 [1, 3, 224, 224]，ImageNet 归一化（mean=[0.485,0.456,0.406], std=[0.229,0.224,0.225]）
    输出: [1, 1] 画质分 0~1
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pyiqa
import torch
import torch.nn as nn


class HyperIQATracableWrapper(nn.Module):
    """调用 HyperNet.forward_patch 绕过内部 uniform_crop（tracing 不友好）。

    假设输入已经预处理成 224×224 单 patch（下游调用方负责）。
    """

    def __init__(self, hypernet) -> None:
        super().__init__()
        self.hypernet = hypernet

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.hypernet.forward_patch(x)


def export_clipiqa(output: Path) -> None:
    print("\n=== Loading clipiqa+ via pyiqa ===")
    model = pyiqa.create_metric("clipiqa+", as_loss=False).eval()
    inner = getattr(model, "net", model)

    dummy = torch.randn(1, 3, 224, 224)
    print(f"  Tracing & exporting to {output}")
    torch.onnx.export(
        inner, dummy, str(output),
        opset_version=17,
        input_names=["image"], output_names=["score"],
        dynamic_axes={"image": {0: "batch", 2: "H", 3: "W"}, "score": {0: "batch"}},
        do_constant_folding=True, dynamo=False,
    )
    size_mb = output.stat().st_size / 1024 / 1024
    print(f"  → {output.name}  {size_mb:.2f} MB")
    _smoke_test(output)


def export_hyperiqa(output: Path) -> None:
    print("\n=== Loading hyperiqa via pyiqa ===")
    model = pyiqa.create_metric("hyperiqa", as_loss=False).eval()
    inner = getattr(model, "net", model)

    wrapper = HyperIQATracableWrapper(inner).eval()
    dummy = torch.randn(1, 3, 224, 224)

    with torch.no_grad():
        y = wrapper(dummy)
        print(f"  Wrapper output shape: {y.shape}  value={y.flatten()[:3]}")

    print(f"  Tracing & exporting to {output}")
    torch.onnx.export(
        wrapper, dummy, str(output),
        opset_version=17,
        input_names=["image"], output_names=["score"],
        dynamic_axes={"image": {0: "batch"}, "score": {0: "batch"}},
        do_constant_folding=True, dynamo=False,
    )
    size_mb = output.stat().st_size / 1024 / 1024
    print(f"  → {output.name}  {size_mb:.2f} MB")
    _smoke_test(output)


def _smoke_test(path: Path) -> None:
    import numpy as np
    import onnxruntime as ort
    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    test = np.random.rand(1, 3, 224, 224).astype(np.float32)
    out = sess.run(None, {"image": test})[0]
    print(f"  onnxruntime smoke: shape={out.shape}  value={out.flatten()[:3]}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--out-dir", type=Path, default=Path("engine/models"),
        help="Where to write the two ONNX files (default: engine/models)",
    )
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)

    tasks = [
        ("clipiqa+", export_clipiqa, args.out_dir / "clipiqa_plus.onnx"),
        ("hyperiqa", export_hyperiqa, args.out_dir / "hyperiqa.onnx"),
    ]
    for name, fn, out in tasks:
        try:
            fn(out)
        except Exception as e:
            import traceback
            print(f"  FAILED {name}: {e}", file=sys.stderr)
            traceback.print_exc()

    print("\nDone.")


if __name__ == "__main__":
    main()
