"""Unknown engine processes must never be killed by name matching."""

import asyncio
import signal
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from engine.core import lifespan


def test_unknown_process_diagnostics_never_signal_other_instances(monkeypatch):
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=0,
            stdout="101\n202\n303\n",
        ),
    )
    kill = MagicMock()
    monkeypatch.setattr(lifespan.os, "kill", kill)
    assert lifespan._diagnose_other_engines(202) == [101, 303]
    kill.assert_not_called()


async def test_missing_owner_only_requests_own_graceful_shutdown(monkeypatch):
    monkeypatch.setattr(lifespan.asyncio, "sleep", AsyncMock())
    monkeypatch.setattr(lifespan.os, "getpid", lambda: 202)
    probe = MagicMock(return_value=False)
    monkeypatch.setattr(lifespan, "_is_process_alive", probe)
    kill = MagicMock()
    monkeypatch.setattr(lifespan.os, "kill", kill)
    shutdown = MagicMock()
    monkeypatch.setattr(lifespan.signal, "raise_signal", shutdown)
    await lifespan._watch_parent(101)
    probe.assert_called_once_with(101)
    kill.assert_not_called()
    shutdown.assert_called_once_with(signal.SIGTERM)


@pytest.mark.parametrize("probe_result", [True, PermissionError()])
async def test_live_or_inaccessible_owner_is_never_signalled(monkeypatch, probe_result):
    monkeypatch.setattr(
        lifespan.asyncio, "sleep", AsyncMock(side_effect=[None, asyncio.CancelledError()])
    )
    probe = MagicMock(return_value=True)
    if isinstance(probe_result, Exception):
        probe.side_effect = probe_result
    monkeypatch.setattr(lifespan, "_is_process_alive", probe)
    kill = MagicMock()
    monkeypatch.setattr(lifespan.os, "kill", kill)
    with pytest.raises(asyncio.CancelledError):
        await lifespan._watch_parent(101)
    kill.assert_not_called()


@pytest.mark.skipif(sys.platform != "win32", reason="Windows liveness regression")
def test_windows_probe_preserves_live_process_and_detects_exit(monkeypatch):
    with subprocess.Popen(
        [
            getattr(sys, "_base_executable", sys.executable),
            "-u",
            "-c",
            "import time; print('ready'); time.sleep(30)",
        ],
        stdout=subprocess.PIPE,
        text=True,
    ) as child:
        try:
            assert child.stdout is not None
            assert child.stdout.readline().strip() == "ready"
            kill = MagicMock(side_effect=AssertionError("Liveness must not use os.kill"))
            monkeypatch.setattr(lifespan.os, "kill", kill)
            for _ in range(3):
                assert lifespan._is_process_alive(child.pid)
                assert child.poll() is None
            kill.assert_not_called()
        finally:
            child.terminate()
            child.wait(timeout=5)
        assert not lifespan._is_process_alive(child.pid)
