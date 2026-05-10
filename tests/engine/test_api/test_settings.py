"""Settings and local maintenance endpoint tests."""

from pathlib import Path

import pytest
from engine.core.database import Database
from engine.services.thumbnail import thumbnail_cache_root
from httpx import ASGITransport, AsyncClient

MODELS_DIR = Path(__file__).resolve().parents[3] / "engine" / "models"


@pytest.fixture
async def settings_client(tmp_path: Path):
    from engine.core.config import settings
    from engine.main import app

    old_data_dir = settings.data_dir
    old_models_dir = settings.models_dir
    settings.data_dir = tmp_path
    settings.models_dir = MODELS_DIR

    db = Database(tmp_path / "settings.db")
    await db.connect()
    app.state.db = db
    app.state.pipeline = type(
        "PipelineStub",
        (),
        {
            "pipeline_version": "v1-test",
            "model_status": {
                "yolo": True,
                "bird_visibility": True,
                "bird_flight_classifier": True,
                "clipiqa": False,
                "hyperiqa": False,
                "dinov3_species_v4": False,
            },
            "model_providers": {"yolo": "CPUExecutionProvider"},
        },
    )()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        try:
            yield client, db, tmp_path
        finally:
            await db.close()
            settings.data_dir = old_data_dir
            settings.models_dir = old_models_dir


@pytest.mark.asyncio
async def test_model_versions_come_from_manifest(settings_client) -> None:
    client, _, _ = settings_client

    response = await client.get("/settings/models")
    assert response.status_code == 200
    data = response.json()

    assert data["pipeline_version"] == "v1-test"
    yolo = next(model for model in data["models"] if model["id"] == "yolo")
    assert yolo["version"] == "v1.1"
    assert yolo["loaded"] is True
    assert len(yolo["revision"]) == 12


@pytest.mark.asyncio
async def test_clear_history_requires_confirmation(settings_client) -> None:
    client, _, _ = settings_client

    response = await client.post("/settings/history/clear", json={"confirm": False})

    assert response.status_code == 400


@pytest.mark.asyncio
async def test_clear_history_rejects_when_workers_are_still_stopping(
    settings_client,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, _, _ = settings_client
    from engine.api.routes import analysis

    async def fake_cancel_all_workers() -> bool:
        return False

    monkeypatch.setattr(analysis, "cancel_all_workers", fake_cancel_all_workers)

    response = await client.post("/settings/history/clear", json={"confirm": True})

    assert response.status_code == 409


@pytest.mark.asyncio
async def test_clear_history_removes_app_owned_records(settings_client) -> None:
    client, db, tmp_path = settings_client
    await db.conn.execute(
        "INSERT INTO libraries (id, display_name, parent_path, root_path, status, recursive, "
        "created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("lib-1", "测试库", str(tmp_path), str(tmp_path / "src"), "ready", 1, "now", "now"),
    )
    await db.conn.execute(
        "INSERT INTO photos (id, file_path, file_name, file_size, file_mtime, created_at, "
        "library_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("photo-1", str(tmp_path / "src" / "a.jpg"), "a.jpg", 1, "now", "now", "lib-1"),
    )
    await db.conn.execute(
        "INSERT INTO analysis_results (id, photo_id, pipeline_version, result_json, grade, "
        "bird_count, created_at, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("result-1", "photo-1", "v1", "{}", "usable", 1, "now", 1),
    )
    await db.conn.execute(
        "INSERT INTO photo_decisions (photo_id, decision, updated_at) VALUES (?, ?, ?)",
        ("photo-1", "usable", "now"),
    )
    await db.conn.execute(
        "INSERT INTO photo_species_overrides "
        "(photo_id, bird_index, canonical_sci, updated_at) VALUES (?, ?, ?, ?)",
        ("photo-1", 0, "Ardea cinerea", "now"),
    )
    await db.conn.execute(
        "INSERT INTO task_queue (id, photo_id, library_id, status, created_at) "
        "VALUES (?, ?, ?, ?, ?)",
        ("task-1", "photo-1", "lib-1", "pending", "now"),
    )
    await db.conn.commit()

    thumb = thumbnail_cache_root(tmp_path) / "grid" / "photo-1.jpg"
    thumb.parent.mkdir(parents=True)
    thumb.write_bytes(b"thumb")

    response = await client.post("/settings/history/clear", json={"confirm": True})
    assert response.status_code == 200
    data = response.json()

    assert data["libraries_deleted"] == 1
    assert data["photos_deleted"] == 1
    assert data["analysis_results_deleted"] == 1
    assert data["decisions_deleted"] == 1
    assert data["species_overrides_deleted"] == 1
    assert data["tasks_deleted"] == 1
    assert data["thumbnails_deleted"] is True
    assert not thumbnail_cache_root(tmp_path).exists()

    async with db.conn.execute("SELECT COUNT(*) AS c FROM libraries") as cur:
        row = await cur.fetchone()
    assert int(row["c"]) == 0
