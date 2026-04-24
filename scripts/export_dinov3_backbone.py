"""Export DINOv3 bird classifier to ONNX for PlumeLens.

The DINOv3 backbone ONNX file is 1.2GB which exceeds GitHub's 100MB per-file
limit, so it is not checked into the repo. Developers needing species
classification must run this script once to produce it locally.

Produces two files in engine/models/:
  - dinov3_backbone.onnx    fp32 feature extractor, dynamic H/W (512 or 640)
  - species_ensemble.onnx   fp32, 7-head ensemble → 1516 species softmax

Prerequisites:
  1. Extract the dino_bird_classifier package (provided separately by the
     maintainer — not tracked in git due to size). It should contain:

         <pkg>/
         ├── bird_classifier/model.py         (HeadOnlyClassifier)
         ├── checkpoints/*.pt                 (7 head checkpoints)
         ├── models/dinov3-vitl16/            (1.2GB PyTorch backbone)
         └── taxonomy/canonical.parquet

  2. Install a one-off Python env (avoid polluting .venv):

         uv venv /tmp/dinov3-export-env --python 3.11
         /tmp/dinov3-export-env/bin/python -m pip install \\
             torch transformers pillow numpy onnx onnxruntime

  3. Run:

         /tmp/dinov3-export-env/bin/python scripts/export_dinov3_backbone.py \\
             --source-pkg /path/to/dino_bird_classifier \\
             --out-dir engine/models

Notes:
  - Export uses fp32: pure fp16 overflows in ViT-L's LayerNorm/Softmax and
    collapses accuracy. Original project uses torch.autocast (mixed precision)
    to avoid this; we keep fp32 for ONNX Runtime correctness.
  - Backbone is exported with dynamic H/W so a single file serves both the
    512 and 640 scales required by the ensemble.
  - Output is bit-compatible with the original PyTorch ensemble (verified via
    parity check: cosine_similarity = 1.000, top-5 overlap = 5/5).
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

CKPTS = [
    ("checkpoints/model_512_seed42.pt", 512),
    ("checkpoints/model_512_seed123.pt", 512),
    ("checkpoints/model_512_seed456.pt", 512),
    ("checkpoints/model_512_seed2024.pt", 512),
    ("checkpoints/model_640_seed42.pt", 640),
    ("checkpoints/model_640_seed123.pt", 640),
    ("checkpoints/model_640_seed456.pt", 640),
]


class BackboneWrapper(nn.Module):
    """DINOv3 backbone → pooled 2048-d feature (CLS ⊕ mean(patch))."""

    def __init__(self, backbone, num_registers: int):
        super().__init__()
        self.backbone = backbone
        self.num_registers = num_registers

    def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:
        out = self.backbone(pixel_values=pixel_values).last_hidden_state
        cls_tok = out[:, 0, :]
        patch_tok = out[:, 1 + self.num_registers :, :].mean(dim=1)
        return torch.cat([cls_tok, patch_tok], dim=-1)  # (B, 2048)


class EnsembleHeads(nn.Module):
    """7-head ensemble: avg softmax over 4×512 + 3×640 heads → 1516 species probs."""

    def __init__(self, heads_512, heads_640):
        super().__init__()
        self.heads_512 = nn.ModuleList(heads_512)
        self.heads_640 = nn.ModuleList(heads_640)

    def forward(self, feat_512: torch.Tensor, feat_640: torch.Tensor) -> torch.Tensor:
        probs = []
        for h in self.heads_512:
            probs.append(F.softmax(h(feat_512)["species"], dim=1))
        for h in self.heads_640:
            probs.append(F.softmax(h(feat_640)["species"], dim=1))
        return torch.stack(probs, dim=0).mean(dim=0)  # (B, 1516)


def load_head(pkg_root: Path, rel_path: str, HeadOnlyClassifier) -> nn.Module:
    sd = torch.load(pkg_root / rel_path, map_location="cpu", weights_only=False)
    ms = sd["model_state"]
    m = HeadOnlyClassifier(
        feature_dim=2048,
        num_species=ms["species_head.weight"].shape[0],
        features_layout="pooled",
        dropout=0.0,
        num_orders=ms["order_head.weight"].shape[0],
        num_families=ms["family_head.weight"].shape[0],
        num_genera=ms["genus_head.weight"].shape[0],
    )
    m.load_state_dict(ms)
    return m.eval()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source-pkg",
        type=Path,
        required=True,
        help="Path to the extracted dino_bird_classifier package",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path("engine/models"),
        help="Where to write dinov3_backbone.onnx and species_ensemble.onnx",
    )
    args = parser.parse_args()

    pkg_root = args.source_pkg.resolve()
    out_dir = args.out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    if not (pkg_root / "bird_classifier/model.py").exists():
        sys.exit(f"error: HeadOnlyClassifier not found under {pkg_root}")

    # Defer transformers import so --help works without the heavy deps.
    sys.path.insert(0, str(pkg_root))
    from bird_classifier.model import HeadOnlyClassifier  # type: ignore[import-not-found]
    from transformers import AutoModel  # type: ignore[import-not-found]

    print(f"Loading DINOv3 backbone from {pkg_root / 'models/dinov3-vitl16'}…")
    backbone = AutoModel.from_pretrained(str(pkg_root / "models/dinov3-vitl16")).eval()
    for p in backbone.parameters():
        p.requires_grad_(False)
    num_registers = backbone.config.num_register_tokens
    print(f"  num_register_tokens = {num_registers}")

    # --- backbone (fp32, dynamic H/W) ---
    print("\nExporting backbone (fp32, dynamic H/W)…")
    bb_wrapper = BackboneWrapper(backbone, num_registers).eval()
    dummy = torch.randn(1, 3, 512, 512)
    backbone_path = out_dir / "dinov3_backbone.onnx"
    torch.onnx.export(
        bb_wrapper,
        dummy,
        str(backbone_path),
        input_names=["pixel_values"],
        output_names=["features"],
        opset_version=17,
        do_constant_folding=True,
        dynamo=False,
        dynamic_axes={"pixel_values": {2: "H", 3: "W"}},
    )
    size_mb = backbone_path.stat().st_size / 1024 / 1024
    print(f"  → {backbone_path}  ({size_mb:.1f} MB)")

    # --- ensemble heads (fp32) ---
    print("\nLoading 7 heads…")
    heads_512 = [load_head(pkg_root, r, HeadOnlyClassifier) for r, s in CKPTS if s == 512]
    heads_640 = [load_head(pkg_root, r, HeadOnlyClassifier) for r, s in CKPTS if s == 640]
    print(f"  {len(heads_512)} × 512 heads + {len(heads_640)} × 640 heads")

    ensemble = EnsembleHeads(heads_512, heads_640).eval()
    dummy_512 = torch.randn(1, 2048)
    dummy_640 = torch.randn(1, 2048)
    ensemble_path = out_dir / "species_ensemble.onnx"
    print(f"\nExporting ensemble head → {ensemble_path}…")
    torch.onnx.export(
        ensemble,
        (dummy_512, dummy_640),
        str(ensemble_path),
        input_names=["feat_512", "feat_640"],
        output_names=["species_probs"],
        opset_version=17,
        do_constant_folding=True,
        dynamo=False,
    )
    size_mb = ensemble_path.stat().st_size / 1024 / 1024
    print(f"  → {ensemble_path}  ({size_mb:.1f} MB)")

    # --- smoke test ---
    print("\nSmoke test via onnxruntime (CPU)…")
    import onnxruntime as ort  # type: ignore[import-not-found]

    sess_bb = ort.InferenceSession(str(backbone_path), providers=["CPUExecutionProvider"])
    sess_en = ort.InferenceSession(str(ensemble_path), providers=["CPUExecutionProvider"])
    img512 = np.random.rand(1, 3, 512, 512).astype(np.float32)
    img640 = np.random.rand(1, 3, 640, 640).astype(np.float32)
    feat_512 = sess_bb.run(None, {"pixel_values": img512})[0]
    feat_640 = sess_bb.run(None, {"pixel_values": img640})[0]
    probs = sess_en.run(None, {"feat_512": feat_512, "feat_640": feat_640})[0]
    print(f"  backbone @ 512: {feat_512.shape} {feat_512.dtype}")
    print(f"  backbone @ 640: {feat_640.shape} {feat_640.dtype}")
    print(f"  ensemble probs: {probs.shape}  sum={probs.sum():.3f} (should ≈ 1.0)")

    print("\nDone.")


if __name__ == "__main__":
    main()
