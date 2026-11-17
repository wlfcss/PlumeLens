"""Cross-service regressions for input changes, task control, and write ownership."""

from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from engine.core.database import Database
from engine.pipeline.models import (
    BirdAnalysis,
    BoundingBox,
    PipelineResult,
    QualityGrade,
    QualityScores,
)
from engine.services.analyzer import analyze_photo
from engine.services.cache import get_active_result, get_result_for_version, store_result
from engine.services.decisions import (
    Decision,
    get_decision,
    list_species_overrides,
    set_decision,
    set_species_override,
)
from engine.services.photo_input import StalePhotoInputError
from engine.services.queue import (
    TaskStatus,
    cancel_library,
    enqueue_library,
    enqueue_photos,
    get_library_control,
    get_task_force_rerun,
    mark_failed_with_retry,
    pause_library,
    pick_next,
    recover_on_startup,
    resume_library,
)
from engine.services.scanner import backfill_hashes, scan_library
from engine.services.thumbnail import ensure_thumbnails_for_photo
from PIL import Image


def result(photo_id: str, version: str = "v-test") -> PipelineResult:
    bird = BirdAnalysis(
        bbox=BoundingBox(x1=1, y1=2, x2=40, y2=35, confidence=0.9),
        quality=QualityScores(clipiqa=0.7, hyperiqa=0.7, combined=0.7),
        grade=QualityGrade.USABLE,
    )
    return PipelineResult(
        photo_id=photo_id,
        detections=[bird],
        best=bird,
        bird_count=1,
        pipeline_version=version,
        duration_ms=1,
    )


@pytest.fixture
async def source(tmp_path: Path):
    root = tmp_path / "photos"
    root.mkdir()
    image = root / "a.jpg"
    Image.new("RGB", (64, 48), "red").save(image)
    db = Database(tmp_path / "test.db")
    await db.connect()
    async with db.transaction() as conn:
        await conn.execute(
            "INSERT INTO libraries(id,display_name,parent_path,root_path,"
            "created_at,last_opened_at) "
            "VALUES('L','original',?,?,?,?)",
            (str(tmp_path), str(root), "2026", "2026"),
        )
    await scan_library(db, "L", root)
    await backfill_hashes(db, "L")
    async with db.conn.execute("SELECT id FROM photos") as cur:
        photo_id = str((await cur.fetchone())[0])
    yield db, root, image, photo_id
    await db.close()


async def test_failed_writer_cannot_rollback_another_task(source):
    db, _, _, _ = source
    first_entered, second_waiting, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    second_entered = asyncio.Event()

    async def failing_writer():
        with pytest.raises(ValueError):
            async with db.transaction() as conn:
                await conn.execute("UPDATE libraries SET display_name='rolled-back' WHERE id='L'")
                first_entered.set()
                await release.wait()
                raise ValueError("injected failure")

    async def successful_writer():
        second_waiting.set()
        async with db.transaction() as conn:
            second_entered.set()
            async with conn.execute("SELECT display_name FROM libraries WHERE id='L'") as cur:
                assert (await cur.fetchone())[0] == "original"
            await conn.execute("UPDATE libraries SET display_name='committed' WHERE id='L'")

    first = asyncio.create_task(failing_writer())
    await first_entered.wait()
    second = asyncio.create_task(successful_writer())
    await second_waiting.wait()
    assert not second_entered.is_set()
    release.set()
    await asyncio.gather(first, second)
    async with db.conn.execute("SELECT display_name FROM libraries WHERE id='L'") as cur:
        assert (await cur.fetchone())[0] == "committed"


async def test_nested_service_transaction_keeps_outer_ownership(source):
    db, _, _, pid = source
    async with db.transaction() as conn:
        await set_decision(db, pid, Decision.SELECT)
        with pytest.raises(ValueError):
            async with db.transaction():
                await set_decision(db, pid, Decision.REJECT)
                raise ValueError("rollback only nested work")
        assert await get_decision(db, pid) is Decision.SELECT
        await conn.execute("UPDATE libraries SET display_name='outer' WHERE id='L'")
    assert await get_decision(db, pid) is Decision.SELECT


async def test_cancelled_transaction_rolls_back_and_releases_owner(source):
    db, _, _, _ = source
    entered = asyncio.Event()

    async def writer():
        async with db.transaction() as conn:
            await conn.execute("UPDATE libraries SET display_name='cancelled' WHERE id='L'")
            entered.set()
            await asyncio.Event().wait()

    task = asyncio.create_task(writer())
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    async with (
        db.transaction() as conn,
        conn.execute("SELECT display_name FROM libraries WHERE id='L'") as cur,
    ):
        assert (await cur.fetchone())[0] == "original"


async def test_rescan_changes_all_derivatives_but_preserves_manual_history(source, tmp_path: Path):
    db, root, image, pid = source
    await store_result(db, pid, result(pid))
    await set_decision(db, pid, Decision.SELECT)
    await set_species_override(
        db,
        pid,
        0,
        {
            "canonical_sci": "Egretta garzetta",
            "canonical_zh": "白鹭",
            "canonical_en": None,
        },
    )
    old = await ensure_thumbnails_for_photo(db, pid, tmp_path / "thumbs")
    assert old is not None
    async with db.transaction() as conn:
        await conn.execute(
            "UPDATE photos SET scene_id=1,country='中国',province='江苏省' WHERE id=?", (pid,)
        )
    Image.new("RGB", (80, 48), "blue").save(image)
    report = await scan_library(db, "L", root)
    assert report.updated == 1
    await backfill_hashes(db, "L")
    assert await get_result_for_version(db, pid, "v-test") is None
    assert await get_active_result(db, pid) is None
    assert await enqueue_library(db, "L", current_pipeline_version="v-test") == 1
    assert await get_decision(db, pid) is Decision.SELECT
    assert await list_species_overrides(db, "L") == {}
    async with db.conn.execute("SELECT * FROM photos WHERE id=?", (pid,)) as cur:
        row = await cur.fetchone()
    assert row["input_revision"] == 1
    assert all(row[column] is None for column in ("thumb_grid", "scene_id", "country", "province"))
    async with db.conn.execute("SELECT count(*) FROM photo_species_overrides") as cur:
        assert (await cur.fetchone())[0] == 1
    new = await ensure_thumbnails_for_photo(db, pid, tmp_path / "thumbs")
    assert new is not None and new.grid != old.grid
    assert new.grid.read_bytes() != old.grid.read_bytes()


async def test_source_changes_during_inference_cannot_replace_new_active(source):
    db, root, image, pid = source
    entered, release = asyncio.Event(), asyncio.Event()

    async def slow_inference(*args, **kwargs):
        entered.set()
        await release.wait()
        return result(pid)

    pipeline = MagicMock(is_ready=True, pipeline_version="v-test")
    pipeline.analyze = AsyncMock(side_effect=slow_inference)
    task = asyncio.create_task(analyze_photo(db, pipeline, pid))
    await entered.wait()
    Image.new("RGB", (96, 48), "blue").save(image)
    await scan_library(db, "L", root)
    await backfill_hashes(db, "L")
    await store_result(db, pid, result(pid, "new-input"), expected_input_revision=1)
    release.set()
    with pytest.raises(StalePhotoInputError):
        await task
    active = await get_active_result(db, pid)
    assert active is not None and active.pipeline_version == "new-input"


async def test_cached_analysis_records_actual_source_sha(source):
    db, _, image, pid = source
    pipeline = MagicMock(is_ready=True, pipeline_version="v-test")
    pipeline.analyze = AsyncMock(return_value=result(pid))
    await analyze_photo(db, pipeline, pid)
    async with db.conn.execute("SELECT source_hash,source_path FROM analysis_results") as cur:
        row = await cur.fetchone()
    assert row["source_hash"] == hashlib.sha256(image.read_bytes()).hexdigest()
    assert row["source_path"] == str(image)
    assert (await analyze_photo(db, pipeline, pid)).from_cache
    Image.new("RGB", (72, 48), "blue").save(image)
    assert await get_result_for_version(db, pid, "v-test") is None


async def test_concurrent_enqueue_deduplicates_including_duplicate_request_ids(source):
    db, _, _, pid = source
    counts = await asyncio.gather(*[enqueue_photos(db, "L", [pid, pid]) for _ in range(10)])
    assert sum(counts) == 1
    async with db.conn.execute("SELECT count(*) FROM task_queue WHERE status='pending'") as cur:
        assert (await cur.fetchone())[0] == 1


@pytest.mark.parametrize(
    "control,expected", [(pause_library, TaskStatus.PAUSED), (cancel_library, TaskStatus.CANCELLED)]
)
async def test_inflight_failure_respects_persisted_control_after_restart(source, control, expected):
    db, _, _, pid = source
    await enqueue_photos(db, "L", [pid], current_pipeline_version="v-test", force_rerun=True)
    task = await pick_next(db, "L")
    assert task is not None
    await control(db, "L")
    path = db.path
    await db.close()
    await db.connect()
    assert db.path == path
    retried = await mark_failed_with_retry(db, task.id, "transient GPU error")
    assert retried.status is expected
    assert await pick_next(db, "L") is None
    if expected is TaskStatus.PAUSED:
        await resume_library(db, "L")
        resumed = await pick_next(db, "L")
        assert resumed is not None and await get_task_force_rerun(db, resumed)


@pytest.mark.parametrize(
    "control,expected", [(pause_library, "paused"), (cancel_library, "cancelled")]
)
async def test_startup_recovery_keeps_control_intent(source, control, expected):
    db, _, _, pid = source
    await enqueue_photos(db, "L", [pid])
    assert await pick_next(db, "L") is not None
    await control(db, "L")
    await recover_on_startup(db)
    assert await pick_next(db, "L") is None
    async with db.conn.execute("SELECT status FROM task_queue") as cur:
        assert (await cur.fetchone())[0] == expected
    assert (await get_library_control(db, "L"))["desired_state"] == expected


@pytest.mark.parametrize("active_only", [False, True])
async def test_cache_reader_never_resurrects_another_tasks_rolled_back_result(source, active_only):
    db, _, _, pid = source
    original = result(pid)
    original.duration_ms = 100
    await store_result(db, pid, original)
    entered, release = asyncio.Event(), asyncio.Event()

    async def rollback_writer():
        with pytest.raises(ValueError):
            async with db.transaction():
                transient = result(pid)
                transient.duration_ms = 900
                await store_result(db, pid, transient)
                entered.set()
                await release.wait()
                raise ValueError("abort outer publication")

    writer = asyncio.create_task(rollback_writer())
    await entered.wait()
    read = asyncio.create_task(
        get_active_result(db, pid) if active_only else get_result_for_version(db, pid, "v-test")
    )
    await asyncio.sleep(0)
    assert not read.done()
    release.set()
    await writer
    observed = await read
    assert observed is not None and observed.duration_ms == 100
    await store_result(db, pid, observed)
    assert (await get_active_result(db, pid)).duration_ms == 100


async def test_source_changes_while_publication_waits_for_write_owner(source, monkeypatch):
    from engine.services import analyzer as analyzer_service

    db, _, image, pid = source
    inference_entered, finish_inference = asyncio.Event(), asyncio.Event()
    writer_entered, release_writer, publish_waiting = (
        asyncio.Event(),
        asyncio.Event(),
        asyncio.Event(),
    )

    async def infer(*args, **kwargs):
        inference_entered.set()
        await finish_inference.wait()
        return result(pid)

    async def publish(*args, **kwargs):
        publish_waiting.set()
        return await store_result(*args, **kwargs)

    async def hold_owner():
        async with db.transaction():
            writer_entered.set()
            await release_writer.wait()

    monkeypatch.setattr(analyzer_service, "store_result", publish)
    pipeline = MagicMock(is_ready=True, pipeline_version="v-test")
    pipeline.analyze = AsyncMock(side_effect=infer)
    analysis = asyncio.create_task(analyze_photo(db, pipeline, pid))
    await inference_entered.wait()
    writer = asyncio.create_task(hold_owner())
    await writer_entered.wait()
    finish_inference.set()
    await publish_waiting.wait()
    Image.new("RGB", (96, 48), "blue").save(image)
    release_writer.set()
    await writer
    with pytest.raises(StalePhotoInputError, match="before publication"):
        await analysis
    assert await get_active_result(db, pid) is None


async def test_old_thumbnail_decode_cannot_publish_after_rescan(source, monkeypatch, tmp_path):
    from engine.services import thumbnail

    db, root, image, pid = source
    generated, release = asyncio.Event(), asyncio.Event()
    original_generate = thumbnail.generate_thumbnails

    async def delayed_generation(*args, **kwargs):
        paths = await original_generate(*args, **kwargs)
        generated.set()
        await release.wait()
        return paths

    monkeypatch.setattr(thumbnail, "generate_thumbnails", delayed_generation)
    task = asyncio.create_task(ensure_thumbnails_for_photo(db, pid, tmp_path / "thumbs"))
    await generated.wait()
    Image.new("RGB", (96, 48), "blue").save(image)
    await scan_library(db, "L", root)
    release.set()
    assert await task is None
    async with db.conn.execute("SELECT thumb_grid FROM photos WHERE id=?", (pid,)) as cur:
        assert (await cur.fetchone())[0] is None
    monkeypatch.setattr(thumbnail, "generate_thumbnails", original_generate)
    latest = await ensure_thumbnails_for_photo(db, pid, tmp_path / "thumbs")
    assert latest is not None and latest.grid.name == f"{pid}-r1.jpg"


async def test_recovery_does_not_revive_failed_history_beside_new_active_task(source):
    db, _, _, pid = source
    await enqueue_photos(db, "L", [pid])
    task = await pick_next(db, "L")
    from engine.services.queue import transition

    await transition(db, task.id, TaskStatus.FAILED, error_message="legacy failed row")
    await enqueue_photos(db, "L", [pid])
    await recover_on_startup(db)
    async with db.conn.execute(
        "SELECT count(*) FROM task_queue WHERE status IN ('pending','processing','paused')"
    ) as cur:
        assert (await cur.fetchone())[0] == 1


async def test_same_pipeline_rerun_archives_previous_input_result(source):
    from engine.services.cache import list_input_history

    db, root, image, pid = source
    old = result(pid)
    old.duration_ms = 100
    await store_result(db, pid, old)
    Image.new("RGB", (96, 48), "blue").save(image)
    await scan_library(db, "L", root)
    await backfill_hashes(db, "L")
    new = result(pid)
    new.duration_ms = 900
    await store_result(db, pid, new, expected_input_revision=1)
    assert (await get_active_result(db, pid)).duration_ms == 900
    history = await list_input_history(db, pid)
    assert len(history) == 1 and history[0]["input_revision"] == 0
    assert PipelineResult.model_validate_json(history[0]["result_json"]).duration_ms == 100
    assert history[0]["input_hash"] != hashlib.sha256(image.read_bytes()).hexdigest()


async def test_child_task_cannot_inherit_parent_transaction_ownership(source):
    db, _, _, pid = source
    attempted, acquired = asyncio.Event(), asyncio.Event()

    async def child():
        attempted.set()
        async with db.transaction():
            acquired.set()
            await set_decision(db, pid, Decision.SELECT)

    async with db.transaction():
        task = asyncio.create_task(child())
        await attempted.wait()
        assert not acquired.is_set()
    await task
    assert await get_decision(db, pid) is Decision.SELECT


async def test_force_rerun_of_unscanned_replacement_requires_explicit_update(source, tmp_path):
    from engine.api.routes.analysis import _run_one_task
    from engine.services.queue import get_stats

    db, root, image, pid = source
    pipeline = MagicMock(is_ready=True, pipeline_version="v-test")
    pipeline.analyze = AsyncMock(return_value=result(pid))
    await analyze_photo(db, pipeline, pid)
    await set_decision(db, pid, Decision.SELECT)
    await set_species_override(
        db,
        pid,
        0,
        {
            "canonical_sci": "Egretta garzetta",
            "canonical_zh": "白鹭",
            "canonical_en": None,
        },
    )
    await ensure_thumbnails_for_photo(db, pid, tmp_path / "thumbs")
    async with db.transaction() as conn:
        await conn.execute("UPDATE photos SET scene_id=7,country='中国' WHERE id=?", (pid,))
    Image.new("RGB", (96, 48), "blue").save(image)
    pipeline.analyze.reset_mock()
    await enqueue_photos(db, "L", [pid], current_pipeline_version="v-test", force_rerun=True)
    assert await _run_one_task(db, pipeline, "L")
    pipeline.analyze.assert_not_awaited()
    assert (await get_stats(db, "L"))["dead"] == 1  # No automatic transient retry.
    async with db.conn.execute("SELECT * FROM photos WHERE id=?", (pid,)) as cur:
        row = await cur.fetchone()
    assert row["input_needs_scan"] == 1 and row["input_revision"] == 1
    assert all(row[column] is None for column in ("file_hash", "thumb_grid", "scene_id", "country"))
    assert await get_active_result(db, pid) is None
    assert await get_decision(db, pid) is Decision.SELECT
    assert await list_species_overrides(db, "L") == {}
    assert await backfill_hashes(db, "L") == 0
    with pytest.raises(StalePhotoInputError, match="source_changed"):
        await analyze_photo(db, pipeline, pid, force_rerun=True)
    await scan_library(db, "L", root)
    await backfill_hashes(db, "L")
    assert not (await analyze_photo(db, pipeline, pid)).from_cache
    pipeline.analyze.assert_awaited_once()


async def test_thumbnail_repair_does_not_mix_new_pixels_with_old_active_analysis(source, tmp_path):
    db, _, image, pid = source
    pipeline = MagicMock(is_ready=True, pipeline_version="v-test")
    pipeline.analyze = AsyncMock(return_value=result(pid))
    await analyze_photo(db, pipeline, pid)
    await ensure_thumbnails_for_photo(db, pid, tmp_path / "thumbs")
    Image.new("RGB", (96, 48), "blue").save(image)
    assert await ensure_thumbnails_for_photo(db, pid, tmp_path / "thumbs", force=True) is None
    assert await get_active_result(db, pid) is None
    async with db.conn.execute(
        "SELECT input_needs_scan,thumb_grid FROM photos WHERE id=?", (pid,)
    ) as cur:
        row = await cur.fetchone()
    assert row["input_needs_scan"] == 1 and row["thumb_grid"] is None
