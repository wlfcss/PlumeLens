"""Health endpoint tests."""

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_health_returns_ok(client: AsyncClient) -> None:
    response = await client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert "version" in data


@pytest.mark.asyncio
async def test_health_includes_pipeline_status(client: AsyncClient) -> None:
    response = await client.get("/health")
    data = response.json()
    assert "pipeline" in data
    pipeline = data["pipeline"]
    assert "ready" in pipeline
    assert "version" in pipeline
    assert "models" in pipeline
    assert "pose_available" in pipeline
    assert "species_available" in pipeline
    # Mock pipeline is not ready; enhancements unavailable
    assert pipeline["ready"] is False
    assert pipeline["pose_available"] is False
    assert pipeline["species_available"] is False


@pytest.mark.asyncio
async def test_health_lists_all_six_models(client: AsyncClient) -> None:
    response = await client.get("/health")
    data = response.json()
    models = data["pipeline"]["models"]
    assert set(models.keys()) == {
        "yolo",
        "bird_visibility",
        "clipiqa",
        "hyperiqa",
        "dinov3_backbone",
        "species_ensemble",
    }
