"""Tests for analysis result cache service (backed by analysis_results table)."""

from __future__ import annotations

from pathlib import Path

import pytest
from engine.core.database import Database
from engine.pipeline.models import (
    BirdAnalysis,
    BoundingBox,
    PipelineResult,
    QualityGrade,
    QualityScores,
)
from engine.services.cache import (
    get_active_result,
    get_result_for_version,
    invalidate_old_versions,
    invalidate_photo,
    list_versions,
    store_result,
)


@pytest.fixture
async def db(tmp_path: Path) -> Database:
    db = Database(tmp_path / "cache_test.db")
    await db.connect()
    await db.conn.execute(
        "INSERT INTO libraries (id, display_name, parent_path, root_path, "
        "created_at, last_opened_at) VALUES ('lib-1', 'X', '/p', '/p/r', "
        "'2026-04-24', '2026-04-24')",
    )
    await db.conn.execute(
        "INSERT INTO photos (id, file_path, file_name, file_size, file_mtime, "
        "created_at, library_id) VALUES ('photo-1', '/p/a.jpg', 'a.jpg', 100, "
        "'2026-04-24', '2026-04-24', 'lib-1')",
    )
    await db.conn.commit()
    yield db
    await db.close()


def _make_result(version: str = "v1-abcdef12", combined: float = 0.55) -> PipelineResult:
    bbox = BoundingBox(x1=10, y1=20, x2=100, y2=200, confidence=0.9)
    quality = QualityScores(clipiqa=0.4, hyperiqa=0.6, combined=combined)
    ba = BirdAnalysis(bbox=bbox, quality=quality, grade=QualityGrade.USABLE)
    return PipelineResult(
        photo_id="photo-1",
        detections=[ba],
        best=ba,
        bird_count=1,
        pipeline_version=version,
        duration_ms=100.0,
    )


class TestStoreAndLookup:
    async def test_store_fresh_result(self, db: Database) -> None:
        res = _make_result()
        row_id = await store_result(db, "photo-1", res)
        assert row_id

        active = await get_active_result(db, "photo-1")
        assert active is not None
        assert active.pipeline_version == "v1-abcdef12"
        assert active.bird_count == 1

    async def test_lookup_by_version(self, db: Database) -> None:
        await store_result(db, "photo-1", _make_result("v1-aaa"))
        fetched = await get_result_for_version(db, "photo-1", "v1-aaa")
        assert fetched is not None
        assert fetched.pipeline_version == "v1-aaa"

        miss = await get_result_for_version(db, "photo-1", "v1-unknown")
        assert miss is None

    async def test_get_active_returns_none_for_unknown_photo(
        self, db: Database,
    ) -> None:
        result = await get_active_result(db, "nonexistent")
        assert result is None


class TestActiveInvariant:
    """uq_analysis_active 应该确保每张 photo 只有一条 active。"""

    async def test_new_version_replaces_active(self, db: Database) -> None:
        # 存 v1-old
        await store_result(db, "photo-1", _make_result("v1-old"))
        # 存 v1-new（应自动把 v1-old 置 inactive）
        await store_result(db, "photo-1", _make_result("v1-new"))

        versions = await list_versions(db, "photo-1")
        assert len(versions) == 2
        active_rows = [v for v in versions if v["is_active"]]
        assert len(active_rows) == 1
        assert active_rows[0]["pipeline_version"] == "v1-new"

    async def test_same_version_overwrites_in_place(self, db: Database) -> None:
        """用户"重新分析"场景：同 pipeline_version 第二次应覆写不增行。"""
        await store_result(db, "photo-1", _make_result("v1-same", combined=0.5))
        await store_result(db, "photo-1", _make_result("v1-same", combined=0.7))

        versions = await list_versions(db, "photo-1")
        assert len(versions) == 1
        # 最后一次 store 的数据应胜出
        async with db.conn.execute(
            "SELECT quality_score FROM analysis_results WHERE photo_id = 'photo-1'"
        ) as cur:
            row = await cur.fetchone()
        assert row is not None
        assert float(row["quality_score"]) == pytest.approx(0.7)


class TestListAndInvalidate:
    async def test_list_versions_sorted_desc(self, db: Database) -> None:
        # 插入 3 个版本（按时间先后）
        for v in ("v1-a", "v1-b", "v1-c"):
            await store_result(db, "photo-1", _make_result(v))

        versions = await list_versions(db, "photo-1")
        assert [v["pipeline_version"] for v in versions] == ["v1-c", "v1-b", "v1-a"]
        # 只有最新的是 active
        assert versions[0]["is_active"] is True
        assert versions[1]["is_active"] is False
        assert versions[2]["is_active"] is False

    async def test_invalidate_photo_removes_all(self, db: Database) -> None:
        for v in ("v1-a", "v1-b"):
            await store_result(db, "photo-1", _make_result(v))

        deleted = await invalidate_photo(db, "photo-1")
        assert deleted == 2

        assert await get_active_result(db, "photo-1") is None
        assert len(await list_versions(db, "photo-1")) == 0

    async def test_invalidate_old_versions_preserves_active(
        self, db: Database,
    ) -> None:
        await store_result(db, "photo-1", _make_result("v1-old"))
        await store_result(db, "photo-1", _make_result("v1-new"))

        # 清理非 v1-new 且 inactive 的
        deleted = await invalidate_old_versions(db, keep_version="v1-new")
        assert deleted == 1

        versions = await list_versions(db, "photo-1")
        assert [v["pipeline_version"] for v in versions] == ["v1-new"]

    async def test_invalidate_old_versions_dry_run(self, db: Database) -> None:
        await store_result(db, "photo-1", _make_result("v1-old"))
        await store_result(db, "photo-1", _make_result("v1-new"))

        count = await invalidate_old_versions(db, keep_version="v1-new", dry_run=True)
        # dry_run 返回 pipeline_version != v1-new 的行数（含 active 和 inactive）
        # 当前只有 v1-old（inactive）满足，应为 1
        assert count == 1
        # 数据未变动
        assert len(await list_versions(db, "photo-1")) == 2
