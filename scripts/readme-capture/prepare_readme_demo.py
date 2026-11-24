"""Create anonymous README inputs from already attributed, bundled bird photographs.

Only the copies below /private/tmp are written. Originals and private photo
directories are never opened. Repeated pictures are deliberate demo records for
showing a species facet with more than one photo, not a real burst sequence.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pyarrow.parquet as pq
from PIL import Image

REPO = Path(__file__).resolve().parents[2]
ARTWORK = REPO / "resources" / "species-artwork"
ROOT = Path(os.environ.get("PLUMELENS_README_DEMO_ROOT", "/private/tmp/PlumeLens演示图库"))
PHOTO_DIR = ROOT / "春日观鸟"
SPECIES = (
    ("Alcedo atthis", 3, "select"),
    ("Egretta garzetta", 2, "usable"),
    ("Ardea cinerea", 2, "usable"),
    ("Urocissa erythroryncha", 1, "select"),
    ("Passer montanus", 1, "record"),
    ("Pycnonotus sinensis", 1, "select"),
    ("Aegithalos glaucogularis", 1, "usable"),
    ("Pica serica", 1, "record"),
)


def main() -> None:
    items = json.loads((ARTWORK / "manifest.json").read_text())["items"]
    by_species = {item["canonical_sci"]: item for item in items}
    taxonomy = pq.read_table(
        REPO / "engine" / "models" / "species" / "canonical_extended.parquet"
    ).to_pylist()
    names = {row["canonical_sci"]: row for row in taxonomy}
    PHOTO_DIR.mkdir(parents=True, exist_ok=True)
    rows = []
    for scientific_name, count, decision in SPECIES:
        item = by_species[scientific_name]
        source = ARTWORK / item["file"]
        for _ in range(count):
            number = len(rows) + 1
            file_name = f"BIRD_{number:03d}.JPG"
            dest = PHOTO_DIR / file_name
            with Image.open(source) as image:
                image.convert("RGB").save(dest, "JPEG", quality=95)
            # Anonymous demonstration time, never copied GPS/camera/user metadata.
            stamp = 1779064200 + number * 12
            os.utime(dest, (stamp, stamp))
            name = names[scientific_name]
            rows.append(
                {
                    "file_name": file_name,
                    "canonical_sci": scientific_name,
                    "canonical_zh": name.get("canonical_zh"),
                    "canonical_en": name.get("canonical_en"),
                    "decision": decision,
                    "bundled_source": source.relative_to(REPO).as_posix(),
                    "artist": item.get("artist"),
                    "license": item.get("license"),
                    "license_url": item.get("license_url"),
                    "commons_page_url": item.get("commons_page_url"),
                }
            )
    manifest = {
        "demo": True,
        "description": "Bundled licensed photographs; repeated demo inputs and manual confirmation",
        "photo_dir": str(PHOTO_DIR),
        "source_attributions": "resources/species-artwork/THIRD_PARTY_ATTRIBUTIONS.md",
        "photos": rows,
    }
    (ROOT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(f"Prepared {len(rows)} real-photo demo inputs in {PHOTO_DIR}")


if __name__ == "__main__":
    main()
