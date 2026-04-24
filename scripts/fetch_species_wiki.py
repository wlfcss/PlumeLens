"""Crawl Wikipedia for bird species intros and save to engine/models/species_wiki.parquet.

- Uses MediaWiki action API with batched titles (up to 50 per request).
- 优先查询中文维基（按拉丁学名，再按中文名回退），再查英文维基（拉丁学名）。
- 追加式爬取：已有结果的 canonical_sci 自动跳过。
- 每批后立即落盘，崩溃可恢复。

Output schema (pyarrow Table → parquet):
    canonical_sci str         — 拉丁学名（主键，与 species_taxonomy.parquet 对齐）
    zh_title      str | null  — 匹配到的 zh.wiki 文章标题
    zh_extract    str | null  — 首段正文（plain text，去 wikitext）
    zh_url        str | null  — zh.wiki 文章 URL
    en_title      str | null
    en_extract    str | null
    en_url        str | null
    image_url     str | null  — 缩略图（优先 zh，回退 en）
    updated_at    str         — ISO UTC 时间戳

Usage:
    uv run python scripts/fetch_species_wiki.py              # 全量爬取
    uv run python scripts/fetch_species_wiki.py --limit 50   # 小批量测试
    uv run python scripts/fetch_species_wiki.py --resume     # 从上次中断处继续（默认就是）

Wikipedia policy:
    User-Agent 显式标识项目来源（meta.wikimedia.org/wiki/User-Agent_policy）。
    批量请求 + 0.5s sleep 足够温和；50 titles × 0.5s ≈ 15-20 秒跑完 1500 种。
"""
from __future__ import annotations

import argparse
import sys
import time
import urllib.parse
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq
import requests

TAXONOMY_PATH = Path("engine/models/species_taxonomy.parquet")
OUTPUT_PATH = Path("engine/models/species_wiki.parquet")

USER_AGENT = (
    "PlumeLens/0.1 (https://github.com/wlfcss/PlumeLens; "
    "bird photo curation desktop app)"
)
BATCH_SIZE = 20  # MediaWiki exlimit=max 对非 bot 账号上限是 20
SLEEP_BETWEEN_BATCHES = 0.5  # 秒
REQUEST_TIMEOUT = 15

_SCHEMA = pa.schema(
    [
        pa.field("canonical_sci", pa.string()),
        pa.field("zh_title", pa.string()),
        pa.field("zh_extract", pa.string()),
        pa.field("zh_url", pa.string()),
        pa.field("en_title", pa.string()),
        pa.field("en_extract", pa.string()),
        pa.field("en_url", pa.string()),
        pa.field("image_url", pa.string()),
        pa.field("updated_at", pa.string()),
    ],
)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": USER_AGENT})
    return s


def _load_taxonomy() -> list[dict[str, Any]]:
    table = pq.read_table(TAXONOMY_PATH)
    return table.to_pylist()


def _load_existing() -> dict[str, dict[str, Any]]:
    if not OUTPUT_PATH.exists():
        return {}
    table = pq.read_table(OUTPUT_PATH)
    return {row["canonical_sci"]: row for row in table.to_pylist()}


def _save_results(results: list[dict[str, Any]]) -> None:
    """Atomic parquet write (write to tmp, then rename)."""
    # Normalize: 确保所有字段存在（缺省填 None）
    cols = [f.name for f in _SCHEMA]
    normalized = [{k: row.get(k) for k in cols} for row in results]
    table = pa.Table.from_pylist(normalized, schema=_SCHEMA)
    tmp = OUTPUT_PATH.with_suffix(".parquet.tmp")
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, tmp)
    tmp.replace(OUTPUT_PATH)


def _mediawiki_query(
    session: requests.Session,
    lang: str,
    titles: list[str],
) -> dict[str, dict[str, Any]]:
    """Query the MediaWiki API for a batch of titles; return title -> page dict.

    Handles redirects + normalization transparently. Missing pages are omitted
    from the returned dict.
    """
    if not titles:
        return {}

    url = f"https://{lang}.wikipedia.org/w/api.php"
    params = {
        "action": "query",
        "format": "json",
        "formatversion": "2",
        "prop": "extracts|pageimages|info",
        # MediaWiki API 默认 exlimit=1，批量 titles 只返回第一个 extract；必须 "max"
        "exlimit": "max",
        "exintro": "1",
        "explaintext": "1",
        "redirects": "1",
        "piprop": "thumbnail",
        "pithumbsize": "400",
        "inprop": "url",
        "titles": "|".join(titles),
    }
    resp = session.get(url, params=params, timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    data = resp.json()

    # Build input → final-title mapping
    query = data.get("query", {})
    resolved: dict[str, str] = {}  # input title → final title
    for n in query.get("normalized", []):
        resolved[n["from"]] = n["to"]
    for r in query.get("redirects", []):
        src = r["from"]
        # Apply normalization first
        if src in resolved:
            pass
        resolved[src] = r["to"]
        # Chain: if original title was normalized then redirected
        for k, v in list(resolved.items()):
            if v == src:
                resolved[k] = r["to"]

    pages = query.get("pages", [])
    # Index by title
    by_title: dict[str, dict[str, Any]] = {}
    for p in pages:
        if p.get("missing"):
            continue
        t = p.get("title")
        if t:
            by_title[t] = p

    # Resolve each input title via normalized+redirects chain
    out: dict[str, dict[str, Any]] = {}
    for t in titles:
        final = resolved.get(t, t)
        # Multi-step chain
        seen = {t}
        while final in resolved and final not in seen:
            seen.add(final)
            final = resolved[final]
        page = by_title.get(final)
        if page is not None:
            out[t] = page
    return out


def _page_url(lang: str, page: dict[str, Any]) -> str | None:
    # formatversion=2 with prop=info&inprop=url returns `fullurl`
    if "fullurl" in page:
        return page["fullurl"]
    title = page.get("title")
    if title is None:
        return None
    encoded = urllib.parse.quote(title.replace(" ", "_"))
    return f"https://{lang}.wikipedia.org/wiki/{encoded}"


def _page_thumbnail(page: dict[str, Any]) -> str | None:
    thumb = page.get("thumbnail")
    if isinstance(thumb, dict):
        return thumb.get("source")
    return None


def _collect_batch(
    session: requests.Session,
    batch: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Fetch zh + en Wikipedia data for one batch of species."""
    now = _now_iso()

    # zh: first try scientific name, for those that miss, fall back to Chinese name
    zh_titles_sci = [r["canonical_sci"] for r in batch]
    zh_data_by_sci = _mediawiki_query(session, "zh", zh_titles_sci)

    # Build fallback (Chinese common name) for species that didn't hit via sci name
    zh_titles_cn = []
    zh_cn_to_species: dict[str, dict[str, Any]] = {}
    for r in batch:
        if r["canonical_sci"] in zh_data_by_sci:
            continue
        cn = r.get("canonical_zh")
        if cn:
            zh_titles_cn.append(cn)
            zh_cn_to_species[cn] = r

    time.sleep(SLEEP_BETWEEN_BATCHES)
    zh_data_by_cn = _mediawiki_query(session, "zh", zh_titles_cn)

    # en: scientific name (Wikipedia en conventions use sci name with space or underscore)
    en_titles = [r["canonical_sci"] for r in batch]
    time.sleep(SLEEP_BETWEEN_BATCHES)
    en_data = _mediawiki_query(session, "en", en_titles)

    results: list[dict[str, Any]] = []
    for r in batch:
        sci = r["canonical_sci"]
        zh_page = zh_data_by_sci.get(sci)
        if zh_page is None:
            cn = r.get("canonical_zh")
            if cn and cn in zh_data_by_cn:
                zh_page = zh_data_by_cn[cn]

        en_page = en_data.get(sci)

        image_url = None
        if zh_page:
            image_url = _page_thumbnail(zh_page)
        if not image_url and en_page:
            image_url = _page_thumbnail(en_page)

        results.append(
            {
                "canonical_sci": sci,
                "zh_title": (zh_page.get("title") if zh_page else None),
                "zh_extract": (zh_page.get("extract") if zh_page else None),
                "zh_url": _page_url("zh", zh_page) if zh_page else None,
                "en_title": (en_page.get("title") if en_page else None),
                "en_extract": (en_page.get("extract") if en_page else None),
                "en_url": _page_url("en", en_page) if en_page else None,
                "image_url": image_url,
                "updated_at": now,
            },
        )
    return results


def _chunk(items: list[Any], size: int) -> list[list[Any]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--limit", type=int, default=None,
        help="Cap number of species to process (for testing)",
    )
    parser.add_argument(
        "--force", action="store_true",
        help="Re-crawl even if already in output",
    )
    args = parser.parse_args()

    if not TAXONOMY_PATH.exists():
        print(f"Taxonomy not found: {TAXONOMY_PATH}", file=sys.stderr)
        sys.exit(1)

    taxonomy = _load_taxonomy()
    existing = {} if args.force else _load_existing()

    # Species to process
    pending = [r for r in taxonomy if r["canonical_sci"] not in existing]
    if args.limit is not None:
        pending = pending[: args.limit]

    print(
        f"Taxonomy: {len(taxonomy)} species; "
        f"existing: {len(existing)}; pending: {len(pending)}",
    )
    if not pending:
        print("Nothing to do.")
        return

    session = _session()
    all_results: list[dict[str, Any]] = list(existing.values())
    batches = _chunk(pending, BATCH_SIZE)

    for i, batch in enumerate(batches, 1):
        t0 = time.time()
        try:
            batch_results = _collect_batch(session, batch)
        except requests.RequestException as e:
            print(f"  batch {i}/{len(batches)} failed: {e}", file=sys.stderr)
            continue
        all_results.extend(batch_results)

        # 增量落盘
        _save_results(all_results)

        zh_hits = sum(1 for r in batch_results if r["zh_extract"])
        en_hits = sum(1 for r in batch_results if r["en_extract"])
        print(
            f"  batch {i}/{len(batches)}: {len(batch_results)} rows "
            f"(zh: {zh_hits}, en: {en_hits}) in {time.time()-t0:.1f}s",
        )
        time.sleep(SLEEP_BETWEEN_BATCHES)

    total = len(all_results)
    zh_total = sum(1 for r in all_results if r["zh_extract"])
    en_total = sum(1 for r in all_results if r["en_extract"])
    print(
        f"\nDone. Total: {total}  zh hits: {zh_total}  en hits: {en_total}  "
        f"→ {OUTPUT_PATH} ({OUTPUT_PATH.stat().st_size / 1024:.1f} KB)",
    )


if __name__ == "__main__":
    main()
