"""Generate attribution metadata for packaged species artwork.

The app ships Wikimedia Commons-derived artwork for offline use. This script
resolves each manifest source URL back to its Commons file page, fetches
license/artist metadata through the MediaWiki API, updates the artwork manifest,
and writes a human-readable third-party attribution notice.
"""

from __future__ import annotations

import argparse
import json
import re
import time
import urllib.parse
from datetime import UTC, datetime
from html import unescape
from pathlib import Path
from typing import Any

import httpx

OUTPUT_DIR = Path("resources/species-artwork")
MANIFEST_PATH = OUTPUT_DIR / "manifest.json"
NOTICE_PATH = OUTPUT_DIR / "THIRD_PARTY_ATTRIBUTIONS.md"

COMMONS_API_URL = "https://commons.wikimedia.org/w/api.php"
USER_AGENT = "PlumeLens/0.7.5 (https://github.com/wlfcss/PlumeLens; artwork attribution audit)"
DEFAULT_DELAY_SECONDS = 1.0
DEFAULT_BATCH_SIZE = 50
REQUEST_TIMEOUT = 20.0


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def strip_html(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    text = unescape(re.sub(r"<[^>]+>", " ", value))
    text = re.sub(r"\s+", " ", text).strip()
    return text or None


def metadata_value(metadata: dict[str, Any], key: str) -> str | None:
    raw = metadata.get(key)
    if not isinstance(raw, dict):
        return None
    return strip_html(raw.get("value"))


def commons_file_title(source_url: object) -> str | None:
    if not isinstance(source_url, str) or not source_url.strip():
        return None
    parsed = urllib.parse.urlparse(source_url)
    if parsed.scheme != "https" or parsed.hostname != "upload.wikimedia.org":
        return None
    parts = [urllib.parse.unquote(part) for part in parsed.path.split("/") if part]
    if not parts:
        return None
    filename = parts[-2] if "thumb" in parts and len(parts) >= 2 else parts[-1]
    if not filename:
        return None
    return filename if filename.startswith("File:") else f"File:{filename}"


def commons_file_page_url(title: str | None) -> str | None:
    if not title:
        return None
    encoded = urllib.parse.quote(title.replace(" ", "_"), safe=":")
    return f"https://commons.wikimedia.org/wiki/{encoded}"


def title_key(title: str | None) -> str:
    return (title or "").replace("_", " ").casefold()


def chunks(items: list[str], size: int) -> list[list[str]]:
    return [items[index : index + size] for index in range(0, len(items), size)]


def load_manifest() -> dict[str, Any]:
    if not MANIFEST_PATH.exists():
        raise SystemExit(f"Missing {MANIFEST_PATH}; run scripts/download_species_artwork.py first")
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise SystemExit(f"Invalid manifest: {MANIFEST_PATH}")
    return manifest


def fetch_commons_metadata(
    titles: list[str],
    batch_size: int,
    delay: float,
) -> dict[str, dict[str, Any]]:
    metadata_by_title: dict[str, dict[str, Any]] = {}
    headers = {"User-Agent": USER_AGENT}
    timeout = httpx.Timeout(REQUEST_TIMEOUT, connect=10.0)
    with httpx.Client(headers=headers, timeout=timeout) as client:
        for index, batch in enumerate(chunks(titles, batch_size), start=1):
            response = client.get(
                COMMONS_API_URL,
                params={
                    "action": "query",
                    "format": "json",
                    "formatversion": "2",
                    "prop": "imageinfo",
                    "iiprop": "extmetadata|url",
                    "titles": "|".join(batch),
                },
            )
            response.raise_for_status()
            pages = response.json().get("query", {}).get("pages", [])
            if not isinstance(pages, list):
                continue
            for page in pages:
                if not isinstance(page, dict) or page.get("missing"):
                    continue
                imageinfo = page.get("imageinfo")
                if not isinstance(imageinfo, list) or not imageinfo:
                    continue
                info = imageinfo[0]
                if not isinstance(info, dict):
                    continue
                extmetadata = info.get("extmetadata")
                if not isinstance(extmetadata, dict):
                    extmetadata = {}
                title = str(page.get("title") or "")
                metadata_by_title[title_key(title)] = {
                    "commons_title": title,
                    "commons_page_url": info.get("descriptionurl")
                    or commons_file_page_url(title),
                    "license": metadata_value(extmetadata, "LicenseShortName")
                    or metadata_value(extmetadata, "UsageTerms"),
                    "license_url": metadata_value(extmetadata, "LicenseUrl"),
                    "artist": metadata_value(extmetadata, "Artist")
                    or metadata_value(extmetadata, "Credit")
                    or metadata_value(extmetadata, "Attribution"),
                    "credit": metadata_value(extmetadata, "Credit"),
                    "attribution_required": metadata_value(extmetadata, "AttributionRequired"),
                    "copyrighted": metadata_value(extmetadata, "Copyrighted"),
                    "attribution_status": "resolved",
                }
            if delay > 0 and index * batch_size < len(titles):
                time.sleep(delay)
    return metadata_by_title


def enrich_manifest(
    manifest: dict[str, Any],
    metadata_by_title: dict[str, dict[str, Any]],
) -> tuple[int, int]:
    items = manifest.get("items")
    if not isinstance(items, list):
        raise SystemExit(f"Invalid manifest items in {MANIFEST_PATH}")
    resolved = 0
    missing = 0
    for item in items:
        if not isinstance(item, dict):
            continue
        title = commons_file_title(item.get("source_url"))
        item["commons_title"] = title
        item["commons_page_url"] = commons_file_page_url(title)
        metadata = metadata_by_title.get(title_key(title))
        if not metadata and item.get("attribution_status") == "resolved":
            metadata = {
                key: item.get(key)
                for key in (
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
                if item.get(key)
            }
        if metadata and not metadata.get("artist"):
            metadata["artist"] = metadata.get("credit") or "unknown artist"
        if metadata:
            item.update(metadata)
            resolved += 1
        else:
            item["attribution_status"] = "missing"
            missing += 1
    manifest["attribution_generated_at"] = now_iso()
    manifest["attribution_count"] = resolved
    manifest["attribution_missing_count"] = missing
    return resolved, missing


def markdown_link(label: str | None, href: str | None) -> str:
    safe_label = (label or "source").replace("[", "\\[").replace("]", "\\]")
    if not href:
        return safe_label
    safe_href = href.replace(")", "%29")
    return f"[{safe_label}]({safe_href})"


def write_notice(manifest: dict[str, Any]) -> None:
    items = [item for item in manifest.get("items", []) if isinstance(item, dict)]
    lines = [
        "# PlumeLens Species Artwork Third-Party Attributions",
        "",
        "These artwork files are bundled with PlumeLens for offline species browsing.",
        "The source files are Wikimedia Commons assets referenced by the local species index.",
        "",
        f"Generated at: {manifest.get('attribution_generated_at', now_iso())}",
        f"Resolved metadata: {manifest.get('attribution_count', 0)}",
        f"Missing metadata: {manifest.get('attribution_missing_count', 0)}",
        "",
        "## Artwork",
        "",
    ]
    for item in sorted(items, key=lambda row: str(row.get("canonical_sci") or "")):
        species = str(item.get("canonical_sci") or "unknown species")
        file_name = str(item.get("file") or "unknown file")
        title = str(item.get("commons_title") or item.get("source_url") or "source")
        source = markdown_link(title, item.get("commons_page_url") or item.get("source_url"))
        artist = item.get("artist") or "unknown artist"
        license_name = item.get("license") or "unknown license"
        license_text = markdown_link(str(license_name), item.get("license_url"))
        lines.append(
            f"- `{species}` / `{file_name}`: {source}; artist: {artist}; license: {license_text}."
        )
    NOTICE_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--delay", type=float, default=DEFAULT_DELAY_SECONDS)
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument(
        "--skip-fetch",
        action="store_true",
        help="Only regenerate the notice from existing manifest metadata.",
    )
    args = parser.parse_args()

    manifest = load_manifest()
    items = [item for item in manifest.get("items", []) if isinstance(item, dict)]
    titles = sorted(
        {title for item in items if (title := commons_file_title(item.get("source_url")))}
    )
    metadata: dict[str, dict[str, Any]] = {}
    if not args.skip_fetch:
        metadata = fetch_commons_metadata(titles, batch_size=args.batch_size, delay=args.delay)
    resolved, missing = enrich_manifest(manifest, metadata)
    MANIFEST_PATH.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    write_notice(manifest)
    print(
        f"Wrote artwork attribution metadata ({resolved} resolved, {missing} missing) "
        f"to {MANIFEST_PATH} and {NOTICE_PATH}",
        flush=True,
    )


if __name__ == "__main__":
    main()
