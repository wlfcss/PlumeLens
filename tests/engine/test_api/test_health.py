"""Health endpoint tests."""

import json
import tomllib
from pathlib import Path

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_health_returns_ok(client: AsyncClient) -> None:
    response = await client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert "version" in data


def _release_versions() -> set[str]:
    root = Path(__file__).resolve().parents[3]
    package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    npm_lock = json.loads((root / "package-lock.json").read_text(encoding="utf-8"))
    project = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
    uv_lock = tomllib.loads((root / "uv.lock").read_text(encoding="utf-8"))
    engine_package = next(item for item in uv_lock["package"] if item["name"] == "plumelens-engine")
    return {
        package["version"],
        npm_lock["version"],
        npm_lock["packages"][""]["version"],
        project["project"]["version"],
        engine_package["version"],
    }


@pytest.mark.asyncio
async def test_runtime_and_locked_package_versions_agree(client: AsyncClient) -> None:
    response = await client.get("/health")

    assert response.status_code == 200
    assert _release_versions() == {response.json()["version"]}


@pytest.mark.asyncio
async def test_health_includes_pipeline_status(client: AsyncClient) -> None:
    response = await client.get("/health")
    data = response.json()
    assert "pipeline" in data
    pipeline = data["pipeline"]
    assert "ready" in pipeline
    assert "version" in pipeline
    assert "models" in pipeline
    assert "quality_available" in pipeline
    assert "pose_available" in pipeline
    assert "species_available" in pipeline
    # Mock pipeline is not ready; enhancements unavailable
    assert pipeline["ready"] is False
    assert pipeline["quality_available"] is False
    assert pipeline["pose_available"] is False
    assert pipeline["species_available"] is False


@pytest.mark.asyncio
async def test_health_lists_current_model_slots(client: AsyncClient) -> None:
    response = await client.get("/health")
    data = response.json()
    models = data["pipeline"]["models"]
    assert set(models.keys()) == {
        "yolo",
        "bird_visibility",
        "bird_flight_classifier",
        "clipiqa",
        "hyperiqa",
        "dinov3_species_v4",
    }
