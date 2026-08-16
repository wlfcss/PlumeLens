"""Tests for real library export endpoints."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest
from anyio import Path as AsyncPath
from httpx import ASGITransport, AsyncClient, Response

MINIMAL_JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9"


def _write_file(path: Path, body: bytes = b"photo") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)


async def _await_job(client: AsyncClient, job_id: str, timeout: float = 10.0) -> dict[str, Any]:
    """轮询 job 快照直到终态。"""
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        snapshot = (await client.get(f"/export/jobs/{job_id}")).json()
        if snapshot["status"] != "running":
            return snapshot
        await asyncio.sleep(0.01)
    msg = f"export job {job_id} did not finish within {timeout}s"
    raise AssertionError(msg)


async def _await_export(client: AsyncClient, started: Response) -> dict[str, Any]:
    """POST 只返回 job 句柄 —— 等后台 worker 跑完并断言成功,返回最终 result。"""
    assert started.status_code == 200, started.text
    snapshot = await _await_job(client, started.json()["job_id"])
    assert snapshot["status"] == "succeeded", snapshot
    assert snapshot["result"] is not None
    return snapshot["result"]


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
    _write_file(root / "missing-companion.jpg", b"jpg-missing-companion")

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
        (
            "p5",
            root / "missing-companion.jpg",
            root / "missing-companion.CR3",
            "record",
            0.63,
            "灰喜鹊",
        ),
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
    # job 注册表是模块级全局 —— 不清会让"同一 library 已有导出在跑"的并发检查
    # 泄漏到后续测试。
    from engine.services import exporter as exporter_module

    exporter_module._JOBS.clear()
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

    data = await _await_export(client, response)
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

    manifest_path = AsyncPath(data["manifest"]["json"])
    manifest = json.loads(await manifest_path.read_text(encoding="utf-8"))
    assert manifest["导出摘要"]["导出布局"] == "合并导出（文件夹 / 照片）"
    assert manifest["导出摘要"]["选择评级"] == ["精选", "可用"]
    rows = manifest["照片清单"]
    assert len(rows) == 3
    assert manifest["导出摘要"]["源图库路径"] == "(已脱敏)"
    assert str(root) not in json.dumps(manifest, ensure_ascii=False)
    p1 = next(row for row in rows if row["照片ID"] == "p1")
    assert p1["源文件路径"] == "a.jpg"
    p2 = next(row for row in rows if row["照片ID"] == "p2")
    assert p2["评级"] == "可用"
    assert p2["自动评级"] == "淘汰"
    assert p2["人工决策"] == "可用"
    assert p2["源文件路径"] == "sub/b.jpg"
    assert p2["源文件夹"] == "sub"
    p4 = next(row for row in rows if row["照片ID"] == "p4")
    assert p4["错误原因"] == "源文件不存在"


async def test_export_rejects_missing_source_root(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    client, root = export_client
    await AsyncPath(root).rename(root.with_name("source-moved"))
    target = tmp_path / "exports-missing-root"

    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(target),
            "grades": ["select"],
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "source_path_missing"
    assert not await AsyncPath(target).exists()


async def test_export_recovers_path_missing_when_source_root_returns(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    client, root = export_client
    target = tmp_path / "exports-restored-root"
    moved = root.with_name("source-temporarily-moved")

    await AsyncPath(root).rename(moved)
    failed = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(target),
            "grades": ["select"],
        },
    )
    assert failed.status_code == 400
    await AsyncPath(moved).rename(root)

    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(target),
            "grades": ["select"],
            "include_manifest": False,
        },
    )

    await _await_export(client, response)
    detail = await client.get("/library/lib-export")
    assert detail.json()["library"]["status"] == "ready"


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

    data = await _await_export(client, response)
    output_dir = AsyncPath(data["output_dir"])
    assert await (output_dir / "a.jpg").read_bytes() == b"jpg-a"
    assert await (output_dir / "a.CR3").read_bytes() == b"raw-a"
    assert data["companion_count"] == 1

    manifest = json.loads(await AsyncPath(data["manifest"]["json"]).read_text(encoding="utf-8"))
    p1 = next(row for row in manifest["照片清单"] if row["照片ID"] == "p1")
    assert p1["同伴源文件路径"].endswith("a.CR3")
    assert p1["已导出同伴文件"] == "是"


async def test_export_can_generate_xmp_sidecars_next_to_exported_files(
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
            "include_xmp_sidecars": True,
            "include_manifest": True,
        },
    )

    data = await _await_export(client, response)
    output_dir = AsyncPath(data["output_dir"])
    assert data["selected_count"] == 2
    assert data["exported_count"] == 1
    assert data["companion_count"] == 1
    assert data["xmp_count"] == 1
    xmp = await (output_dir / "a.xmp").read_text(encoding="utf-8")
    assert 'xmp:Rating="5"' in xmp
    assert "须浮鸥" in xmp

    manifest = json.loads(await AsyncPath(data["manifest"]["json"]).read_text(encoding="utf-8"))
    assert manifest["导出摘要"]["生成XMP文件"] == "是"
    p1 = next(row for row in manifest["照片清单"] if row["照片ID"] == "p1")
    assert p1["已导出XMP"] == "是"
    assert p1["XMP导出路径"].endswith("a.xmp")


async def test_export_embeds_xmp_into_copied_jpeg_for_lightroom(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    client, root = export_client
    _write_file(root / "sub" / "b.jpg", MINIMAL_JPEG)

    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(tmp_path / "exports"),
            "grades": ["usable"],
            "include_companions": False,
            "include_xmp_sidecars": True,
            "include_manifest": True,
        },
    )

    data = await _await_export(client, response)
    output_dir = AsyncPath(data["output_dir"])
    assert data["selected_count"] == 1
    assert data["exported_count"] == 1
    assert data["xmp_count"] == 1

    exported_jpeg = output_dir / "sub" / "b.jpg"
    assert await exported_jpeg.exists()
    assert not await (output_dir / "sub" / "b.xmp").exists()

    jpeg_bytes = await exported_jpeg.read_bytes()
    assert b"http://ns.adobe.com/xap/1.0/\x00" in jpeg_bytes
    assert b'xmp:Rating="4"' in jpeg_bytes
    assert "翠鸟".encode() in jpeg_bytes

    manifest = json.loads(await AsyncPath(data["manifest"]["json"]).read_text(encoding="utf-8"))
    p2 = next(row for row in manifest["照片清单"] if row["照片ID"] == "p2")
    assert p2["已导出XMP"] == "是"
    assert p2["XMP导出路径"].endswith("sub/b.jpg")


async def test_export_can_generate_xmp_only_package_without_copying_photos(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    client, _ = export_client
    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(tmp_path / "exports"),
            "grades": ["usable"],
            "copy_files": False,
            "include_companions": True,
            "include_xmp_sidecars": True,
            "include_manifest": True,
        },
    )

    data = await _await_export(client, response)
    output_dir = AsyncPath(data["output_dir"])
    assert data["selected_count"] == 1
    assert data["exported_count"] == 0
    assert data["companion_count"] == 0
    assert data["xmp_count"] == 1
    assert not await (output_dir / "sub" / "b.jpg").exists()
    xmp = await (output_dir / "sub" / "b.xmp").read_text(encoding="utf-8")
    assert 'xmp:Rating="4"' in xmp
    assert "翠鸟" in xmp

    manifest = json.loads(await AsyncPath(data["manifest"]["json"]).read_text(encoding="utf-8"))
    assert manifest["导出摘要"]["复制照片文件"] == "否"
    p2 = next(row for row in manifest["照片清单"] if row["照片ID"] == "p2")
    assert p2["已导出照片"] == "否"
    assert p2["已导出XMP"] == "是"


async def test_export_rejects_empty_content_mode(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    client, _ = export_client
    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(tmp_path / "exports"),
            "copy_files": False,
            "include_xmp_sidecars": False,
        },
    )

    assert response.status_code == 422


async def test_export_rolls_back_main_file_when_explicit_companion_is_missing(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    client, _ = export_client
    response = await client.post(
        "/export/library/lib-export",
        json={
            "target_dir": str(tmp_path / "exports"),
            "grades": ["record"],
            "include_companions": True,
            "include_manifest": True,
        },
    )

    data = await _await_export(client, response)
    output_dir = AsyncPath(data["output_dir"])
    assert data["selected_count"] == 1
    assert data["exported_count"] == 0
    assert data["companion_count"] == 0
    assert data["skipped_missing"] == 1
    assert data["failed_count"] == 0
    assert not await (output_dir / "missing-companion.jpg").exists()

    manifest = json.loads(await AsyncPath(data["manifest"]["json"]).read_text(encoding="utf-8"))
    p5 = next(row for row in manifest["照片清单"] if row["照片ID"] == "p5")
    assert p5["错误原因"] == "同伴文件不存在"
    assert p5["已导出照片"] == "否"


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

    data = await _await_export(client, response)
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

    data = await _await_export(client, response)
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
    assert response.json()["detail"]["code"] == "target_inside_source"


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
    assert response.json()["detail"]["code"] == "library_not_found"


async def test_export_reports_insufficient_space_with_byte_counts(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """空间不足要带上 required/free —— 前端据此渲染"还差多少",而不是一句英文。"""
    client, _ = export_client
    from engine.services import exporter as exporter_module

    class _Usage:
        total = 1_000
        used = 999
        free = 1

    monkeypatch.setattr(exporter_module.shutil, "disk_usage", lambda _p: _Usage())

    response = await client.post(
        "/export/library/lib-export",
        json={"target_dir": str(tmp_path / "exports"), "grades": ["select"]},
    )

    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["code"] == "insufficient_space"
    assert detail["free_bytes"] == 1
    assert detail["required_bytes"] > detail["free_bytes"]
    assert not await AsyncPath(tmp_path / "exports").exists()


async def test_export_rejects_second_export_while_one_is_running(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    """同一图库只允许一个导出在跑。

    历史 bug:前端 60s 超时报"导出失败",用户重试 → 后台叠加多个导出线程并发
    写同一个卷,互相抢 IO 越跑越慢,看上去就是"一直失败"。
    """
    client, _ = export_client
    from engine.services import exporter as exporter_module

    running = exporter_module.ExportJob(
        job_id="already-running", library_id="lib-export", total=1, total_bytes=1
    )
    exporter_module._register_job(running)

    response = await client.post(
        "/export/library/lib-export",
        json={"target_dir": str(tmp_path / "exports"), "grades": ["select"]},
    )

    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "export_already_running"
    assert detail["job_id"] == "already-running"


async def test_export_progress_stream_ends_on_terminal_frame(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    client, _ = export_client
    started = await client.post(
        "/export/library/lib-export",
        json={"target_dir": str(tmp_path / "exports"), "grades": ["select"]},
    )
    assert started.status_code == 200
    job_id = started.json()["job_id"]

    frames: list[dict[str, Any]] = []
    async with client.stream("GET", f"/export/jobs/{job_id}/events") as stream:
        assert stream.status_code == 200
        async for line in stream.aiter_lines():
            if line.startswith("data: "):
                frames.append(json.loads(line[len("data: ") :]))
                if frames[-1]["status"] != "running":
                    break

    assert frames, "expected at least one SSE frame"
    terminal = frames[-1]
    assert terminal["status"] == "succeeded"
    assert terminal["job_id"] == job_id
    assert terminal["result"]["exported_count"] == 1
    assert terminal["result"]["manifest"]["json"] is not None


async def test_export_cancel_marks_job_cancelled(
    export_client: tuple[AsyncClient, Path],
    tmp_path: Path,
) -> None:
    client, _ = export_client
    from engine.services import exporter as exporter_module

    running = exporter_module.ExportJob(
        job_id="cancel-me", library_id="lib-export", total=5, total_bytes=5
    )
    exporter_module._register_job(running)

    response = await client.post("/export/jobs/cancel-me/cancel")

    assert response.status_code == 200
    assert running.is_cancelled

    missing = await client.post("/export/jobs/nope/cancel")
    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "job_not_found"


def test_estimate_drops_when_raw_companions_are_disabled(tmp_path: Path) -> None:
    """关掉 RAW 同伴后预估体积必须真的下降。

    这是"目标磁盘空间不足"时用户唯一的自救手段 —— 实测 964 张里 JPG 只占
    25 GB,配套 CR3 却有 56 GB,不给关就等于强制 3.4 倍体积。
    """
    from engine.api.schemas.export import ExportLibraryRequest
    from engine.services.exporter import ExportPhoto, _estimate_export_bytes

    root = tmp_path / "src"
    _write_file(root / "a.jpg", b"x" * 1_000)
    _write_file(root / "a.CR3", b"y" * 9_000)
    photo = ExportPhoto(
        id="p1",
        file_path=str(root / "a.jpg"),
        file_name="a.jpg",
        file_mtime="2026-05-05T09:00:00",
        exif_json=None,
        companion_path=str(root / "a.CR3"),
        decision="select",
        grade="select",
        quality_score=0.9,
        bird_count=1,
        species=None,
    )

    def _body(include_companions: bool) -> ExportLibraryRequest:
        return ExportLibraryRequest(
            target_dir=str(tmp_path / "dst"),
            grades=["select"],
            include_companions=include_companions,
        )

    with_raw = _estimate_export_bytes([photo], _body(True))
    without_raw = _estimate_export_bytes([photo], _body(False))

    assert with_raw == int(10_000 * 1.05)
    assert without_raw == int(1_000 * 1.05)
    assert without_raw < with_raw


def test_run_export_stops_at_cancel_checkpoint_without_partial_files(
    tmp_path: Path,
) -> None:
    """取消位在开跑前就置上 → 一张都不复制,且不留半截文件。

    检查点在照片之间(shutil.copy2 不可中断),所以取消永远落在文件边界上 ——
    产出要么是完整文件,要么根本不存在。
    """
    from engine.api.schemas.export import ExportLibraryRequest
    from engine.services.exporter import ExportJob, ExportPhoto, _run_export

    root = tmp_path / "src"
    _write_file(root / "a.jpg", b"jpg-a")
    _write_file(root / "b.jpg", b"jpg-b")
    photos = [
        ExportPhoto(
            id=f"p{i}",
            file_path=str(root / name),
            file_name=name,
            file_mtime="2026-05-05T09:00:00",
            exif_json=None,
            companion_path=None,
            decision="select",
            grade="select",
            quality_score=0.9,
            bird_count=1,
            species=None,
        )
        for i, name in enumerate(("a.jpg", "b.jpg"))
    ]
    target = tmp_path / "dst"
    job = ExportJob(job_id="j", library_id="lib", total=2, total_bytes=0)
    job.cancel()

    result = _run_export(
        library_id="lib",
        library_name="Lib",
        root_path=str(root),
        target_dir=str(target),
        photos=photos,
        body=ExportLibraryRequest(target_dir=str(target), grades=["select"]),
        job=job,
    )

    assert result.exported_count == 0
    output_dir = Path(result.output_dir)
    copied = [p for p in output_dir.rglob("*") if p.is_file() and p.suffix == ".jpg"]
    assert copied == []
    manifest = json.loads(Path(result.manifest.json_path or "").read_text(encoding="utf-8"))
    assert manifest["导出摘要"]["任务状态"] == "已取消（仅含取消前已导出的部分）"
