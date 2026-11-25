"""Auth guard tests for the local engine API."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient


def test_create_app_requires_api_token_when_guard_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    from engine.core.config import settings
    from engine.main import create_app

    monkeypatch.setattr(settings, "require_api_token", True)
    monkeypatch.setattr(settings, "api_token", None)

    with pytest.raises(RuntimeError, match="PLUMELENS_API_TOKEN"):
        create_app()


async def test_auth_guard_disables_query_token_in_production_and_allows_in_dev(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from engine.core.config import settings
    from engine.main import create_app

    monkeypatch.setattr(settings, "require_api_token", True)
    monkeypatch.setattr(settings, "api_token", "secret-token")
    app = create_app()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        missing = await client.get("/health")
        bearer = await client.get("/health", headers={"Authorization": "Bearer secret-token"})
        header = await client.get("/health", headers={"X-PlumeLens-Token": "secret-token"})
        query_prod = await client.get("/health?token=secret-token")

    assert missing.status_code == 401
    assert bearer.status_code == 200
    assert header.status_code == 200
    assert query_prod.status_code == 401

    # Dev shell (require_api_token=False) still supports legacy EventSource ?token= fallback.
    monkeypatch.setattr(settings, "require_api_token", False)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        query_dev = await client.get("/health?token=secret-token")
    assert query_dev.status_code == 200
