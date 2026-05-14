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


async def test_auth_guard_accepts_bearer_and_legacy_query_token(
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
        query = await client.get("/health?token=secret-token")

    assert missing.status_code == 401
    assert bearer.status_code == 200
    assert query.status_code == 200
