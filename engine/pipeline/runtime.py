# pyright: basic
"""ONNX execution providers and safe DirectML session configuration."""

from __future__ import annotations

import shutil
import sys
from pathlib import Path
from typing import Any

import structlog

from engine.core.config import settings
from engine.core.gpu import WINDOWS_GPU_LOCK

logger = structlog.get_logger()


def resolve_providers(
    requested: str,
    *,
    coreml_compute_units: str | None = None,
    coreml_model_format: str | None = None,
    coreml_cache_dir: str | None = None,
) -> list:
    import onnxruntime as ort

    available = set(ort.get_available_providers())
    names = {
        "cpu": "CPUExecutionProvider",
        "cuda": "CUDAExecutionProvider",
        "coreml": "CoreMLExecutionProvider",
        "directml": "DmlExecutionProvider",
    }
    if requested == "auto":
        preferred = next(
            (
                name
                for name in (names["cuda"], names["directml"], names["coreml"])
                if name in available
            ),
            names["cpu"],
        )
    else:
        preferred = names.get(requested, names["cpu"])
    if preferred not in available or preferred == names["cpu"]:
        return [names["cpu"]]
    entry: str | tuple[str, dict[str, str]] = preferred
    if preferred == names["coreml"]:
        coreml_opts: dict[str, str] = {}
        if coreml_model_format:
            coreml_opts["ModelFormat"] = coreml_model_format
        if coreml_compute_units:
            coreml_opts["MLComputeUnits"] = coreml_compute_units
        if coreml_cache_dir:
            coreml_opts["ModelCacheDirectory"] = coreml_cache_dir
        if coreml_opts:
            entry = (preferred, coreml_opts)
    return [entry, names["cpu"]]


class _SerializedSession:
    """DirectML permits only one concurrent Run per session."""

    def __init__(self, session: Any) -> None:
        self._session = session
        self._lock = WINDOWS_GPU_LOCK

    def __getattr__(self, name: str) -> Any:
        return getattr(self._session, name)

    def run(self, *args: Any, **kwargs: Any) -> Any:
        with self._lock:
            return self._session.run(*args, **kwargs)


def _strip_coreml_cache_dir(providers: list) -> list:
    stripped: list = []
    for entry in providers:
        if isinstance(entry, tuple) and entry[0] == "CoreMLExecutionProvider":
            opts = {k: v for k, v in entry[1].items() if k != "ModelCacheDirectory"}
            stripped.append((entry[0], opts) if opts else entry[0])
        else:
            stripped.append(entry)
    return stripped


def _has_coreml_cache_dir(providers: list) -> str | None:
    for entry in providers:
        if isinstance(entry, tuple) and entry[0] == "CoreMLExecutionProvider":
            cache_dir = entry[1].get("ModelCacheDirectory")
            if cache_dir:
                return str(cache_dir)
    return None


def create_session(path: str, *, providers: list) -> Any:
    import onnxruntime as ort

    names = [entry[0] if isinstance(entry, tuple) else entry for entry in providers]
    options = ort.SessionOptions()
    if sys.platform in ("win32", "darwin"):
        # Multiple model sessions and photo workers must not each spin up a
        # full-machine CPU thread pool, even when GPU graph fragments fall back.
        options.intra_op_num_threads = settings.onnx_threads
        options.inter_op_num_threads = 1
        options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    if "AMDGPUExecutionProvider" in names:
        from engine.pipeline.windows_gpu import create_verified_session

        try:
            return _SerializedSession(create_verified_session(path, options))
        except Exception as error:
            # A driver/provider update or damaged cache must not prevent startup.
            logger.warning("AMD GPU session unavailable; using CPU", error=str(error))
            return create_session(path, providers=["CPUExecutionProvider"])
    if "DmlExecutionProvider" in names:
        options.enable_mem_pattern = False
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        session = ort.InferenceSession(path, sess_options=options, providers=providers)
        return _SerializedSession(session)
    cache_dir = _has_coreml_cache_dir(providers)
    if cache_dir:
        try:
            Path(cache_dir).mkdir(parents=True, exist_ok=True)
            return ort.InferenceSession(path, sess_options=options, providers=providers)
        except Exception as error:
            logger.warning(
                "CoreML cached session failed; retrying without ModelCacheDirectory",
                path=path,
                cache_dir=cache_dir,
                error=str(error),
            )
            return ort.InferenceSession(
                path,
                sess_options=options,
                providers=_strip_coreml_cache_dir(providers),
            )
    return ort.InferenceSession(path, sess_options=options, providers=providers)


def prune_stale_coreml_caches(cache_root: Path, active_dirname: str) -> list[str]:
    """Remove obsolete ``ort-*`` CoreML compiled cache directories after upgrade.

    Best-effort: only removes non-symlink ``ort-*`` subdirectories whose name
    differs from ``active_dirname``, leaving unrelated files/folders untouched.
    """
    if not cache_root.exists() or not cache_root.is_dir():
        return []
    removed: list[str] = []
    try:
        entries = list(cache_root.iterdir())
    except OSError:
        return []
    for entry in entries:
        if (
            entry.name == active_dirname
            or not entry.name.startswith("ort-")
            or entry.is_symlink()
            or not entry.is_dir()
        ):
            continue
        shutil.rmtree(entry, ignore_errors=True)
        if not entry.exists():
            removed.append(entry.name)
    if removed:
        logger.info(
            "Pruned stale CoreML cache directories",
            cache_root=str(cache_root),
            active=active_dirname,
            removed=sorted(removed),
        )
    return sorted(removed)
