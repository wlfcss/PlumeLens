"""Verify Windows runtime assets, ZIP byte identity and distribution SHA-256."""

from __future__ import annotations

import argparse
import hashlib
import json
import zipfile
from pathlib import Path
from typing import BinaryIO


def digest(source: BinaryIO) -> str:
    value = hashlib.sha256()
    for block in iter(lambda: source.read(4 * 1024 * 1024), b""):
        value.update(block)
    return value.hexdigest()


def file_digest(path: Path) -> str:
    with path.open("rb") as source:
        return digest(source)


def verify_package(
    package: Path,
    archive: Path | None,
    require_amd: bool,
    trusted_manifest: Path | None = None,
) -> dict:
    package = package.resolve()
    resources = package / "resources"
    engine = resources / "plumelens-engine"
    required = [
        package / "PlumeLens.exe",
        engine / "plumelens-engine.exe",
        resources / "app.asar",
        package / "prepare-windows-gpu.cmd",
        package / "WINDOWS.md",
        package / "LICENSE",
        resources / "models/species/LICENSE.md",
        resources / "third-party-notices/index.json",
    ]
    for path in required:
        if not path.is_file() or not path.stat().st_size:
            raise ValueError(f"Missing package file: {path}")
    models = resources / "models"
    manifest_source = trusted_manifest if trusted_manifest is not None else models / "manifest.json"
    assets = json.loads(manifest_source.read_text(encoding="utf-8"))["assets"]
    cached_digests: dict[Path, str] = {}

    def cached_file_digest(path: Path) -> str:
        resolved = path.resolve()
        value = cached_digests.get(resolved)
        if value is None:
            value = file_digest(resolved)
            cached_digests[resolved] = value
        return value

    for name, expected in assets.items():
        path = (models / name).resolve()
        if not path.is_relative_to(models.resolve()):
            raise ValueError(f"Invalid model path: {name}")
        if (
            path.stat().st_size != expected["size"]
            or cached_file_digest(path) != expected["sha256"]
        ):
            raise ValueError(f"Packaged model SHA mismatch: {name}")
    sdk = engine / "_internal/_rocm_sdk_core"
    if require_amd and not sdk.is_dir():
        raise ValueError("AMD runtime was not packaged")
    if any(path.suffix.lower() in {".exe", ".lib", ".pdb"} for path in sdk.rglob("*")):
        raise ValueError("Development-only ROCm build tools were packaged")
    if any("aotriton.images" in path.parts for path in engine.rglob("*")):
        raise ValueError("Unused flash-attention kernel archives were packaged")
    files = {
        path.relative_to(package).as_posix(): path for path in package.rglob("*") if path.is_file()
    }
    report = {
        "files": len(files),
        "unpacked_bytes": sum(path.stat().st_size for path in files.values()),
        "verified_models": len(assets),
        "amd_runtime": sdk.is_dir(),
        "app_sha256": cached_file_digest(required[0]),
        "engine_sha256": cached_file_digest(required[1]),
    }
    if archive is not None:
        with zipfile.ZipFile(archive) as bundle:
            entries = [entry for entry in bundle.infolist() if not entry.is_dir()]
            if len(entries) != len(files) or {entry.filename for entry in entries} != set(files):
                raise ValueError("ZIP files differ from the verified portable directory")
            for index, entry in enumerate(entries, 1):
                source = files[entry.filename]
                with bundle.open(entry) as stream:
                    if entry.file_size != source.stat().st_size or digest(
                        stream
                    ) != cached_file_digest(source):
                        raise ValueError(f"ZIP byte mismatch: {entry.filename}")
                if index % 500 == 0:
                    print(f"Verified ZIP entries: {index}/{len(entries)}", flush=True)
        value = file_digest(archive)
        report.update(
            {
                "archive_bytes": archive.stat().st_size,
                "archive_sha256": value,
                "verified_zip_files": len(files),
            }
        )
        Path(str(archive) + ".sha256").write_text(f"{value}  {archive.name}\n", encoding="ascii")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-dir", type=Path, default=Path("release/win-unpacked"))
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--trusted-manifest", type=Path)
    parser.add_argument("--require-amd", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = verify_package(args.package_dir, args.archive, args.require_amd, args.trusted_manifest)
    if args.output:
        args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
