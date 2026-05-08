"""Model asset SHA-256 manifest — startup-time integrity check.

Engine startup hashes every entry in `engine/models/manifest.json` and refuses
to load if any file is missing or hash-mismatched. This is the last line of
defense against supply-chain tampering of:

- ``species/v4/seed42_adapter.pt`` — loaded with
  ``torch.load(weights_only=False)`` which reconstructs arbitrary Python
  objects via pickle. A swapped file = arbitrary code execution under the
  engine's UID.
- ``*.onnx`` — a replaced graph silently shifts detector / IQA / pose outputs,
  poisoning the user's whole library without obvious symptoms.
- ``species/backbone/model.safetensors`` — DINOv3 ViT-L weights; tampered
  weights silently poison species predictions.

Regenerate via ``uv run python scripts/build_model_manifest.py`` after training
produces a new bundle, and commit the manifest in the SAME commit as the
changed model files.
"""

from __future__ import annotations

import hashlib
import json
import threading
from pathlib import Path
from typing import TypedDict

import structlog

logger = structlog.stdlib.get_logger()


class ManifestError(RuntimeError):
    """Manifest mismatch / missing — engine refuses to start."""


class _AssetEntry(TypedDict):
    size: int
    sha256: str


# 1 MiB streaming chunks — DINOv3 backbone safetensors ~600 MB, IQA ~300 MB；
# 一次 read() 全文件会让常驻内存峰值 +1 GB,且对 mmap-friendly safetensors 没收益。
_HASH_CHUNK = 1 << 20


# 同进程内幂等:manager 启动期已验证后,species.py 再次调用走 cache fast path,
# 不重复哈希(总成本 ~3-5s 对 1.3 GB 模型集),避免 cold-load 单图被阻塞。
_verify_cache: dict[tuple[str, str], dict[str, str]] = {}
_verify_lock = threading.Lock()


def _sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(_HASH_CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


_SENTINEL_ASSET = "yolo26l-bird-det.onnx"  # 必装核心模型,作为"环境是否带模型"的探针


def _load_manifest_assets(manifest_path: Path) -> dict[str, _AssetEntry]:
    # 调用方(verify_manifest)已经处理了 manifest_path 缺失场景,这里只负责解析。
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        msg = f"Cannot parse manifest {manifest_path}: {e}"
        raise ManifestError(msg) from e
    assets = data.get("assets")
    if not isinstance(assets, dict) or not assets:
        msg = f"Manifest {manifest_path} has no 'assets' section"
        raise ManifestError(msg)
    return assets  # type: ignore[return-value]


def verify_manifest(
    models_dir: Path,
    manifest_path: Path | None = None,
) -> dict[str, str]:
    """Hash every manifest entry and compare. Raise ManifestError on mismatch.

    Idempotent within a process — re-calls return the cached verified hashes
    without re-hashing, so manager.py (startup) and species.py (right before
    torch.load) can both call this safely.

    Args:
        models_dir: directory containing manifest entries (typically
            ``settings.models_dir``).
        manifest_path: explicit manifest location (defaults to
            ``models_dir / 'manifest.json'``).

    Returns:
        Mapping from relative asset path → verified SHA-256 hex digest.

    Raises:
        ManifestError: any entry missing, size-mismatched, or hash-mismatched.
    """
    if manifest_path is None:
        manifest_path = models_dir / "manifest.json"
    cache_key = (str(manifest_path.resolve()), str(models_dir.resolve()))
    with _verify_lock:
        cached = _verify_cache.get(cache_key)
    if cached is not None:
        return dict(cached)

    # 处理 manifest 缺失:区分 empty environment(测试 / fresh clone 无模型) 与
    # suspicious tampering(攻击者删 manifest 留下篡改的模型)。判据是 sentinel
    # 模型是否存在 — 没有任何模型时,manifest 缺也合理(走 detection-only 降级或
    # strict mode 在 IQA 校验时报错);有模型却没 manifest 一定是出错或被动手脚。
    if not manifest_path.is_file():
        sentinel = models_dir / _SENTINEL_ASSET
        if sentinel.is_file():
            msg = (
                f"Model manifest missing: {manifest_path} — but core model "
                f"{_SENTINEL_ASSET} exists. Suspicious. Regenerate manifest via "
                f"`uv run python scripts/build_model_manifest.py` if this is "
                f"intentional."
            )
            raise ManifestError(msg)
        logger.warning(
            "Model manifest missing — skipping integrity check (no core models present)",
            manifest_path=str(manifest_path),
        )
        empty: dict[str, str] = {}
        with _verify_lock:
            _verify_cache[cache_key] = empty
        return empty

    assets = _load_manifest_assets(manifest_path)
    verified: dict[str, str] = {}
    errors: list[str] = []

    for rel_path, entry in assets.items():
        full = models_dir / rel_path
        if not full.is_file():
            errors.append(f"missing: {rel_path}")
            continue
        try:
            expected_size = int(entry["size"])
            expected_sha = str(entry["sha256"]).lower()
        except (KeyError, ValueError, TypeError) as e:
            errors.append(f"bad manifest entry for {rel_path}: {e}")
            continue
        actual_size = full.stat().st_size
        if actual_size != expected_size:
            errors.append(
                f"size mismatch: {rel_path} expected={expected_size} actual={actual_size}"
            )
            continue
        actual_sha = _sha256_of(full)
        if actual_sha.lower() != expected_sha:
            errors.append(
                f"sha256 mismatch: {rel_path} "
                f"expected={expected_sha[:16]}... actual={actual_sha[:16]}..."
            )
            continue
        verified[rel_path] = actual_sha

    if errors:
        joined = "\n  - ".join(errors)
        msg = (
            "Model manifest verification failed — engine refuses to start "
            "(supply-chain integrity check; regenerate manifest via "
            "`uv run python scripts/build_model_manifest.py` after intentional "
            f"model updates):\n  - {joined}"
        )
        raise ManifestError(msg)

    with _verify_lock:
        _verify_cache[cache_key] = dict(verified)
    return verified


def reset_cache_for_tests() -> None:
    """Test helper — drop the verification cache so tampering tests start fresh."""
    with _verify_lock:
        _verify_cache.clear()
