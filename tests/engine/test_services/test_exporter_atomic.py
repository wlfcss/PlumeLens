"""Export publication and frozen-input regressions use temporary files only."""

# ruff: noqa: ASYNC240 -- tiny local fixture files; no production IO runs on the event loop.

from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
from pathlib import Path

import pytest
from engine.api.schemas.export import ExportLibraryRequest
from engine.api.schemas.selection import SelectionQueryRequest
from engine.core.database import Database
from engine.pipeline.models import PipelineResult
from engine.services import exporter
from engine.services.cache import store_result
from engine.services.photo_input import source_fingerprint
from engine.services.selection import query_selection


def _photo(source: Path) -> exporter.ExportPhoto:
    return exporter.ExportPhoto(
        id="p1",
        file_path=str(source),
        file_name=source.name,
        file_mtime="2026-11-17",
        exif_json=None,
        companion_path=None,
        decision=None,
        grade="select",
        quality_score=0.9,
        bird_count=1,
        species="普通翠鸟",
    )


def test_copy_failure_never_publishes_partial_final_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source" / "a.jpg"
    source.parent.mkdir()
    source.write_bytes(b"original-photo")
    dest = tmp_path / "output" / "a.jpg"

    def fail_sync(_fd: int) -> None:
        raise OSError("disk full after write")

    monkeypatch.setattr(exporter.os, "fsync", fail_sync)
    with pytest.raises(OSError, match="disk full"):
        exporter._copy_file(source, dest)
    assert not dest.exists()
    assert list(dest.parent.iterdir()) == []
    assert source.read_bytes() == b"original-photo"


def test_cancel_during_file_copy_cleans_temporary_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source.CR3"
    source.write_bytes(b"a" * (2 * 1024 * 1024))
    dest = tmp_path / "output" / "source.CR3"
    cancel = threading.Event()
    checks = iter([False, True])
    monkeypatch.setattr(cancel, "is_set", lambda: next(checks))
    with pytest.raises(exporter._ExportCancelled):
        exporter._copy_file(source, dest, cancel_event=cancel)
    assert not dest.exists()
    assert list(dest.parent.iterdir()) == []


def test_atomic_metadata_failure_keeps_previous_complete_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    dest = tmp_path / "metadata.xmp"
    dest.write_bytes(b"complete-old-metadata")

    def fail_sync(_fd: int) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(exporter.os, "fsync", fail_sync)
    with pytest.raises(OSError):
        exporter._write_text_file(dest, "new metadata")
    assert dest.read_bytes() == b"complete-old-metadata"
    assert list(tmp_path.iterdir()) == [dest]


def test_changed_input_is_not_copied_under_old_snapshot(tmp_path: Path) -> None:
    source = tmp_path / "source" / "a.jpg"
    source.parent.mkdir()
    source.write_bytes(b"before")
    photo = _photo(source)
    exporter._freeze_file_inputs([photo])
    source.write_bytes(b"different-input")
    target = tmp_path / "output"
    result = exporter._run_export(
        library_id="lib",
        library_name="Lib",
        root_path=str(source.parent),
        target_dir=str(target),
        photos=[photo],
        body=ExportLibraryRequest(target_dir=str(target), include_companions=False),
    )
    assert result.failed_count == 1
    assert result.exported_count == 0
    assert not list(Path(result.output_dir).glob("*.jpg"))
    report = json.loads(Path(result.manifest.json_path or "").read_text())
    assert report["导出摘要"]["任务状态"] == "部分失败"
    assert "发生变化" in report["照片清单"][0]["错误原因"]


def test_hash_catches_same_size_same_mtime_replacement(tmp_path: Path) -> None:
    source = tmp_path / "a.jpg"
    source.write_bytes(b"before")
    stat = source.stat()
    fingerprint = exporter._fingerprint(source)
    expected_hash = hashlib.sha256(b"before").hexdigest()
    source.write_bytes(b"after!")
    os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    # ctime is now part of the cheap guard; the immutable hash independently
    # protects a source whose current stat was accepted at snapshot time.
    assert exporter._fingerprint(source)[:4] == fingerprint[:4]
    with pytest.raises(exporter.ExportError, match="input hash"):
        exporter._copy_file(
            source,
            tmp_path / "output" / "a.jpg",
            expected_fingerprint=exporter._fingerprint(source),
            expected_hash=expected_hash,
        )
    assert not list((tmp_path / "output").iterdir())


def test_companion_failure_rolls_back_complete_photo_members(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source" / "a.jpg"
    source.parent.mkdir()
    source.write_bytes(b"jpeg")
    companion = source.with_suffix(".CR3")
    companion.write_bytes(b"raw")
    photo = _photo(source)
    photo.companion_path = str(companion)
    original = exporter.shutil.copystat

    def fail_companion(src: Path, dst: Path) -> None:
        if src == companion:
            raise OSError("companion copy failed")
        original(src, dst)

    monkeypatch.setattr(exporter.shutil, "copystat", fail_companion)
    target = tmp_path / "output"
    result = exporter._run_export(
        library_id="lib",
        library_name="Lib",
        root_path=str(source.parent),
        target_dir=str(target),
        photos=[photo],
        body=ExportLibraryRequest(target_dir=str(target)),
    )
    assert result.failed_count == 1
    assert result.exported_count == result.companion_count == 0
    assert {p.suffix for p in Path(result.output_dir).iterdir()} == {".csv", ".json"}
    assert source.read_bytes() == b"jpeg"
    assert companion.read_bytes() == b"raw"


def test_restarted_job_is_explicitly_interrupted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from engine.core.config import settings

    monkeypatch.setattr(settings, "data_dir", tmp_path)
    job = exporter.ExportJob("restart-job", "lib", total=2, total_bytes=100)
    job.snapshot_path = exporter._job_snapshot_path(job.job_id)
    job.set_output_dir(str(tmp_path / "exported"))
    job.record(exported_main=True)
    exporter._JOBS.pop(job.job_id, None)
    try:
        restored = exporter.get_export_job(job.job_id)
        assert restored is not None
        snapshot = restored.snapshot()
        assert snapshot["status"] == "failed"
        assert snapshot["error"]["code"] == "job_interrupted"
        assert snapshot["output_dir"] == str(tmp_path / "exported")
        assert snapshot["processed"] == snapshot["exported"] == 1
        assert exporter.get_export_job("../../private") is None
    finally:
        exporter._JOBS.pop(job.job_id, None)


@pytest.fixture
async def analyzed_raw_input(tmp_path: Path):
    root = tmp_path / "source"
    root.mkdir()
    source = root / "a.jpg"
    raw = root / "a.CR3"
    source.write_bytes(b"original-primary-jpeg")
    raw.write_bytes(b"original-raw-inference-input")
    db = Database(tmp_path / "input.db")
    await db.connect()
    async with db.transaction() as conn:
        await conn.execute(
            "INSERT INTO libraries (id,display_name,parent_path,root_path,created_at,"
            "last_opened_at) "
            "VALUES ('lib','Lib',?,?,'now','now')",
            (str(tmp_path), str(root)),
        )
        await conn.execute(
            "INSERT INTO photos (id,library_id,file_path,file_name,file_size,file_mtime,file_hash,"
            "format,created_at,companion_path,companion_format,companion_size) "
            "VALUES ('p1','lib',?,'a.jpg',?,'now',?,'JPG','now',?,'CR3',?)",
            (
                str(source),
                source.stat().st_size,
                hashlib.sha256(source.read_bytes()).hexdigest(),
                str(raw),
                raw.stat().st_size,
            ),
        )
    bird = {
        "bbox": {"x1": 0, "y1": 0, "x2": 20, "y2": 20, "confidence": 0.9},
        "quality": {"clipiqa": 0.8, "hyperiqa": 0.8, "combined": 0.8},
        "grade": "select",
        "species": "普通翠鸟",
        "species_candidates": [
            {
                "canonical_sci": "Alcedo atthis",
                "canonical_zh": "普通翠鸟",
                "confidence": 0.9,
                "recognition_state": "recognized",
            }
        ],
    }
    result = PipelineResult.model_validate(
        {
            "photo_id": "p1",
            "detections": [bird],
            "best": bird,
            "bird_count": 1,
            "pipeline_version": "raw-v1",
            "duration_ms": 1,
            "companion_used": True,
        }
    )
    await store_result(
        db,
        "p1",
        result,
        expected_input_revision=0,
        source_path=str(raw),
        source_hash=hashlib.sha256(raw.read_bytes()).hexdigest(),
        fingerprint=source_fingerprint(source, raw),
    )
    try:
        yield db, source, raw, tmp_path / "output"
    finally:
        await db.close()


async def test_changed_analyzed_raw_is_rejected_before_selection_export(analyzed_raw_input):
    db, source, raw, target = analyzed_raw_input
    query = SelectionQueryRequest(species_keys=["sci:Alcedo atthis"])
    preview = await query_selection(db, "lib", query)
    assert preview.matched_photo_ids == ["p1"]
    raw.write_bytes(b"a different RAW with a different bird")
    body = ExportLibraryRequest(
        target_dir=str(target),
        scope="selection",
        selection_query=query,
        projection_revision=preview.projection_revision,
        formats=["CR3"],
    )
    with pytest.raises(exporter.ExportError) as caught:
        await exporter.export_library(db, "lib", body)
    assert caught.value.code == "source_changed"
    assert not list(target.rglob("*.CR3"))
    assert source.read_bytes() == b"original-primary-jpeg"


async def test_raw_export_records_and_checks_the_actual_inference_hash(analyzed_raw_input):
    db, _source, raw, target = analyzed_raw_input
    expected_hash = hashlib.sha256(raw.read_bytes()).hexdigest()
    result = await exporter.export_library(
        db, "lib", ExportLibraryRequest(target_dir=str(target), formats=["CR3"])
    )
    assert result.failed_count == 0
    assert result.companion_count == 1
    assert next(Path(result.output_dir).rglob("*.CR3")).read_bytes() == raw.read_bytes()
    manifest = json.loads(Path(result.manifest.json_path or "").read_text())
    assert manifest["导出摘要"]["输入快照"][0]["推理源哈希"] == expected_hash
    assert manifest["导出摘要"]["输入快照"][0]["推理源"] == "同伴文件"


@pytest.mark.parametrize("copy_relink", [False, True])
async def test_same_content_relink_keeps_inference_provenance_valid(
    analyzed_raw_input, copy_relink: bool
):
    db, source, raw, target = analyzed_raw_input
    moved = source.parent.with_name("moved")
    if copy_relink:
        moved.mkdir()
        shutil.copy2(source, moved / source.name)
        shutil.copy2(raw, moved / raw.name)
    else:
        source.parent.rename(moved)
    next_source, next_raw = moved / source.name, moved / raw.name
    async with db.transaction() as conn:
        await conn.execute("UPDATE libraries SET root_path=? WHERE id='lib'", (str(moved),))
        await conn.execute(
            "UPDATE photos SET file_path=?,companion_path=? WHERE id='p1'",
            (str(next_source), str(next_raw)),
        )
    result = await exporter.export_library(
        db, "lib", ExportLibraryRequest(target_dir=str(target), formats=["CR3"])
    )
    assert result.failed_count == 0
    assert result.companion_count == 1
    assert next(Path(result.output_dir).rglob("*.CR3")).read_bytes() == next_raw.read_bytes()


async def test_actual_raw_hash_is_verified_even_when_recorded_stat_matches(analyzed_raw_input):
    db, _source, _raw, target = analyzed_raw_input
    async with db.transaction() as conn:
        await conn.execute("UPDATE analysis_results SET source_hash=?", ("0" * 64,))
    result = await exporter.export_library(
        db, "lib", ExportLibraryRequest(target_dir=str(target), formats=["CR3"])
    )
    assert result.failed_count == 1
    assert result.companion_count == 0
    assert not list(Path(result.output_dir).rglob("*.CR3"))


def test_companion_replacement_preserving_mtime_is_not_accepted_mid_job(tmp_path: Path):
    source = tmp_path / "source" / "a.jpg"
    source.parent.mkdir()
    source.write_bytes(b"jpeg")
    raw = source.with_suffix(".CR3")
    raw.write_bytes(b"old-raw")
    photo = _photo(source)
    photo.companion_path = str(raw)
    exporter._freeze_file_inputs([photo])
    original_stat = raw.stat()
    raw.write_bytes(b"new-raw")
    os.utime(raw, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
    result = exporter._run_export(
        library_id="lib",
        library_name="Lib",
        root_path=str(source.parent),
        target_dir=str(tmp_path / "output"),
        photos=[photo],
        body=ExportLibraryRequest(target_dir=str(tmp_path / "output")),
    )
    assert result.failed_count == 1
    assert result.exported_count == result.companion_count == 0
    assert not list(Path(result.output_dir).rglob("*.jpg"))
    assert not list(Path(result.output_dir).rglob("*.CR3"))
