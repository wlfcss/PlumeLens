"""Shared pytest fixtures for engine tests."""

from collections.abc import AsyncGenerator
from pathlib import Path

import pytest
from engine.core.config import Settings
from engine.pipeline.manager import PipelineManager
from httpx import ASGITransport, AsyncClient


@pytest.fixture
async def client(tmp_path: Path) -> AsyncGenerator[AsyncClient]:
    """Isolated FastAPI app with a real uninitialized PipelineManager (no model I/O)."""
    from engine.main import create_app

    app = create_app()
    app.state.pipeline = PipelineManager(
        Settings(data_dir=tmp_path, models_dir=tmp_path / "models")
    )

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
