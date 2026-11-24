"""Build split species catalog + lazy wiki body JSON from model taxonomy + Wikipedia cache.

The frontend imports the lightweight `species-catalog.json` eagerly for O(1)
taxonomy/name/alias lookup and lazy-loads `species-wiki-bodies.json` on demand
when viewing a species detail card or the Archive detail panel.
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
CATALOG_OUTPUT = Path("renderer/src/lib/species-catalog.json")
BODIES_OUTPUT = Path("renderer/src/lib/species-wiki-bodies.json")


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

    # 全部 canonical_extended 物种都进 bundle。v4 taxonomy 带 class_id，1591 类都可自动识别；
    # legacy v3 taxonomy 才回退到 species_list_1301.parquet 标注 trained mask。
    has_v4_class_id = bool(canonical_rows and "class_id" in canonical_rows[0])
    if has_v4_class_id:
        trained_set = {str(r["canonical_sci"]) for r in canonical_rows}
        china_listed_by_sci = {
            str(r["canonical_sci"]): str(r.get("scope") or "v12") != "extra"
            for r in canonical_rows
        }
        print(
            f"Tagging v4 trained species ({len(trained_set)} auto-recognisable) "
            f"out of {len(canonical_rows)} total"
        )
    elif TRAINED.exists():
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
        trained_set = set()
        china_listed_by_sci = {}
        print(f"WARNING: {TRAINED} not found; is_trained will default to false")

    # 拆分为两份 JSON：
    # 1. species-catalog.json：轻量分类元数据 + 别名 + 训练/名录标记（随主包同步加载）
    # 2. species-wiki-bodies.json：中/英维基正文与来源链接（按需 dynamic import 拆包）
    #    image_url 不再打入前端运行包（运行时离线图走 plumelens://species-artwork/）
    catalog: dict[str, dict] = {}
    bodies: dict[str, dict] = {}
    for canonical in canonical_rows:
        sci = canonical["canonical_sci"]
        wiki = wiki_rows.get(sci, {})
        catalog[sci] = {
            "canonical_zh": canonical.get("canonical_zh"),
            "canonical_en": canonical.get("canonical_en"),
            "family_sci": canonical.get("family_sci"),
            "family_zh": canonical.get("family_zh"),
            "order_sci": canonical.get("order_sci"),
            "iucn": canonical.get("iucn"),
            "protect_level": canonical.get("protect_level"),
            "zh_title": wiki.get("zh_title"),
            "en_title": wiki.get("en_title"),
            # True = 可被自动识别；False = 名录收录但训练样本不足，仅支持手动标注
            "is_trained": sci in trained_set,
            # False = 模型增补物种，不属于中国观鸟年报 v12.0 主名录。
            "in_china_v12": china_listed_by_sci.get(sci, True),
        }
        zh_extract = wiki.get("zh_extract")
        zh_url = wiki.get("zh_url")
        en_extract = wiki.get("en_extract")
        en_url = wiki.get("en_url")
        if zh_extract or zh_url or en_extract or en_url:
            bodies[sci] = {
                "zh_extract": zh_extract,
                "zh_url": zh_url,
                "en_extract": en_extract,
                "en_url": en_url,
            }

    CATALOG_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    # 紧凑输出（减小 bundle 体积，仍保持有效 JSON）
    CATALOG_OUTPUT.write_text(
        json.dumps(catalog, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    BODIES_OUTPUT.write_text(
        json.dumps(bodies, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    catalog_kb = CATALOG_OUTPUT.stat().st_size / 1024
    bodies_kb = BODIES_OUTPUT.stat().st_size / 1024
    print(f"Wrote {len(catalog)} species to {CATALOG_OUTPUT} ({catalog_kb:.1f} KB)")
    print(f"Wrote {len(bodies)} wiki bodies to {BODIES_OUTPUT} ({bodies_kb:.1f} KB)")


if __name__ == "__main__":
    main()
