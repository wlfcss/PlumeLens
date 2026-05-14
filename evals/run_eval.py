"""Evaluation dataset inventory for PlumeLens.

Usage:
    uv run python evals/run_eval.py --pipeline-version v1-xxxx

The repository does not ship private photo fixtures. This command is still useful in CI or
local handoff because it validates that every image in ``evals/dataset`` has a matching
JSON baseline in ``evals/golden`` and writes a small machine-readable run manifest. A
future model-scoring runner can consume the same manifest shape.
"""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

IMAGE_SUFFIXES = {
    ".arw",
    ".cr2",
    ".cr3",
    ".dng",
    ".jpeg",
    ".jpg",
    ".nef",
    ".orf",
    ".png",
    ".raf",
    ".rw2",
    ".tif",
    ".tiff",
}


def _repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _relative_id(path: Path, root: Path) -> str:
    return path.relative_to(root).with_suffix("").as_posix()


def _collect_images(dataset_dir: Path) -> list[Path]:
    if not dataset_dir.exists():
        return []
    return sorted(
        path
        for path in dataset_dir.rglob("*")
        if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES
    )


def _collect_golden(golden_dir: Path) -> dict[str, Path]:
    if not golden_dir.exists():
        return {}
    return {
        path.relative_to(golden_dir).with_suffix("").as_posix(): path
        for path in sorted(golden_dir.rglob("*.json"))
        if path.is_file()
    }


def build_manifest(
    *,
    pipeline_version: str,
    dataset_dir: Path,
    golden_dir: Path,
) -> dict[str, Any]:
    images = _collect_images(dataset_dir)
    golden = _collect_golden(golden_dir)
    image_ids = [_relative_id(path, dataset_dir) for path in images]
    image_id_set = set(image_ids)
    golden_id_set = set(golden)
    missing_golden = sorted(image_id_set - golden_id_set)
    orphan_golden = sorted(golden_id_set - image_id_set)

    if not images:
        status = "no_data"
    elif missing_golden or orphan_golden:
        status = "incomplete"
    else:
        status = "ready"

    return {
        "schema_version": 1,
        "created_at": datetime.now(UTC).isoformat(),
        "pipeline_version": pipeline_version,
        "status": status,
        "dataset_dir": str(dataset_dir),
        "golden_dir": str(golden_dir),
        "metrics": {
            "image_count": len(images),
            "golden_count": len(golden),
            "matched_count": len(image_id_set & golden_id_set),
            "missing_golden_count": len(missing_golden),
            "orphan_golden_count": len(orphan_golden),
        },
        "missing_golden": missing_golden,
        "orphan_golden": orphan_golden,
    }


def main(argv: list[str] | None = None) -> int:
    root = _repo_root()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pipeline-version", required=True)
    parser.add_argument("--dataset", type=Path, default=root / "evals" / "dataset")
    parser.add_argument("--golden", type=Path, default=root / "evals" / "golden")
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Exit non-zero when the eval dataset is empty or baselines are incomplete.",
    )
    args = parser.parse_args(argv)

    manifest = build_manifest(
        pipeline_version=args.pipeline_version,
        dataset_dir=args.dataset.resolve(),
        golden_dir=args.golden.resolve(),
    )
    payload = json.dumps(manifest, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(f"{payload}\n", encoding="utf-8")
    print(payload)

    if args.strict and manifest["status"] != "ready":
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
