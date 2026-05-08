"""Regenerate engine/models/manifest.json — pin SHA-256 of all critical assets.

Run after training produces a new model bundle, or when adding a new asset to
the runtime load path:

    uv run python scripts/build_model_manifest.py

Commit the regenerated manifest in the SAME commit as the changed model files.
Engine startup refuses to load if any asset's SHA-256 doesn't match the manifest
(see engine/core/manifest.py) — this is the last line of defense against
supply-chain tampering, especially for species/v4/seed42_adapter.pt which is
loaded via torch.load(weights_only=False) and reconstructs arbitrary Python
objects via pickle.
"""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = ROOT / "engine" / "models"
MANIFEST = MODELS_DIR / "manifest.json"

# 启动期校验白名单 — 修改这里需要同步更新 engine/pipeline/manager.py 加载逻辑。
# 排除规则:
# - species/heads/seed*.pt 是旧 v3 8-head ensemble,v4 LoRA/reject 路线不再加载,
#   暂不入 manifest(待删除时一并清理)。
# - species_wiki.parquet 仅 build-time 转 renderer/src/lib/species-wiki.json,
#   runtime 不被 Python 加载,不入 manifest。
TRACKED_ASSETS = [
    # detector
    "yolo26l-bird-det.onnx",
    # pose v2 (11 关键点)
    "bird_visibility11.onnx",
    "bird_visibility11_config.json",
    # IQA
    "clipiqa_plus.onnx",
    "hyperiqa.onnx",
    # species v4 (DINOv3 ViT-L + LoRA + reject)
    "species/backbone/config.json",
    "species/backbone/model.safetensors",
    "species/canonical_extended.parquet",
    "species/v4_calibration_policy.json",
    # ⚠️ pickle (torch.load weights_only=False) — SHA pin 是阻断 RCE 最后闸
    "species/v4/seed42_adapter.pt",
]


def sha256_of(path: Path) -> str:
    """Stream the file in 1 MiB chunks (avoid loading multi-GB models into RAM)."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    if not MODELS_DIR.is_dir():
        print(f"Models dir not found: {MODELS_DIR}", file=sys.stderr)
        return 2

    assets: dict[str, dict[str, object]] = {}
    missing: list[str] = []
    for rel in TRACKED_ASSETS:
        full = MODELS_DIR / rel
        if not full.is_file():
            missing.append(rel)
            continue
        assets[rel] = {
            "size": full.stat().st_size,
            "sha256": sha256_of(full),
        }

    if missing:
        print("Missing assets — refusing to write manifest:", file=sys.stderr)
        for rel in missing:
            print(f"  - {rel}", file=sys.stderr)
        return 1

    payload = {
        "manifest_version": 1,
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "comment": (
            "Model asset SHA-256 pin. Engine startup refuses to load if hashes "
            "don't match. species/v4/seed42_adapter.pt 是 pickle "
            "(torch.load weights_only=False), SHA pin 是阻断供应链 RCE 的最后一道闸。"
            "Regenerate via `uv run python scripts/build_model_manifest.py` "
            "after training updates."
        ),
        "assets": assets,
    }

    MANIFEST.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {MANIFEST.relative_to(ROOT)} ({len(assets)} entries)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
