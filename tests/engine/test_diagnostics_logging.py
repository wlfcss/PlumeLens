"""Tests for privacy-safe engine logging, hot toggle, anonymization, and db-summary."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import structlog
from engine.core.database import Database
from engine.core.logging import (
    anonymize_filename,
    get_logging_state,
    reconfigure_logging,
    redact_text,
    setup_logging,
)
from engine.main import create_app
from fastapi.testclient import TestClient


def test_anonymize_filename_deterministic_and_pair_aligned() -> None:
    device_id = "pl-0123456789abcdef01234567"
    jpg = anonymize_filename("/Users/alice/Photos/5Y3A7448.JPG", device_id)
    cr3 = anonymize_filename("C:\\Users\\alice\\Photos\\5Y3A7448.CR3", device_id)

    assert jpg.startswith("f_")
    assert jpg.endswith(".jpg")
    assert cr3.endswith(".cr3")
    assert jpg[:14] == cr3[:14]
    assert "5Y3A7448" not in jpg
    assert "alice" not in jpg


def test_redact_text_strips_secrets_home_and_photo_paths() -> None:
    device_id = "pl-abcdef0123456789abcdef01"
    raw = (
        "Authorization: Bearer tok_secret_9876543210 "
        "https://restapi.amap.com/v3/geocode?key=AMAP12345678&loc=1,2 "
        "path=/Users/photographer/Trip/5Y3A1234.NEF"
    )
    cleaned = redact_text(raw, device_id=device_id)
    assert "tok_secret_9876543210" not in cleaned
    assert "AMAP12345678" not in cleaned
    assert "photographer" not in cleaned
    assert "5Y3A1234" not in cleaned
    assert "Bearer [REDACTED]" in cleaned
    assert "<photo>/f_" in cleaned


def test_redact_text_handles_windows_json_escaped_and_spaces() -> None:
    device_id = "pl-abcdef0123456789abcdef01"
    raw = (
        '{"file":"C:\\\\Users\\\\Alice\\\\Bird Photos\\\\IMG 001.CR3",'
        '"other":"C:/Users/Alice/DCIM/IMG_002.JPG",'
        '"dir":"C:\\\\Users\\\\Alice\\\\AppData"}'
    )
    cleaned = redact_text(raw, device_id=device_id)
    assert "Alice" not in cleaned
    assert "Bird Photos" not in cleaned
    assert "IMG 001" not in cleaned
    assert "IMG_002" not in cleaned
    assert cleaned.count("<photo>/f_") == 2


@pytest.mark.asyncio
async def test_runtime_identity_survives_across_async_tasks_after_reconfigure(
    tmp_path: Path,
) -> None:
    import asyncio

    logs_dir = tmp_path / "logs"
    setup_logging(log_level="INFO", logs_dir=logs_dir, enabled=False)
    try:
        reconfigure_logging(
            enabled=True,
            device_id="pl-333333333333333333333333",
            session_id="sess_cross_task",
        )

        async def worker_task() -> None:
            structlog.contextvars.clear_contextvars()
            structlog.stdlib.get_logger("test.worker").info("cross_task_event")

        await asyncio.create_task(worker_task())
        lines = (logs_dir / "engine.jsonl").read_text(encoding="utf-8").strip().splitlines()
        parsed = [json.loads(line) for line in lines]
        rec = next(item for item in parsed if item["event"] == "cross_task_event")
        assert rec["device_id"] == "pl-333333333333333333333333"
        assert rec["session_id"] == "sess_cross_task"
    finally:
        reconfigure_logging(enabled=False)


def test_pipeline_version_invariant_to_logging_and_session_settings() -> None:
    from engine.core.config import Settings
    from engine.pipeline.manager import PipelineManager

    m1 = PipelineManager(
        Settings(
            _env_file=None,
            logging_enabled=False,
            device_id=None,
            session_id="sess_a",
        )
    )
    m2 = PipelineManager(
        Settings(
            _env_file=None,
            logging_enabled=True,
            device_id="pl-444444444444444444444444",
            session_id="sess_b",
        )
    )
    v1 = m1._compute_version({})
    v2 = m2._compute_version({})
    assert v1 == v2
    params = m2.version_descriptor["parameters"]
    assert "session_id" not in params
    assert "device_id" not in params
    assert "logging_enabled" not in params


def test_logging_hot_toggle_and_redaction_in_jsonl(tmp_path: Path) -> None:
    logs_dir = tmp_path / "logs"
    setup_logging(
        log_level="INFO",
        logs_dir=logs_dir,
        enabled=False,
        device_id="pl-111111111111111111111111",
        session_id="sess_hot",
    )
    log = structlog.stdlib.get_logger("test.hot")
    log.info("before_enable_should_not_write")
    assert not (logs_dir / "engine.jsonl").exists()

    state = reconfigure_logging(enabled=True, log_level="DEBUG")
    assert state["enabled"] is True
    assert state["level"] == "DEBUG"

    log.info(
        "after_enable_event",
        api_token="super_secret_token_xyz",
        photo_path="/Users/demo/DCIM/DSC_9999.ARW",
    )
    reconfigure_logging(enabled=False)
    assert get_logging_state()["enabled"] is False

    log.info("after_disable_should_not_write")

    lines = (logs_dir / "engine.jsonl").read_text(encoding="utf-8").strip().splitlines()
    parsed = [json.loads(line) for line in lines]
    events = [item["event"] for item in parsed]
    assert "after_enable_event" in events
    assert "before_enable_should_not_write" not in events
    assert "after_disable_should_not_write" not in events

    target = next(item for item in parsed if item["event"] == "after_enable_event")
    assert target["device_id"] == "pl-111111111111111111111111"
    assert target["session_id"] == "sess_hot"
    assert target["api_token"] == "[REDACTED]"
    assert "DSC_9999" not in str(target["photo_path"])
    assert "<photo>/f_" in str(target["photo_path"])


@pytest.mark.asyncio
async def test_diagnostics_db_summary_and_logging_endpoint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from engine.core.config import settings

    monkeypatch.setattr(settings, "data_dir", tmp_path)
    setup_logging(log_level="INFO", logs_dir=tmp_path / "logs", enabled=False)

    db = Database(tmp_path / "plumelens.db")
    await db.connect()
    try:
        async with db.transaction() as conn:
            await conn.execute(
                "INSERT INTO libraries "
                "(id, display_name, parent_path, root_path, status, created_at, last_opened_at) "
                "VALUES ('lib1', 'SecretFolder', '/Users/secret', '/Users/secret/BirdsTrip', "
                "'ready', '2026-11-24T00:00:00Z', '2026-11-24T00:00:00Z')"
            )
            await conn.execute(
                "INSERT INTO photos "
                "(id, library_id, file_path, file_name, format, file_size, file_mtime, "
                "file_hash, created_at) "
                "VALUES ('p1', 'lib1', '/Users/secret/BirdsTrip/IMG_0001.CR3', 'IMG_0001.CR3', "
                "'cr3', 1024, '2026-11-24T00:00:00Z', 'abc123', '2026-11-24T00:00:00Z')"
            )

        app = create_app()
        app.state.db = db
        client = TestClient(app)

        resp = client.get("/diagnostics/db-summary")
        assert resp.status_code == 200
        body = resp.json()
        serialized = json.dumps(body)

        assert body["libraries"]["total"] == 1
        assert body["photos"]["total"] == 1
        assert body["photos"]["by_format"]["cr3"] == 1
        # Must never leak paths, filenames, or user folder names.
        assert "BirdsTrip" not in serialized
        assert "SecretFolder" not in serialized
        assert "IMG_0001" not in serialized

        toggle = client.post(
            "/settings/logging",
            json={"enabled": True, "level": "DEBUG", "device_id": "pl-222222222222222222222222"},
        )
        assert toggle.status_code == 200
        assert toggle.json()["enabled"] is True
        assert toggle.json()["level"] == "DEBUG"
    finally:
        reconfigure_logging(enabled=False)
        await db.close()
