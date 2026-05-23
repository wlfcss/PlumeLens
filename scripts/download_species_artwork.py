"""Download packaged species artwork referenced by renderer/src/lib/species-wiki.json.

The runtime app never fetches Wikimedia images. It serves files from
resources/species-artwork via the plumelens://species-artwork protocol.

Usage:
    uv run --project engine python scripts/download_species_artwork.py
    uv run --project engine python scripts/download_species_artwork.py --force
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import urllib.parse
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

SOURCE_JSON = Path("renderer/src/lib/species-wiki.json")
OUTPUT_DIR = Path("resources/species-artwork")
MANIFEST_PATH = OUTPUT_DIR / "manifest.json"

MAX_IMAGE_BYTES = 8 * 1024 * 1024
DEFAULT_DELAY_SECONDS = 1.0
DEFAULT_RETRIES = 4
USER_AGENT = "PlumeLens/0.7.5 (https://github.com/wlfcss/PlumeLens; packaged species artwork)"
VALID_EXTENSIONS = (".jpg", ".png", ".webp")
PRESERVED_ITEM_FIELDS = (
    "optimized",
    "commons_title",
    "commons_page_url",
    "license",
    "license_url",
    "artist",
    "credit",
    "attribution_required",
    "copyrighted",
    "attribution_status",
)
PRESERVED_WEBP_MANIFEST_FIELDS = (
    "artwork_format",
    "optimized_at",
    "webp_quality",
    "attribution_generated_at",
    "attribution_count",
    "attribution_missing_count",
)
EXT_BY_MIME = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}


def species_artwork_key(name: str) -> str:
    key = re.sub(r"[^a-zA-Z0-9]+", "_", name.strip()).strip("_").lower()
    if not key:
        raise ValueError(f"Invalid species key: {name!r}")
    return key


def normalize_source_url(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    parsed = urllib.parse.urlparse(value.strip())
    if parsed.scheme != "https":
        return None
    if parsed.hostname != "upload.wikimedia.org":
        return None
    if parsed.username or parsed.password:
        return None
    return urllib.parse.urlunparse(parsed._replace(fragment=""))


def extension_from_url(source: str) -> str | None:
    suffix = Path(urllib.parse.urlparse(source).path).suffix.lower()
    if suffix == ".jpeg":
        return ".jpg"
    return suffix if suffix in VALID_EXTENSIONS else None


def extension_from_response(response: httpx.Response, source: str) -> str | None:
    content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    return (
        EXT_BY_MIME.get(content_type)
        or extension_from_url(str(response.url))
        or extension_from_url(source)
    )


def existing_artwork_file(key: str) -> Path | None:
    for ext in VALID_EXTENSIONS:
        candidate = OUTPUT_DIR / f"{key}{ext}"
        if candidate.exists():
            return candidate
    return None


def load_existing_manifest() -> dict[str, Any]:
    if not MANIFEST_PATH.exists():
        return {}
    try:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return manifest if isinstance(manifest, dict) else {}


def merge_preserved_manifest_fields(
    results: list[dict[str, Any]],
    existing_manifest: dict[str, Any],
) -> None:
    existing_items = existing_manifest.get("items")
    if not isinstance(existing_items, list):
        return
    existing_by_key = {
        item.get("key"): item
        for item in existing_items
        if isinstance(item, dict) and item.get("key")
    }
    for result in results:
        existing = existing_by_key.get(result.get("key"))
        if not isinstance(existing, dict):
            continue
        if existing.get("source_url") != result.get("source_url"):
            continue
        for field in PRESERVED_ITEM_FIELDS:
            if field in existing and field not in result:
                result[field] = existing[field]


async def download_one(
    client: httpx.AsyncClient,
    sci: str,
    source: str,
    force: bool,
    retries: int,
) -> dict[str, Any]:
    key = species_artwork_key(sci)
    existing = existing_artwork_file(key)
    if existing and not force:
        return {
            "canonical_sci": sci,
            "key": key,
            "file": existing.name,
            "source_url": source,
            "status": "cached",
        }

    for attempt in range(retries + 1):
        try:
            response = await client.get(source, follow_redirects=True)
            response.raise_for_status()
            break
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code != 429 or attempt >= retries:
                raise
            retry_after = exc.response.headers.get("retry-after")
            wait_seconds = float(retry_after) if retry_after and retry_after.isdigit() else 30.0
            wait_seconds = min(wait_seconds * (attempt + 1), 180.0)
            print(
                f"429 for {sci}; waiting {wait_seconds:.0f}s "
                f"before retry {attempt + 1}/{retries}",
                flush=True,
            )
            await asyncio.sleep(wait_seconds)
    else:
        raise RuntimeError("unreachable retry state")

    content_length = int(response.headers.get("content-length") or 0)
    if content_length > MAX_IMAGE_BYTES:
        raise ValueError(f"image too large by content-length: {content_length}")
    payload = response.content
    if not payload or len(payload) > MAX_IMAGE_BYTES:
        raise ValueError(f"invalid image size: {len(payload)}")
    ext = extension_from_response(response, source)
    if ext is None:
        raise ValueError(
            f"unsupported content-type: {response.headers.get('content-type', 'unknown')}"
        )

    for stale_ext in VALID_EXTENSIONS:
        stale = OUTPUT_DIR / f"{key}{stale_ext}"
        if stale.exists() and stale.suffix != ext:
            stale.unlink()
    target = OUTPUT_DIR / f"{key}{ext}"
    tmp = OUTPUT_DIR / f"{key}{ext}.tmp"
    tmp.write_bytes(payload)
    tmp.replace(target)
    return {
        "canonical_sci": sci,
        "key": key,
        "file": target.name,
        "source_url": source,
        "status": "downloaded",
        "bytes": len(payload),
    }


def load_rows(limit: int | None) -> list[tuple[str, str]]:
    if not SOURCE_JSON.exists():
        raise SystemExit(f"Missing {SOURCE_JSON}")

    raw_index = json.loads(SOURCE_JSON.read_text(encoding="utf-8"))
    rows: list[tuple[str, str]] = []
    seen_keys: dict[str, str] = {}
    for sci, item in sorted(raw_index.items()):
        key = species_artwork_key(sci)
        owner = seen_keys.get(key)
        if owner and owner != sci:
            raise SystemExit(f"Artwork key collision: {owner!r} and {sci!r} -> {key!r}")
        seen_keys[key] = sci
        source = normalize_source_url(item.get("image_url"))
        if source:
            rows.append((sci, source))

    if limit is not None:
        rows = rows[:limit]
    return rows


async def download_rows(
    rows: list[tuple[str, str]],
    delay: float,
    force: bool,
    retries: int,
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    timeout = httpx.Timeout(30.0, connect=10.0)
    headers = {
        "Accept": "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8",
        "User-Agent": USER_AGENT,
    }

    results: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    async with httpx.AsyncClient(headers=headers, timeout=timeout) as client:
        for index, (sci, source) in enumerate(rows, start=1):
            requested_remote = False
            try:
                result = await download_one(client, sci, source, force, retries)
                requested_remote = result.get("status") != "cached"
                results.append(result)
                if index % 25 == 0 or index == len(rows):
                    print(f"{index}/{len(rows)} artwork files processed", flush=True)
            except Exception as exc:
                requested_remote = True
                failures.append(
                    {
                        "canonical_sci": sci,
                        "source_url": source,
                        "error": str(exc),
                    }
                )
                print(f"FAILED {index}/{len(rows)} {sci}: {exc}", flush=True)
            if requested_remote and delay > 0 and index < len(rows):
                await asyncio.sleep(delay)
    return results, failures


def write_manifest(results: list[dict[str, Any]], failures: list[dict[str, str]]) -> None:
    existing_manifest = load_existing_manifest()
    merge_preserved_manifest_fields(results, existing_manifest)
    results.sort(key=lambda item: item["canonical_sci"])
    manifest = {
        "version": 1,
        "generated_at": datetime.now(UTC).isoformat(),
        "source_json": str(SOURCE_JSON),
        "count": len(results),
        "failed_count": len(failures),
        "items": results,
        "failures": failures,
    }
    if results and all(str(item.get("file", "")).endswith(".webp") for item in results):
        for field in PRESERVED_WEBP_MANIFEST_FIELDS:
            if field in existing_manifest:
                manifest[field] = existing_manifest[field]
    MANIFEST_PATH.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    print(
        f"Wrote {len(results)} artwork files to {OUTPUT_DIR} "
        f"({len(failures)} failures, manifest: {MANIFEST_PATH})",
        flush=True,
    )
    if failures:
        raise SystemExit(1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--delay", type=float, default=DEFAULT_DELAY_SECONDS)
    parser.add_argument("--retries", type=int, default=DEFAULT_RETRIES)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    rows = load_rows(args.limit)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    results, failures = asyncio.run(
        download_rows(rows=rows, delay=args.delay, force=args.force, retries=args.retries)
    )
    write_manifest(results, failures)


if __name__ == "__main__":
    main()
