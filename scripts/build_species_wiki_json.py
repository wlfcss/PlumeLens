"""Build renderer/src/lib/species-wiki.json from model taxonomy + Wikipedia cache.

The frontend imports this JSON directly (no HTTP call, no backend dependency).
Run this whenever species_wiki.parquet is regenerated.

Usage:
    uv run python scripts/build_species_wiki_json.py
"""

from __future__ import annotations

from pathlib import Path

import pyarrow.parquet as pq

SOURCE = Path("engine/models/species_wiki.parquet")
CANONICAL = Path("engine/models/species/canonical_extended.parquet")
TRAINED = Path("engine/models/species/species_list_1301.parquet")
OUTPUT = Path("renderer/src/lib/species-wiki.json")


def _as_bool(value: object, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "y"}


def main() -> None:
    import json

    if not SOURCE.exists():
        raise SystemExit(f"Missing {SOURCE} — run scripts/fetch_species_wiki.py first")
    if not CANONICAL.exists():
        raise SystemExit(f"Missing {CANONICAL}")

    wiki_rows = {
        r["canonical_sci"]: r for r in pq.read_table(SOURCE).to_pylist() if r.get("canonical_sci")
    }
    canonical_rows = [r for r in pq.read_table(CANONICAL).to_pylist() if r.get("canonical_sci")]
    canonical_rows.sort(key=lambda r: r["canonical_sci"])

    # 全部 canonical_extended 物种都进 bundle；is_trained 用 v3 训练输出表标注。
    trained_set: set[str] = set()
    china_listed_by_sci: dict[str, bool] = {}
    if TRAINED.exists():
        trained_rows = pq.read_table(TRAINED).to_pylist()
        trained_set = {r["canonical_sci"] for r in trained_rows if r.get("canonical_sci")}
        china_listed_by_sci = {
            r["canonical_sci"]: _as_bool(r.get("in_china_v12"), default=True)
            for r in trained_rows
            if r.get("canonical_sci")
        }
        print(
            f"Tagging trained species ({len(trained_set)} auto-recognisable) "
            f"out of {len(canonical_rows)} total (manual tagging covers all)"
        )
    else:
        print(f"WARNING: {TRAINED} not found; is_trained will default to false")

    # 编译成索引结构：{ canonical_sci: {...} }，按 sci 直接 O(1) 查询
    index: dict[str, dict] = {}
    for canonical in canonical_rows:
        sci = canonical["canonical_sci"]
        wiki = wiki_rows.get(sci, {})
        index[sci] = {
            "canonical_zh": canonical.get("canonical_zh"),
            "canonical_en": canonical.get("canonical_en"),
            "family_sci": canonical.get("family_sci"),
            "family_zh": canonical.get("family_zh"),
            "order_sci": canonical.get("order_sci"),
            "iucn": canonical.get("iucn"),
            "protect_level": canonical.get("protect_level"),
            "zh_title": wiki.get("zh_title"),
            "zh_extract": wiki.get("zh_extract"),
            "zh_url": wiki.get("zh_url"),
            "en_title": wiki.get("en_title"),
            "en_extract": wiki.get("en_extract"),
            "en_url": wiki.get("en_url"),
            "image_url": wiki.get("image_url"),
            # True = 可被自动识别；False = 名录收录但训练样本不足，仅支持手动标注
            "is_trained": sci in trained_set,
            # False = 1301 识别清单里的模型增补物种，不属于中国观鸟年报 v12.0 主名录。
            "in_china_v12": china_listed_by_sci.get(sci, True),
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
