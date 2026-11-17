"""Restore only reviewed model assets from a ZIP/tar bundle and verify every SHA."""

from __future__ import annotations

import argparse
import hashlib
import json
import tarfile
import zipfile
from contextlib import ExitStack
from pathlib import Path, PurePosixPath
from typing import BinaryIO


def restore_models(archive: Path, models_dir: Path, trusted_manifest: Path) -> int:
    manifest_bytes = trusted_manifest.read_bytes()
    assets = json.loads(manifest_bytes)["assets"]
    root = models_dir.resolve()
    root.mkdir(parents=True, exist_ok=True)
    with ExitStack() as stack:
        if zipfile.is_zipfile(archive):
            bundle = stack.enter_context(zipfile.ZipFile(archive))
            members = {item.filename.removeprefix("./"): item for item in bundle.infolist()}

            def open_member(name: str) -> BinaryIO:
                return bundle.open(members[name])
        else:
            tar = stack.enter_context(tarfile.open(archive))
            members = {item.name.removeprefix("./"): item for item in tar.getmembers()}

            def open_member(name: str) -> BinaryIO:
                member = members[name]
                if not member.isfile():
                    raise ValueError(f"Model asset must be a regular file: {name}")
                result = tar.extractfile(member)
                if result is None:
                    raise ValueError(f"Cannot read model asset: {name}")
                return result

        prefix = next(
            (
                part
                for part in ("engine/models/", "models/", "resources/models/", "")
                if all(part + name in members for name in assets)
            ),
            None,
        )
        if prefix is None:
            raise ValueError("Model bundle is missing reviewed assets")
        ordered = list(assets)
        if not zipfile.is_zipfile(archive):
            # Gzip seeks backwards require decompression again. Restore tar
            # members in archive order instead of repeatedly rewinding gigabytes.
            ordered.sort(key=lambda name: members[prefix + name].offset_data)
        for name in ordered:
            expected = assets[name]
            relative = PurePosixPath(name)
            target = (root / relative).resolve()
            if relative.is_absolute() or ".." in relative.parts or not target.is_relative_to(root):
                raise ValueError(f"Invalid reviewed asset path: {name}")
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(target.name + ".download")
            digest, size = hashlib.sha256(), 0
            try:
                with open_member(prefix + name) as source, temporary.open("wb") as destination:
                    for block in iter(lambda: source.read(4 * 1024 * 1024), b""):
                        size += len(block)
                        digest.update(block)
                        destination.write(block)
                if size != expected["size"] or digest.hexdigest() != expected["sha256"]:
                    raise ValueError(f"Model SHA-256/size mismatch: {name}")
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
        # Never let the downloaded bundle replace the reviewed manifest.
        (root / "manifest.json").write_bytes(manifest_bytes)
    return len(assets)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--models-dir", type=Path, default=Path("engine/models"))
    parser.add_argument("--trusted-manifest", type=Path, required=True)
    args = parser.parse_args()
    count = restore_models(args.archive, args.models_dir, args.trusted_manifest)
    print(f"Restored and SHA-256 verified {count} reviewed model assets")


if __name__ == "__main__":
    main()
