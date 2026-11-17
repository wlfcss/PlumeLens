"""Read-only SHA-256 inventory/verification of the user's test photo directory."""

import argparse
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("root", type=Path)
parser.add_argument("--inventory", type=Path, required=True)
parser.add_argument("--verify", action="store_true")
args = parser.parse_args()
root = args.root.resolve()
if args.verify:
    expected = json.loads(args.inventory.read_text(encoding="utf-8"))
    files = [root / entry["relative"] for entry in expected["files"]]
else:
    files = sorted(path for path in root.rglob("*") if path.is_file())
entries = []
for index, path in enumerate(files):
    before = path.stat()
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(4 * 1024 * 1024), b""):
            digest.update(block)
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise RuntimeError(f"Source changed while reading: {path}")
    entry = {
        "relative": path.relative_to(root).as_posix(),
        "size": before.st_size,
        "mtime_ns": before.st_mtime_ns,
        "sha256": digest.hexdigest(),
    }
    if args.verify and entry != expected["files"][index]:
        raise RuntimeError(f"Source integrity mismatch: {path}")
    entries.append(entry)
    if (index + 1) % 100 == 0:
        print(f"Checked {index + 1}/{len(files)}", flush=True)
if not args.verify:
    args.inventory.parent.mkdir(parents=True, exist_ok=True)
    args.inventory.write_text(
        json.dumps({"root": str(root), "files": entries}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
print(
    f"{'Verified' if args.verify else 'Inventoried'} {len(entries)} files, "
    f"{sum(entry['size'] for entry in entries)} bytes",
    flush=True,
)
