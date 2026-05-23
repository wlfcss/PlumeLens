"""Optimize packaged species artwork to WebP.

Run after scripts/download_species_artwork.py. The app reads artwork by stem, so
`ardeola_bacchus.jpg` and `ardeola_bacchus.webp` resolve to the same species key.

Usage:
    uv run --project engine python scripts/optimize_species_artwork.py
"""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from PIL import Image

OUTPUT_DIR = Path("resources/species-artwork")
MANIFEST_PATH = OUTPUT_DIR / "manifest.json"
INPUT_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
DEFAULT_QUALITY = 82


def artwork_files() -> list[Path]:
    if not OUTPUT_DIR.exists():
        raise SystemExit(f"Missing {OUTPUT_DIR}; run scripts/download_species_artwork.py first")
    return sorted(
        path
        for path in OUTPUT_DIR.iterdir()
        if path.is_file() and path.suffix.lower() in INPUT_EXTENSIONS
    )


def webp_mode(image: Image.Image) -> Image.Image:
    if image.mode in {"RGB", "RGBA"}:
        return image
    has_alpha = "A" in image.getbands() or image.mode in {"LA", "PA"}
    return image.convert("RGBA" if has_alpha else "RGB")


def optimize_file(path: Path, quality: int, force: bool) -> dict[str, Any]:
    target = path.with_suffix(".webp")
    original_size = path.stat().st_size
    if path.suffix.lower() == ".webp" and not force:
        return {
            "file": path.name,
            "original_file": path.name,
            "original_bytes": original_size,
            "bytes": original_size,
            "status": "kept",
        }

    with Image.open(path) as image:
        image.load()
        optimized = webp_mode(image)
        tmp = target.with_suffix(".webp.tmp")
        optimized.save(tmp, "WEBP", quality=quality, method=6)
        optimized_size = tmp.stat().st_size
        tmp.replace(target)

    if path != target:
        path.unlink()
    return {
        "file": target.name,
        "original_file": path.name,
        "original_bytes": original_size,
        "bytes": optimized_size,
        "status": "optimized",
    }


def load_manifest() -> dict[str, Any]:
    if not MANIFEST_PATH.exists():
        return {"version": 1, "items": []}
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def write_manifest(
    manifest: dict[str, Any],
    optimized_by_file: dict[str, dict[str, Any]],
    quality: int,
) -> None:
    items = manifest.get("items")
    if isinstance(items, list):
        for item in items:
            if not isinstance(item, dict):
                continue
            file_name = str(item.get("file") or "")
            optimized = optimized_by_file.get(file_name) or optimized_by_file.get(
                Path(file_name).with_suffix(".webp").name
            )
            if not optimized:
                continue
            if optimized["status"] == "kept" and isinstance(item.get("optimized"), dict):
                continue
            item["file"] = optimized["file"]
            item["optimized"] = {
                "bytes": optimized["bytes"],
                "original_bytes": optimized["original_bytes"],
                "original_file": optimized["original_file"],
                "quality": quality,
                "status": optimized["status"],
            }
    manifest["artwork_format"] = "webp"
    manifest["optimized_at"] = datetime.now(UTC).isoformat()
    manifest["webp_quality"] = quality
    MANIFEST_PATH.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--quality", type=int, default=DEFAULT_QUALITY)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    files = artwork_files()
    before = sum(path.stat().st_size for path in files)
    results = [optimize_file(path, quality=args.quality, force=args.force) for path in files]
    optimized_by_file = {
        str(result["original_file"]): result for result in results if isinstance(result, dict)
    }
    optimized_by_file.update(
        {str(result["file"]): result for result in results if isinstance(result, dict)}
    )
    write_manifest(load_manifest(), optimized_by_file, args.quality)

    after_files = artwork_files()
    after = sum(path.stat().st_size for path in after_files)
    print(
        f"Optimized {len(files)} species artwork files to WebP "
        f"({before / 1024 / 1024:.1f} MB -> {after / 1024 / 1024:.1f} MB, "
        f"quality={args.quality})",
        flush=True,
    )


if __name__ == "__main__":
    main()
