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
    image_url     str | null  — 缩略图（优先摄影图，避免版画/标本/分布图）
    updated_at    str         — ISO UTC 时间戳

Usage:
    uv run python scripts/fetch_species_wiki.py              # 全量爬取
    uv run python scripts/fetch_species_wiki.py --limit 50   # 小批量测试
    uv run python scripts/fetch_species_wiki.py --force      # 全量重爬
    uv run python scripts/fetch_species_wiki.py --repair-images  # 修复旧缓存的非摄影封面

Wikipedia policy:
    User-Agent 显式标识项目来源（meta.wikimedia.org/wiki/User-Agent_policy）。
    批量请求 + sleep 控制速率；仅当页面封面疑似非摄影图时查询 Commons 候选照片。
"""
from __future__ import annotations

import argparse
import re
import sys
import time
import urllib.parse
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pyarrow as pa
import pyarrow.parquet as pq

TAXONOMY_PATH = Path("engine/models/species/canonical_extended.parquet")
OUTPUT_PATH = Path("engine/models/species_wiki.parquet")
COMMONS_API_URL = "https://commons.wikimedia.org/w/api.php"

USER_AGENT = (
    "PlumeLens/0.1 (https://github.com/wlfcss/PlumeLens; "
    "bird photo curation desktop app)"
)
BATCH_SIZE = 20  # MediaWiki exlimit=max 对非 bot 账号上限是 20
SLEEP_BETWEEN_BATCHES = 0.5  # 秒
REQUEST_TIMEOUT = 15
PHOTO_THUMB_SIZE = 500

_BITMAP_EXT_RE = re.compile(r"\.(?:jpe?g|png|webp)(?:[/?#]|$)", re.I)
_PLATE_RE = re.compile(r"(?:^|[_\-\s(])plate(?:[_\-\s).]|$)", re.I)
_GOULD_PLATE_RE = re.compile(
    r"(?:john[_\-\s.]*gould|by[_\-\s.]*gould|[a-z]gould\.(?:jpe?g|png))",
    re.I,
)
_BAD_IMAGE_TOKENS = (
    ".svg",
    "keulemans",
    "hartert",
    "illustration",
    "illustrated",
    "lithograph",
    "monograph",
    "protolog",
    "biodiversity_heritage_library",
    "biodiversity heritage library",
    "hbw",
    "specimen",
    "museum",
    "bird_skin",
    "skeleton",
    "taxidermy",
    "stamp",
    "range_map",
    "range map",
    "distribution_map",
    "distribution map",
    "plos",
)
_GOOD_IMAGE_TOKENS = (
    "photo",
    "photograph",
    "wildlife",
    "bird",
    "birds",
    "dsc",
    "img",
    "cropped",
    "flickr",
    "india",
    "china",
)

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


def _session() -> httpx.Client:
    return httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=REQUEST_TIMEOUT)


def _load_taxonomy() -> list[dict[str, Any]]:
    table = pq.read_table(TAXONOMY_PATH)
    rows = table.to_pylist()
    return [r for r in rows if r.get("canonical_sci")]


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
    session: httpx.Client,
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
        "pithumbsize": str(PHOTO_THUMB_SIZE),
        "inprop": "url",
        "titles": "|".join(titles),
    }
    resp = session.get(url, params=params)
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


def _image_text(*parts: str | None) -> str:
    text = " ".join(p for p in parts if p)
    return urllib.parse.unquote(text).replace("-", "_").lower()


def _is_obvious_non_photo_image(url: str | None, title: str | None = None) -> bool:
    text = _image_text(title, url)
    if not text:
        return False
    return (
        any(token in text for token in _BAD_IMAGE_TOKENS)
        or bool(_PLATE_RE.search(text))
        or bool(_GOULD_PLATE_RE.search(text))
    )


def _image_score(
    *,
    title: str | None,
    url: str | None,
    mime: str | None,
    search_index: int = 100,
    sci: str | None = None,
    common_en: str | None = None,
) -> int:
    if not url:
        return -10_000

    text = _image_text(title, url)
    if _is_obvious_non_photo_image(url, title):
        return -10_000
    if mime and not mime.startswith("image/"):
        return -10_000
    if mime == "image/svg+xml":
        return -10_000
    if not _BITMAP_EXT_RE.search(text):
        return -10_000

    score = 100 - min(search_index, 100)
    if mime == "image/jpeg":
        score += 35
    elif mime in {"image/png", "image/webp"}:
        score += 15

    if sci and sci.lower() in text:
        score += 25
    if common_en:
        common_words = [w for w in re.split(r"[^a-z0-9]+", common_en.lower()) if len(w) >= 4]
        score += min(sum(6 for w in common_words if w in text), 24)

    score += min(sum(4 for token in _GOOD_IMAGE_TOKENS if token in text), 20)
    return score


def _commons_image_candidates(
    session: httpx.Client,
    query: str,
) -> list[dict[str, Any]]:
    params = {
        "action": "query",
        "format": "json",
        "formatversion": "2",
        "generator": "search",
        "gsrsearch": query,
        "gsrnamespace": "6",
        "gsrlimit": "20",
        "prop": "imageinfo",
        "iiprop": "url|mime|size",
        "iiurlwidth": str(PHOTO_THUMB_SIZE),
    }
    resp = session.get(COMMONS_API_URL, params=params)
    resp.raise_for_status()
    return resp.json().get("query", {}).get("pages", [])


def _commons_search_photo(
    session: httpx.Client,
    *,
    sci: str,
    common_en: str | None = None,
    common_zh: str | None = None,
) -> str | None:
    queries = [f'"{sci}" filetype:bitmap']
    if common_en:
        queries.append(f'"{common_en}" filetype:bitmap')
    if common_zh:
        queries.append(f'"{common_zh}" filetype:bitmap')

    seen_urls: set[str] = set()
    best_score = -10_000
    best_url: str | None = None
    for query in queries:
        pages = _commons_image_candidates(session, query)
        for page in pages:
            title = page.get("title")
            imageinfo = page.get("imageinfo") or []
            if not imageinfo:
                continue
            info = imageinfo[0]
            url = info.get("thumburl") or info.get("url")
            if not url or url in seen_urls:
                continue
            seen_urls.add(url)
            score = _image_score(
                title=title,
                url=url,
                mime=info.get("mime"),
                search_index=int(page.get("index") or 100),
                sci=sci,
                common_en=common_en,
            )
            if score > best_score:
                best_score = score
                best_url = url
        if best_score >= 120:
            break
        time.sleep(0.2)

    return best_url if best_score > 0 else None


def _select_photo_image_url(
    session: httpx.Client,
    species: dict[str, Any],
    zh_page: dict[str, Any] | None,
    en_page: dict[str, Any] | None,
) -> str | None:
    sci = species["canonical_sci"]
    common_en = species.get("canonical_en")
    common_zh = species.get("canonical_zh")
    page_candidates = [
        ("zh", _page_thumbnail(zh_page) if zh_page else None),
        ("en", _page_thumbnail(en_page) if en_page else None),
    ]

    scored = [
        (
            _image_score(
                title=source,
                url=url,
                mime=None,
                search_index=0 if source == "zh" else 5,
                sci=sci,
                common_en=common_en,
            ),
            url,
        )
        for source, url in page_candidates
        if url
    ]
    if scored:
        score, url = max(scored, key=lambda item: item[0])
        if score > 0 and url and not _is_obvious_non_photo_image(url):
            return url

    return _commons_search_photo(
        session,
        sci=sci,
        common_en=common_en,
        common_zh=common_zh,
    )


def _collect_batch(
    session: httpx.Client,
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

        image_url = _select_photo_image_url(session, r, zh_page, en_page)

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


def _repair_non_photo_images(
    session: httpx.Client,
    taxonomy: list[dict[str, Any]],
    existing: dict[str, dict[str, Any]],
    *,
    limit: int | None,
) -> None:
    taxonomy_by_sci = {r["canonical_sci"]: r for r in taxonomy if r.get("canonical_sci")}
    pending = [
        taxonomy_by_sci[sci]
        for sci, row in existing.items()
        if sci in taxonomy_by_sci and _is_obvious_non_photo_image(row.get("image_url"))
    ]
    if limit is not None:
        pending = pending[:limit]

    print(f"Repairing likely non-photo images: {len(pending)}")
    if not pending:
        return

    repaired = 0
    cleared = 0
    for i, species in enumerate(pending, 1):
        sci = species["canonical_sci"]
        row = dict(existing[sci])
        old_url = row.get("image_url")
        new_url = _commons_search_photo(
            session,
            sci=sci,
            common_en=species.get("canonical_en"),
            common_zh=species.get("canonical_zh"),
        )
        if new_url and new_url != old_url:
            row["image_url"] = new_url
            repaired += 1
        elif not new_url:
            row["image_url"] = None
            cleared += 1
        row["updated_at"] = _now_iso()
        existing[sci] = row

        if i % 10 == 0 or i == len(pending):
            _save_results(list(existing.values()))
        print(
            f"  {i}/{len(pending)} {sci}: "
            f"{'repaired' if new_url else 'cleared'}",
        )
        time.sleep(0.2)

    _save_results(list(existing.values()))
    print(f"Done. repaired: {repaired}; cleared: {cleared}")


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
    parser.add_argument(
        "--repair-images", action="store_true",
        help="Replace obvious illustration/specimen thumbnails with Wikimedia Commons photos",
    )
    args = parser.parse_args()

    if not TAXONOMY_PATH.exists():
        print(f"Taxonomy not found: {TAXONOMY_PATH}", file=sys.stderr)
        sys.exit(1)

    taxonomy = _load_taxonomy()
    existing = {} if args.force else _load_existing()

    with _session() as session:
        if args.repair_images:
            if not existing:
                print("No existing wiki cache to repair.", file=sys.stderr)
                sys.exit(1)
            _repair_non_photo_images(session, taxonomy, existing, limit=args.limit)
            return

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

        all_results: list[dict[str, Any]] = list(existing.values())
        batches = _chunk(pending, BATCH_SIZE)

        for i, batch in enumerate(batches, 1):
            t0 = time.time()
            try:
                batch_results = _collect_batch(session, batch)
            except httpx.HTTPError as e:
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
