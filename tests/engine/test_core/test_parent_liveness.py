"""Unknown engine processes must never be killed by name matching."""

import signal
import subprocess
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

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
    calls = []

    def kill(pid, sig):
        calls.append((pid, sig))
        if pid == 101:
            raise ProcessLookupError

    monkeypatch.setattr(lifespan.os, "kill", kill)
    await lifespan._watch_parent(101)
    assert calls == [(101, 0), (202, signal.SIGTERM)]
