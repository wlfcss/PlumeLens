"""Build renderer/src/lib/species-wiki.json from engine/models/species_wiki.parquet.

The frontend imports this JSON directly (no HTTP call, no backend dependency).
Run this whenever species_wiki.parquet is regenerated.

Usage:
    uv run python scripts/build_species_wiki_json.py
"""
from __future__ import annotations

import json
from pathlib import Path

import pyarrow.parquet as pq

SOURCE = Path("engine/models/species_wiki.parquet")
TRAINED_JSON = Path("engine/models/species_trained.json")
OUTPUT = Path("renderer/src/lib/species-wiki.json")


def main() -> None:
    import json

    if not SOURCE.exists():
        raise SystemExit(f"Missing {SOURCE} — run scripts/fetch_species_wiki.py first")

    rows = pq.read_table(SOURCE).to_pylist()
    rows.sort(key=lambda r: r["canonical_sci"])

    # 只保留 DINOv3 实际训练过的 1018 种（分类模型对 498 未训练类输出不可信，
    # 前端展示 Wikipedia 介绍时避免与模型能力失配）
    trained_set: set[str] = set()
    if TRAINED_JSON.exists():
        data = json.loads(TRAINED_JSON.read_text(encoding="utf-8"))
        trained_set = set(data.get("trained", []))
        print(f"Filtering to {len(trained_set)} trained species "
              f"(see {TRAINED_JSON}; others excluded)")
    else:
        print(f"WARNING: {TRAINED_JSON} not found; bundling all 1516 species")

    # 编译成索引结构：{ canonical_sci: {...} }，按 sci 直接 O(1) 查询
    index: dict[str, dict] = {}
    for r in rows:
        sci = r["canonical_sci"]
        if trained_set and sci not in trained_set:
            continue
        index[sci] = {
            "zh_title": r.get("zh_title"),
            "zh_extract": r.get("zh_extract"),
            "zh_url": r.get("zh_url"),
            "en_title": r.get("en_title"),
            "en_extract": r.get("en_extract"),
            "en_url": r.get("en_url"),
            "image_url": r.get("image_url"),
        }

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    # 紧凑输出（减小 bundle 体积，仍保持有效 JSON）
    OUTPUT.write_text(
        json.dumps(index, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    size_kb = OUTPUT.stat().st_size / 1024
    print(f"Wrote {len(index)} species to {OUTPUT} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
