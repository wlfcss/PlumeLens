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
OUTPUT = Path("renderer/src/lib/species-wiki.json")


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"Missing {SOURCE} — run scripts/fetch_species_wiki.py first")

    rows = pq.read_table(SOURCE).to_pylist()
    # 按 canonical_sci 排序，输出结构稳定（便于 diff）
    rows.sort(key=lambda r: r["canonical_sci"])

    # 编译成索引结构：{ canonical_sci: {...} }，按 sci 直接 O(1) 查询
    index: dict[str, dict] = {}
    for r in rows:
        sci = r["canonical_sci"]
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
