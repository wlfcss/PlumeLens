"""Health endpoint tests."""

import json
import tomllib
from pathlib import Path

from engine.main import create_app
from httpx import ASGITransport, AsyncClient


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


async def test_runtime_and_locked_package_versions_agree(client: AsyncClient) -> None:
    response = await client.get("/health")

    assert response.status_code == 200
    assert _release_versions() == {response.json()["version"]}


async def test_health_reflects_real_pipeline_manager_slots(client: AsyncClient) -> None:
    response = await client.get("/health")
    data = response.json()
    pipeline = data["pipeline"]
    assert pipeline["ready"] is False
    assert pipeline["quality_available"] is False
    assert pipeline["pose_available"] is False
    assert pipeline["species_available"] is False
    assert set(pipeline["models"].keys()) == {
        "yolo",
        "bird_visibility",
        "bird_flight_classifier",
        "clipiqa",
        "hyperiqa",
        "dinov3_species_v4",
    }


async def test_health_before_pipeline_attach_returns_unready() -> None:
    app = create_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        response = await ac.get("/health")
    assert response.status_code == 200
    pipeline = response.json()["pipeline"]
    assert pipeline["ready"] is False
    assert pipeline["models"] == {}
