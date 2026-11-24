"""Tests for engine.core.manifest — startup-time SHA-256 integrity check.

The manifest gate is the last line of defense for the species adapter pickle
load (torch.load weights_only=False). These tests lock down four scenarios:

1. happy path  — manifest matches files
2. tamper      — file content changed under our feet
3. removal     — manifest says file is required, file vanished
4. suspicious  — manifest deleted but a core model still on disk
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from engine.core.manifest import (
    ManifestError,
    reset_cache_for_tests,
    verify_manifest,
)


@pytest.fixture(autouse=True)
def _reset_cache() -> None:
    reset_cache_for_tests()


def _sha256(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest()


def _write_manifest(path: Path, entries: dict[str, dict[str, object]]) -> None:
    payload = {
        "manifest_version": 1,
        "generated_at": "2026-05-08T00:00:00+00:00",
        "comment": "test fixture",
        "assets": entries,
    }
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_verify_happy_path(tmp_path: Path) -> None:
    blob = b"yolo-fake-bytes"
    (tmp_path / "yolo26l-bird-det.onnx").write_bytes(blob)
    _write_manifest(
        tmp_path / "manifest.json",
        {"yolo26l-bird-det.onnx": {"size": len(blob), "sha256": _sha256(blob)}},
    )
    verified = verify_manifest(tmp_path)
    assert verified == {"yolo26l-bird-det.onnx": _sha256(blob)}


def test_verify_rejects_sha_mismatch(tmp_path: Path) -> None:
    blob = b"real-content"
    (tmp_path / "yolo26l-bird-det.onnx").write_bytes(blob)
    _write_manifest(
        tmp_path / "manifest.json",
        {"yolo26l-bird-det.onnx": {"size": len(blob), "sha256": "0" * 64}},
    )
    with pytest.raises(ManifestError, match="sha256 mismatch"):
        verify_manifest(tmp_path)


def test_verify_rejects_size_mismatch(tmp_path: Path) -> None:
    blob = b"actual-bytes"
    (tmp_path / "yolo26l-bird-det.onnx").write_bytes(blob)
    _write_manifest(
        tmp_path / "manifest.json",
        {"yolo26l-bird-det.onnx": {"size": 9999, "sha256": _sha256(blob)}},
    )
    with pytest.raises(ManifestError, match="size mismatch"):
        verify_manifest(tmp_path)


def test_verify_rejects_missing_file(tmp_path: Path) -> None:
    _write_manifest(
        tmp_path / "manifest.json",
        {"yolo26l-bird-det.onnx": {"size": 5, "sha256": _sha256(b"hello")}},
    )
    with pytest.raises(ManifestError, match="missing: yolo26l-bird-det.onnx"):
        verify_manifest(tmp_path)


def test_verify_skips_when_no_manifest_and_no_models(tmp_path: Path) -> None:
    # 真实空环境(测试 / fresh clone):无 manifest 也无 sentinel → 静默跳过。
    out = verify_manifest(tmp_path)
    assert out == {}


def test_verify_rejects_missing_manifest_with_models_present(tmp_path: Path) -> None:
    # 可疑场景:manifest 被删但 sentinel 模型文件还在 → 必须拒绝启动。
    (tmp_path / "yolo26l-bird-det.onnx").write_bytes(b"sentinel")
    with pytest.raises(ManifestError, match="Suspicious"):
        verify_manifest(tmp_path)


def test_verify_caches_within_process(tmp_path: Path) -> None:
    blob = b"cache-test"
    (tmp_path / "yolo26l-bird-det.onnx").write_bytes(blob)
    _write_manifest(
        tmp_path / "manifest.json",
        {"yolo26l-bird-det.onnx": {"size": len(blob), "sha256": _sha256(blob)}},
    )
    first = verify_manifest(tmp_path)
    # 同长度修改:走 sha256 mismatch(size check 不会拦)。
    tampered = b"x" * len(blob)
    assert tampered != blob
    (tmp_path / "yolo26l-bird-det.onnx").write_bytes(tampered)
    second = verify_manifest(tmp_path)
    # 改文件不会触发重新哈希(因为同 manifest_path/models_dir 已 cache)
    assert first == second
    # reset_cache 后再校验应当抛(因为现在文件确实和 manifest 不一致了)
    reset_cache_for_tests()
    with pytest.raises(ManifestError, match="sha256 mismatch"):
        verify_manifest(tmp_path)


def test_verify_rejects_malformed_manifest(tmp_path: Path) -> None:
    (tmp_path / "manifest.json").write_text("not json", encoding="utf-8")
    with pytest.raises(ManifestError, match="Cannot parse manifest"):
        verify_manifest(tmp_path)


def test_verify_rejects_empty_assets(tmp_path: Path) -> None:
    _write_manifest(tmp_path / "manifest.json", {})
    with pytest.raises(ManifestError, match="no 'assets' section"):
        verify_manifest(tmp_path)


def test_release_check_rejects_bundle_with_its_own_matching_manifest(tmp_path: Path) -> None:
    models = tmp_path / "downloaded"
    models.mkdir()
    asset = "species/v4/seed42_adapter.pt"
    (models / asset).parent.mkdir(parents=True)
    original, replaced = b"reviewed-weight", b"replaced-weight"
    trusted = tmp_path / "checkout-manifest.json"
    _write_manifest(trusted, {asset: {"size": len(original), "sha256": _sha256(original)}})
    (models / asset).write_bytes(replaced)
    _write_manifest(
        models / "manifest.json",
        {
            asset: {"size": len(replaced), "sha256": _sha256(replaced)},
        },
    )
    with pytest.raises(ManifestError, match="sha256 mismatch"):
        verify_manifest(models, trusted, required_assets=[asset])


def test_release_check_requires_coverage_even_if_an_asset_exists(tmp_path: Path) -> None:
    (tmp_path / "a.onnx").write_bytes(b"a")
    (tmp_path / "unlisted.pt").write_bytes(b"b")
    trusted = tmp_path / "trusted.json"
    _write_manifest(trusted, {"a.onnx": {"size": 1, "sha256": _sha256(b"a")}})
    with pytest.raises(ManifestError, match="Required assets absent"):
        verify_manifest(tmp_path, trusted, required_assets=["a.onnx", "unlisted.pt"])


def test_release_check_requires_a_trusted_manifest_in_an_empty_environment(tmp_path: Path) -> None:
    with pytest.raises(ManifestError, match="Trusted manifest missing"):
        verify_manifest(tmp_path, tmp_path / "missing.json", required_assets=["a.onnx"])


def test_verify_rejects_missing_manifest_when_only_species_adapter_present(tmp_path: Path) -> None:
    adapter = tmp_path / "species" / "v4" / "seed42_adapter.pt"
    adapter.parent.mkdir(parents=True)
    adapter.write_bytes(b"fake-pickle-adapter")
    with pytest.raises(ManifestError, match="Suspicious"):
        verify_manifest(tmp_path)
