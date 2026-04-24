"""Identify which of the 1516 species are actually trained.

DINOv3 分类 head 输出 1516 维对齐《中国鸟类名录 v12.0》全名单，但训练时用
`min_images_per_species=75` 过滤后只保留 1018 种。未训练的 498 类权重留在
初始化状态（L2 范数 ≈ 1.0），训练过的类权重范数明显更大（range: 1.5-3.0）。

本脚本分析 species_ensemble.onnx 里的 species_head.weight per-class L2 norm，
自动识别 trained / untrained boundary，输出 trained species 列表。

Usage:
    uv run python scripts/identify_trained_species.py
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import onnx
import pyarrow.parquet as pq

ENSEMBLE_ONNX = Path("engine/models/species_ensemble.onnx")
TAXONOMY = Path("engine/models/species_taxonomy.parquet")
OUTPUT = Path("engine/models/species_trained.json")

# 阈值：低于此值判定为未训练（基于 median * 0.6，凭经验与 MODEL_CARD 校验一致）
NORM_THRESHOLD = 1.27


def main() -> None:
    # 读 head weights（用 heads_512.0 作为代表，所有 head 应给出一致的 trained set）
    model = onnx.load(str(ENSEMBLE_ONNX))
    head_weight = None
    for init in model.graph.initializer:
        if "species_head.weight" in init.name:
            head_weight = np.frombuffer(init.raw_data, dtype=np.float32).reshape(
                init.dims,
            )
            break
    if head_weight is None:
        raise SystemExit("Cannot find species_head.weight in ensemble ONNX")

    per_class_norm = np.linalg.norm(head_weight, axis=1)  # shape (1516,)
    trained_mask = per_class_norm >= NORM_THRESHOLD
    trained_indices = np.where(trained_mask)[0].tolist()

    # 读 taxonomy（按 canonical_sci 字典序对齐 model 的 head 索引）
    rows = pq.read_table(TAXONOMY).to_pylist()
    rows.sort(key=lambda r: r["canonical_sci"])
    all_sci = [r["canonical_sci"] for r in rows]

    trained_sci = [all_sci[i] for i in trained_indices]
    untrained_sci = [all_sci[i] for i in range(len(all_sci)) if i not in set(trained_indices)]

    print(f"Total head slots: {len(all_sci)}")
    print(f"Trained species:  {len(trained_sci)}")
    print(f"Untrained slots:  {len(untrained_sci)}")
    print(f"\nHead-weight L2 norm distribution:")
    print(f"  min={per_class_norm.min():.3f}, max={per_class_norm.max():.3f}")
    print(f"  median={np.median(per_class_norm):.3f}, threshold={NORM_THRESHOLD}")

    # 写 JSON（两列表都包含，供前后端分别使用）
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps(
            {
                "trained": sorted(trained_sci),
                "untrained": sorted(untrained_sci),
                "norm_threshold": NORM_THRESHOLD,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"\nWrote {OUTPUT}  ({OUTPUT.stat().st_size / 1024:.1f} KB)")

    print(f"\nSample trained species (first 5): {trained_sci[:5]}")
    print(f"Sample untrained species (first 5): {untrained_sci[:5]}")


if __name__ == "__main__":
    main()
