import asyncio

import pytest
from engine.core import windows_resources
from engine.core.windows_resources import MemoryStatus, recommended_workers


@pytest.mark.parametrize(
    ("gib", "native", "cpus", "expected"),
    [(8, True, 16, 1), (16, True, 16, 2), (32, True, 16, 3), (32, False, 16, 2), (32, True, 2, 1)],
)
def test_worker_defaults_respect_memory_and_cpu(gib, native, cpus, expected):
    assert recommended_workers(gib * 1024**3, native, cpus) == expected


async def test_memory_pressure_waits_before_admitting_more_photos(monkeypatch):
    statuses = iter([MemoryStatus(32 * 1024**3, 1024**3), MemoryStatus(32 * 1024**3, 12 * 1024**3)])
    monkeypatch.setattr(windows_resources, "memory_status", lambda: next(statuses))
    sleeps = []

    async def sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(windows_resources.asyncio, "sleep", sleep)
    await windows_resources.wait_for_memory()
    assert sleeps == [0.5]


async def test_memory_pressure_wait_is_cancellable(monkeypatch):
    monkeypatch.setattr(
        windows_resources, "memory_status", lambda: MemoryStatus(32 * 1024**3, 1024**3)
    )
    task = asyncio.create_task(windows_resources.wait_for_memory())
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_all_libraries_share_the_same_decode_limit(monkeypatch):
    import threading
    import time
    from types import SimpleNamespace

    from engine.core.config import Settings
    from engine.pipeline.manager import PipelineManager

    manager = PipelineManager(Settings(analysis_concurrency=2))
    manager._detector = object()
    active = 0
    peak = 0
    lock = threading.Lock()

    def analyze(*_args):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(active, peak)
        time.sleep(0.02)
        with lock:
            active -= 1
        return SimpleNamespace(duration_ms=0)

    monkeypatch.setattr(manager, "_analyze_sync", analyze)
    await asyncio.gather(*(manager.analyze(None, f"library-{index % 4}") for index in range(12)))
    assert peak == 2


@pytest.mark.parametrize(
    ("gib", "cpus", "expected"),
    [(8, 2, (1, 1, 2, 1)), (16, 8, (2, 2, 4, 4)), (32, 16, (3, 4, 8, 4))],
)
def test_each_pipeline_scales_with_hardware(monkeypatch, gib, cpus, expected):
    from engine.core.config import Settings

    monkeypatch.setattr(
        windows_resources, "memory_status", lambda: MemoryStatus(gib * 1024**3, 7 * 1024**3)
    )
    monkeypatch.setattr(windows_resources, "logical_cpus", lambda: cpus)
    # This test covers CPU/RAM policy without depending on the host GPU.
    monkeypatch.setitem(windows_resources.sys.modules, "torch", None)
    settings = Settings(_env_file=None)
    windows_resources.configure_windows(settings)
    report = windows_resources.configure_windows(settings, native_gpu=True)
    assert tuple(report["configuration"].values()) == expected
    assert not settings.model_fields_set


def test_manual_limits_survive_provider_aware_refinement(monkeypatch):
    from engine.core.config import Settings

    monkeypatch.setattr(
        windows_resources, "memory_status", lambda: MemoryStatus(32 * 1024**3, 16 * 1024**3)
    )
    settings = Settings(analysis_concurrency=1, thumbnail_concurrency=2, onnx_threads=2)
    windows_resources.configure_windows(settings)
    report = windows_resources.configure_windows(settings, native_gpu=True)
    assert settings.analysis_concurrency == 1
    assert settings.thumbnail_concurrency == 2
    assert settings.onnx_threads == 2
    assert report["manual_overrides"] == [
        "analysis_concurrency",
        "onnx_threads",
        "thumbnail_concurrency",
    ]


async def test_memory_limiter_reduces_and_recovers_concurrency(monkeypatch):
    available = 6 * 1024**3
    monkeypatch.setattr(
        windows_resources, "memory_status", lambda: MemoryStatus(32 * 1024**3, available)
    )
    limiter = windows_resources.MemoryBoundLimiter(3)
    entered = []
    release = asyncio.Event()

    async def work(index):
        async with limiter:
            entered.append(index)
            await release.wait()

    tasks = [asyncio.create_task(work(index)) for index in range(3)]
    await asyncio.sleep(0.05)
    assert limiter.active == len(entered) == 1
    available = 16 * 1024**3
    await asyncio.sleep(0.3)
    assert limiter.active == len(entered) == 3
    release.set()
    await asyncio.gather(*tasks)
    assert limiter.active == 0


async def test_waiting_for_a_memory_slot_is_cancellable(monkeypatch):
    monkeypatch.setattr(
        windows_resources, "memory_status", lambda: MemoryStatus(8 * 1024**3, 1024**3)
    )
    limiter = windows_resources.MemoryBoundLimiter(2)
    task = asyncio.create_task(limiter.__aenter__())
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert limiter.active == 0


async def test_cancelling_a_caller_keeps_the_native_decode_slot_until_thread_finishes(monkeypatch):
    import threading

    monkeypatch.setattr(windows_resources, "memory_status", lambda: None)
    limiter = windows_resources.MemoryBoundLimiter(1)
    started, release = threading.Event(), threading.Event()
    second_started = []

    def decode():
        started.set()
        assert release.wait(5)

    first = asyncio.create_task(limiter.run_in_thread(decode))
    assert await asyncio.to_thread(started.wait, 2)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    second = asyncio.create_task(limiter.run_in_thread(lambda: second_started.append(True)))
    try:
        await asyncio.sleep(0.05)
        assert limiter.active == 1
        assert not second_started
    finally:
        release.set()
        await second
    assert limiter.active == 0
