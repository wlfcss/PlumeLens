"""The engine must reach lifespan cleanup even while SSE clients remain connected."""

from unittest.mock import Mock

from engine.__main__ import main
from pytest import MonkeyPatch


def test_entrypoint_bounds_connection_shutdown(monkeypatch: MonkeyPatch) -> None:
    run = Mock()
    monkeypatch.setenv("PLUMELENS_HOST", "127.0.0.1")
    monkeypatch.setenv("PLUMELENS_PORT", "54321")
    monkeypatch.setenv("PLUMELENS_LOG_LEVEL", "info")
    monkeypatch.setattr("uvicorn.run", run)

    main()

    run.assert_called_once_with(
        "engine.main:app",
        host="127.0.0.1",
        port=54321,
        log_level="info",
        access_log=False,
        workers=1,
        timeout_graceful_shutdown=3,
    )
