"""Tests for real library export endpoints."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from anyio import Path as AsyncPath
from httpx import ASGITransport, AsyncClient


def _write_file(path: Path, body: bytes = b"photo") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)


@pytest.fixture
async def export_client(tmp_path: Path):
    from engine.core.config import settings
    from engine.core.database import Database
    from engine.main import create_app

    settings.data_dir = tmp_path
    app = create_app()
    db = Database(tmp_path / "export.db")
    await db.connect()
    app.state.db = db
    app.state.pipeline = MagicMock()

    root = tmp_path / "source"
    _write_file(root / "a.jpg", b"jpg-a")
    _write_file(root / "a.CR3", b"raw-a")
    _write_file(root / "sub" / "b.jpg", b"jpg-b")
    _write_file(root / "reject.jpg", b"jpg-reject")

    await db.conn.execute(
        "INSERT INTO libraries "
        "(id, display_name, parent_path, root_path, created_at, last_opened_at) "
        "VALUES ('lib-export', 'Export Test', ?, ?, '2026-05-05', '2026-05-05')",
        (str(tmp_path), str(root)),
    )
    photos = [
        ("p1", root / "a.jpg", None, "select", 0.91, "须浮鸥"),
        ("p2", root / "sub" / "b.jpg", None, "reject", 0.72, "翠鸟"),
        ("p3", root / "reject.jpg", None, "reject", 0.2, "白鹭"),
        ("p4", root / "missing.jpg", None, "select", 0.8, "苍鹭"),
    ]
    for idx, (pid, path, companion, grade, score, species) in enumerate(photos):
        await db.conn.execute(
            "INSERT INTO photos (id, file_path, file_name, file_size, file_mtime, file_hash, "
            "exif_json, companion_path, created_at, library_id) "
            "VALUES (?, ?, ?, 100, ?, ?, ?, ?, '2026-05-05', 'lib-export')",
            (
                pid,
                str(path),
                path.name,
                f"2026-05-05T09:0{idx}:00",
                f"hash-{pid}",
                json.dumps({"DateTimeOriginal": f"2026:05:05 09:0{idx}:00"}),
                str(companion) if companion is not None else None,
            ),
        )
        await db.conn.execute(
            "INSERT INTO analysis_results (id, photo_id, pipeline_version, result_json, "
            "quality_score, grade, bird_count, species, created_at, is_active) "
            "VALUES (?, ?, 'v1', ?, ?, ?, 1, ?, '2026-05-05', 1)",
            (
                f"ar-{pid}",
                pid,
                json.dumps({"bird_count": 1, "best": None, "detections": []}),
                score,
                grade,
                species,
            ),
        )
    await db.conn.execute(
        "INSERT INTO photo_decisions (photo_id, decision, updated_at) "
        "VALUES ('p2', 'usable', '2026-05-05')"
    )
    await db.conn.commit()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, root
    await db.close()


async def test_export_copies_selected_photos_companions_and_manifest(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    client, root = export_client
    target = tmp_path / "exports"
    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(target),
            "grades": ["select", "usable"],
            "min_score": 50,
            "include_companions": True,
            "preserve_structure": True,
            "include_manifest": True,
        },
    )

    assert response.status_code == 200
    data = response.json()
    assert data["selected_count"] == 3
    assert data["exported_count"] == 2
    assert data["companion_count"] == 1
    assert data["skipped_missing"] == 1
    assert data["failed_count"] == 0

    output_dir = AsyncPath(data["output_dir"])
    assert await output_dir.is_dir()
    assert await (output_dir / "a.jpg").read_bytes() == b"jpg-a"
    assert await (output_dir / "a.CR3").read_bytes() == b"raw-a"
    assert await (output_dir / "sub" / "b.jpg").read_bytes() == b"jpg-b"
    assert not await (output_dir / "reject.jpg").exists()
    assert await AsyncPath(root / "a.jpg").read_bytes() == b"jpg-a"

    manifest_path = AsyncPath(data["manifest"]["json"])
    manifest = json.loads(await manifest_path.read_text(encoding="utf-8"))
    assert manifest["导出摘要"]["导出布局"] == "合并导出（文件夹 / 照片）"
    assert manifest["导出摘要"]["选择评级"] == ["精选", "可用"]
    rows = manifest["照片清单"]
    assert len(rows) == 3
    p2 = next(row for row in rows if row["照片ID"] == "p2")
    assert p2["评级"] == "可用"
    assert p2["自动评级"] == "淘汰"
    assert p2["人工决策"] == "可用"
    p4 = next(row for row in rows if row["照片ID"] == "p4")
    assert p4["错误原因"] == "源文件不存在"


async def test_export_discovers_same_stem_raw_when_companion_metadata_missing(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    client, _ = export_client
    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(tmp_path / "exports"),
            "grades": ["select"],
            "include_companions": True,
            "include_manifest": True,
        },
    )

    assert response.status_code == 200
    data = response.json()
    output_dir = AsyncPath(data["output_dir"])
    assert await (output_dir / "a.jpg").read_bytes() == b"jpg-a"
    assert await (output_dir / "a.CR3").read_bytes() == b"raw-a"
    assert data["companion_count"] == 1

    manifest = json.loads(await AsyncPath(data["manifest"]["json"]).read_text(encoding="utf-8"))
    p1 = next(row for row in manifest["照片清单"] if row["照片ID"] == "p1")
    assert p1["同伴源文件路径"].endswith("a.CR3")
    assert p1["已导出同伴文件"] == "是"


async def test_export_uses_updated_library_alias_for_output_folder(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    client, _ = export_client
    renamed = await client.patch(
        "/library/lib-export",
        json={"display_name": "洋湖湿地早晨"},
    )
    assert renamed.status_code == 200

    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(tmp_path / "exports"),
            "grades": ["select"],
            "include_manifest": True,
        },
    )

    assert response.status_code == 200
    data = response.json()
    output_dir = AsyncPath(data["output_dir"])
    assert output_dir.name.startswith("洋湖湿地早晨-")

    manifest = json.loads(await AsyncPath(data["manifest"]["json"]).read_text(encoding="utf-8"))
    assert manifest["导出摘要"]["图库名称"] == "洋湖湿地早晨"


async def test_export_can_insert_grade_folders_under_source_folders(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    client, _ = export_client
    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(tmp_path / "exports"),
            "grades": ["select", "usable"],
            "include_companions": True,
            "layout": "by_grade",
            "preserve_structure": True,
            "include_manifest": True,
        },
    )

    assert response.status_code == 200
    data = response.json()
    output_dir = AsyncPath(data["output_dir"])
    assert await (output_dir / "精选" / "a.jpg").read_bytes() == b"jpg-a"
    assert await (output_dir / "精选" / "a.CR3").read_bytes() == b"raw-a"
    assert await (output_dir / "sub" / "可用" / "b.jpg").read_bytes() == b"jpg-b"
    assert not await (output_dir / "sub" / "b.jpg").exists()

    manifest = json.loads(await AsyncPath(data["manifest"]["json"]).read_text(encoding="utf-8"))
    assert manifest["导出摘要"]["导出布局"] == "按评级分类（文件夹 / 评级 / 照片）"
    p2 = next(row for row in manifest["照片清单"] if row["照片ID"] == "p2")
    assert p2["导出相对路径"] == "sub/可用/b.jpg"


async def test_export_rejects_target_inside_source_library(
    export_client: tuple[AsyncClient, Path],
) -> None:
    client, root = export_client
    response = await client.post(
        "/export/library/lib-export",
        json={"target_dir": str(root / "exports")},
    )

    assert response.status_code == 400
    assert "source library" in response.json()["detail"]


async def test_export_unknown_library_returns_404(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    client, _ = export_client
    response = await client.post(
        "/export/library/missing",
        json={"target_dir": str(tmp_path / "exports")},
    )

    assert response.status_code == 404
