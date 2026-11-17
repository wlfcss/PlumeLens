# pyright: basic
"""ONNX execution providers and safe DirectML session configuration."""

from __future__ import annotations

import sys
from typing import Any

import structlog

from engine.core.config import settings
from engine.core.gpu import WINDOWS_GPU_LOCK

logger = structlog.get_logger()


def resolve_providers(requested: str, *, coreml_compute_units: str | None = None) -> list:
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
    if preferred == names["coreml"] and coreml_compute_units:
        entry = (preferred, {"MLComputeUnits": coreml_compute_units})
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


def create_session(path: str, *, providers: list) -> Any:
    import onnxruntime as ort

    names = [entry[0] if isinstance(entry, tuple) else entry for entry in providers]
    options = ort.SessionOptions()
    if sys.platform == "win32":
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
    return ort.InferenceSession(path, sess_options=options, providers=providers)
