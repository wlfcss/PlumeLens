"""Release guard for the deployed YOLO detector asset.

This intentionally checks the real repository asset instead of a temp fixture:
the detector model is small enough to hash in tests, and a stale model/version
pair can silently poison the whole analysis pipeline.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from engine.core.config import Settings

ROOT = Path(__file__).resolve().parents[3]
MODELS_DIR = ROOT / "engine" / "models"
YOLO_ONNX = MODELS_DIR / "yolo26l-bird-det.onnx"
YOLO_CARD = MODELS_DIR / "yolo26l-bird-det.MODEL_CARD.md"
MANIFEST = MODELS_DIR / "manifest.json"

EXPECTED_YOLO_VERSION = "v1.1"
EXPECTED_YOLO_SIZE = 99_872_905
EXPECTED_YOLO_SHA256 = "e71162a5c3a504112d790f1bd9da61aa239e7970d0d2b8a5d9579bd4658491c3"
EXPECTED_PREPROCESS_VERSION = 11


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


pytestmark = pytest.mark.skipif(
    not YOLO_ONNX.exists(),
    reason="YOLO ONNX asset not present in this checkout",
)


def test_yolo_release_asset_matches_v11_manifest_and_docs() -> None:
    assert YOLO_ONNX.stat().st_size == EXPECTED_YOLO_SIZE
    assert _sha256(YOLO_ONNX) == EXPECTED_YOLO_SHA256

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    yolo_entry = manifest["assets"]["yolo26l-bird-det.onnx"]
    assert yolo_entry == {
        "size": EXPECTED_YOLO_SIZE,
        "sha256": EXPECTED_YOLO_SHA256,
    }

    card_title = YOLO_CARD.read_text(encoding="utf-8").splitlines()[0]
    assert EXPECTED_YOLO_VERSION in card_title

    readme = (MODELS_DIR / "README.md").read_text(encoding="utf-8")
    assert f"YOLOv26l-bird-det {EXPECTED_YOLO_VERSION}" in readme

    assert Settings.model_fields["preprocess_version"].default == EXPECTED_PREPROCESS_VERSION
