"""Tests for analyzer service (mocked PipelineManager)."""

from __future__ import annotations

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


@pytest.fixture
async def db(tmp_path: Path) -> Database:
    db = Database(tmp_path / "analyzer_test.db")
    await db.connect()
    # library + photo
    await db.conn.execute(
        "INSERT INTO libraries (id, display_name, parent_path, root_path, "
        "created_at, last_opened_at) VALUES ('lib-1', 'X', '/p', '/p/r', "
        "'2026-04-24', '2026-04-24')",
    )
    # 关键：file_path 指向实际存在的临时文件（analyze_photo 会检查）
    photo_path = tmp_path / "test.jpg"
    photo_path.write_bytes(b"fake jpeg bytes")
    await db.conn.execute(
        "INSERT INTO photos (id, file_path, file_name, file_size, file_mtime, "
        "created_at, library_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("photo-1", str(photo_path), "test.jpg", 15, "2026-04-24",
         "2026-04-24", "lib-1"),
    )
    await db.conn.commit()
    yield db
    await db.close()


def _fake_result(version: str = "v1-abcdef12") -> PipelineResult:
    bbox = BoundingBox(x1=0, y1=0, x2=100, y2=100, confidence=0.9)
    q = QualityScores(clipiqa=0.3, hyperiqa=0.7, combined=0.58)
    ba = BirdAnalysis(bbox=bbox, quality=q, grade=QualityGrade.USABLE)
    return PipelineResult(
        photo_id="photo-1",
        detections=[ba],
        best=ba,
        bird_count=1,
        pipeline_version=version,
        duration_ms=200.0,
    )


def _make_mock_pipeline(
    version: str = "v1-abcdef12",
    ready: bool = True,
) -> MagicMock:
    pipeline = MagicMock()
    pipeline.is_ready = ready
    pipeline.pipeline_version = version
    # analyze 是 async 方法
    pipeline.analyze = AsyncMock(return_value=_fake_result(version))
    return pipeline


class TestAnalyzePhotoCold:
    """首次分析：缓存 miss → 跑 ONNX → 写入。"""

    async def test_fresh_analysis_runs_pipeline(self, db: Database) -> None:
        pipeline = _make_mock_pipeline("v1-aaa")

        outcome = await analyze_photo(db, pipeline, "photo-1")
        assert outcome.from_cache is False
        assert outcome.result.pipeline_version == "v1-aaa"
        pipeline.analyze.assert_awaited_once()

        # 应已落库
        async with db.conn.execute(
            "SELECT pipeline_version FROM analysis_results WHERE photo_id='photo-1'"
        ) as cur:
            row = await cur.fetchone()
        assert row is not None
        assert row["pipeline_version"] == "v1-aaa"


class TestAnalyzePhotoCacheHit:
    """同版本已分析过：应跳过 ONNX。"""

    async def test_cache_hit_skips_inference(self, db: Database) -> None:
        pipeline = _make_mock_pipeline("v1-bbb")

        # 第一次触发分析落库
        await analyze_photo(db, pipeline, "photo-1")
        pipeline.analyze.assert_awaited_once()

        # 第二次应命中缓存
        pipeline.analyze.reset_mock()
        outcome = await analyze_photo(db, pipeline, "photo-1")
        assert outcome.from_cache is True
        pipeline.analyze.assert_not_awaited()

    async def test_force_rerun_bypasses_cache(self, db: Database) -> None:
        pipeline = _make_mock_pipeline("v1-ccc")
        await analyze_photo(db, pipeline, "photo-1")
        pipeline.analyze.reset_mock()

        outcome = await analyze_photo(db, pipeline, "photo-1", force_rerun=True)
        assert outcome.from_cache is False
        pipeline.analyze.assert_awaited_once()


class TestVersionChange:
    """管线版本变更 → 旧 active 自动置 inactive，新结果入库。"""

    async def test_new_version_triggers_rerun(self, db: Database) -> None:
        old = _make_mock_pipeline("v1-old")
        await analyze_photo(db, old, "photo-1")
        # 换版本
        new = _make_mock_pipeline("v1-new")
        outcome = await analyze_photo(db, new, "photo-1")
        assert outcome.from_cache is False
        assert outcome.result.pipeline_version == "v1-new"

        async with db.conn.execute(
            "SELECT pipeline_version, is_active FROM analysis_results "
            "WHERE photo_id='photo-1' ORDER BY pipeline_version"
        ) as cur:
            rows = await cur.fetchall()
        versions = {str(r["pipeline_version"]): int(r["is_active"]) for r in rows}
        assert versions == {"v1-new": 1, "v1-old": 0}


class TestErrorPaths:
    async def test_raises_when_pipeline_not_ready(self, db: Database) -> None:
        pipeline = _make_mock_pipeline(ready=False)
        with pytest.raises(RuntimeError, match="not ready"):
            await analyze_photo(db, pipeline, "photo-1")

    async def test_raises_when_photo_unknown(self, db: Database) -> None:
        pipeline = _make_mock_pipeline()
        with pytest.raises(RuntimeError, match="Photo not found"):
            await analyze_photo(db, pipeline, "nonexistent")

    async def test_raises_when_file_missing(
        self, db: Database, tmp_path: Path,
    ) -> None:
        # 插入一条 file_path 指向不存在文件的 photo
        await db.conn.execute(
            "INSERT INTO photos (id, file_path, file_name, file_size, file_mtime, "
            "created_at, library_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("photo-missing", str(tmp_path / "nope.jpg"), "nope.jpg", 0,
             "2026-04-24", "2026-04-24", "lib-1"),
        )
        await db.conn.commit()
        pipeline = _make_mock_pipeline()
        with pytest.raises(FileNotFoundError):
            await analyze_photo(db, pipeline, "photo-missing")
