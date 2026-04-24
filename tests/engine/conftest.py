"""Shared pytest fixtures for engine tests."""

from collections.abc import AsyncGenerator
from unittest.mock import MagicMock

import pytest
from httpx import ASGITransport, AsyncClient


def _make_mock_pipeline() -> MagicMock:
    """Create a mock PipelineManager for tests that don't need real ONNX models."""
    pipeline = MagicMock()
    pipeline.is_ready = False
    pipeline.pose_available = False
    pipeline.species_available = False
    pipeline.pipeline_version = "test-v1-00000000"
    pipeline.model_status = {
        "yolo": False,
        "bird_visibility": False,
        "clipiqa": False,
        "hyperiqa": False,
        "dinov3_backbone": False,
        "species_ensemble": False,
    }
    pipeline.model_providers = {}
    return pipeline


@pytest.fixture
async def client() -> AsyncGenerator[AsyncClient]:
    from engine.main import app

    # Inject mock pipeline to avoid loading real ONNX models
    app.state.pipeline = _make_mock_pipeline()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
