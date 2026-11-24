"""Bound Windows photo workers by physical memory and apply admission backpressure."""

from __future__ import annotations

import asyncio
import ctypes
import os
import sys
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Self, TypeVar

if TYPE_CHECKING:
    from engine.core.config import Settings

GIB = 1024**3
T = TypeVar("T")


@dataclass(frozen=True)
class MemoryStatus:
    total: int
    available: int


def memory_status() -> MemoryStatus | None:
    if sys.platform != "win32":
        return None

    class Status(ctypes.Structure):
        _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong)] + [
            (name, ctypes.c_ulonglong)
            for name in (
                "total",
                "available",
                "page_total",
                "page_available",
                "virtual_total",
                "virtual_available",
                "extended_available",
            )
        ]

    status = Status()
    status.length = ctypes.sizeof(status)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        return None
    return MemoryStatus(total=status.total, available=status.available)


def recommended_workers(total_bytes: int, native_gpu: bool, logical_cpus: int | None = None) -> int:
    gib = total_bytes / 1024**3
    cpus = logical_cpus or os.cpu_count() or 1
    if gib < 12 or cpus < 4:
        return 1
    if native_gpu and gib >= 24 and cpus >= 8:
        return 3
    return 2


def logical_cpus() -> int:
    """Respect process affinity instead of counting unavailable CPU cores."""
    count = os.cpu_count() or 1
    if sys.platform == "win32":
        process_mask, system_mask = ctypes.c_size_t(), ctypes.c_size_t()
        kernel = ctypes.windll.kernel32
        kernel.GetCurrentProcess.restype = ctypes.c_void_p
        kernel.GetProcessAffinityMask.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_size_t),
            ctypes.POINTER(ctypes.c_size_t),
        ]
        if kernel.GetProcessAffinityMask(
            kernel.GetCurrentProcess(), ctypes.byref(process_mask), ctypes.byref(system_mask)
        ):
            count = process_mask.value.bit_count() or count
    return count


def configure_windows(settings: Settings, *, native_gpu: bool = False) -> dict[str, object]:
    """Select bounded defaults; explicit environment/user settings always win."""
    memory = memory_status()
    if memory is None:
        return {}
    cpus = logical_cpus()
    gib = memory.total / GIB
    defaults = {
        "analysis_concurrency": recommended_workers(memory.total, native_gpu, cpus),
        "thumbnail_concurrency": min(4, max(1, cpus // 2), 1 if gib < 12 else 2 if gib < 24 else 4),
        "worker_threads": min(8, max(2, cpus // 2), 4 if gib < 12 else 8),
        "onnx_threads": min(4, max(1, cpus // 2)),
    }
    gpu: dict[str, object] = {}
    # Torch is already loaded by the model manager. Do not initialize a GPU
    # runtime just to size the startup thread pool.
    torch = sys.modules.get("torch")
    if native_gpu and torch is not None and torch.cuda.is_available():
        properties = torch.cuda.get_device_properties(0)
        gpu = {"name": properties.name, "memory_bytes": properties.total_memory}
        if properties.total_memory < 6 * GIB:
            defaults["analysis_concurrency"] = 1
        elif properties.total_memory < 12 * GIB:
            defaults["analysis_concurrency"] = min(2, defaults["analysis_concurrency"])
    for name, value in defaults.items():
        if name not in settings.model_fields_set:
            # Preserve which fields the user supplied: a later provider-aware
            # refinement must not confuse our startup defaults with overrides.
            object.__setattr__(settings, name, value)
    return {
        "logical_cpus": cpus,
        "physical_memory_bytes": memory.total,
        "gpu": gpu,
        "native_amd_gpu": native_gpu,
        "configuration": {name: getattr(settings, name) for name in defaults},
        "manual_overrides": sorted(set(defaults) & settings.model_fields_set),
        "memory_reserve_bytes": memory_reserve(memory),
    }


def _macos_total_memory_bytes() -> int | None:
    if sys.platform != "darwin":
        return None
    try:
        page_size = os.sysconf("SC_PAGE_SIZE")
        phys_pages = os.sysconf("SC_PHYS_PAGES")
        if page_size > 0 and phys_pages > 0:
            return int(page_size * phys_pages)
    except (AttributeError, OSError, ValueError):
        return None
    return None


def recommended_macos_workers(total_bytes: int, logical_cpus_count: int | None = None) -> int:
    """Choose macOS concurrent photo analysis workers by unified memory and core count."""
    gib = total_bytes / GIB
    cpus = logical_cpus_count or os.cpu_count() or 1
    if gib >= 32 and cpus >= 10:
        return 4
    if gib >= 16 and cpus >= 8:
        return 3
    return 2


def configure_macos(settings: Settings) -> dict[str, object]:
    """Select bounded Apple Silicon / macOS defaults; explicit env overrides always win."""
    total_bytes = _macos_total_memory_bytes()
    if total_bytes is None:
        return {}
    cpus = logical_cpus()
    analysis_concurrency = recommended_macos_workers(total_bytes, cpus)
    defaults = {
        "analysis_concurrency": analysis_concurrency,
        "worker_threads": min(16, max(8, analysis_concurrency * 3)),
        "onnx_threads": min(4, max(2, cpus // 4)),
    }
    for name, value in defaults.items():
        if name not in settings.model_fields_set:
            object.__setattr__(settings, name, value)
    return {
        "platform": "darwin",
        "logical_cpus": cpus,
        "physical_memory_bytes": total_bytes,
        "configuration": {name: getattr(settings, name) for name in defaults},
        "manual_overrides": sorted(set(defaults) & settings.model_fields_set),
    }


def memory_reserve(status: MemoryStatus) -> int:
    return max(2 * GIB, int(status.total * 0.15))


class MemoryBoundLimiter:
    """Lower admission under memory pressure and recover without killing work."""

    def __init__(self, maximum: int, *, bytes_per_worker: int = GIB) -> None:
        self.maximum = max(1, maximum)
        self.bytes_per_worker = bytes_per_worker
        self.active = 0

    @property
    def target_limit(self) -> int:
        status = memory_status()
        if status is None:
            return self.maximum
        spare = max(0, status.available - memory_reserve(status))
        return min(self.maximum, spare // self.bytes_per_worker)

    async def __aenter__(self) -> Self:
        # Free memory changes in other processes; there is no local event to await.
        while self.active >= self.target_limit:  # noqa: ASYNC110
            await asyncio.sleep(0.25)
        self.active += 1
        return self

    async def __aexit__(self, *_args: object) -> None:
        self.active -= 1

    async def run_in_thread(self, function: Callable[..., T], *args: Any) -> T:
        await self.__aenter__()
        task = asyncio.create_task(asyncio.to_thread(function, *args))

        def finished(completed: asyncio.Task[T]) -> None:
            # Cancelling an await cannot stop a native RAW decoder. Keep its
            # slot until the real thread finishes, including after cancellation.
            self.active -= 1
            if not completed.cancelled():
                completed.exception()

        task.add_done_callback(finished)
        return await asyncio.shield(task)


async def wait_for_memory() -> None:
    """Do not claim another queue task while Windows is under memory pressure."""
    while True:
        status = memory_status()
        if status is None or status.available >= memory_reserve(status):
            return
        await asyncio.sleep(0.5)
