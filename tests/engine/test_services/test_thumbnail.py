"""Tests for thumbnail service (JPEG path; RAW path tested via integration elsewhere)."""

from __future__ import annotations

from pathlib import Path

import pytest
from engine.core.database import Database
from engine.services.thumbnail import (
    GRID_LONG_EDGE,
    PREVIEW_LONG_EDGE,
    ensure_thumbnails_for_photo,
    generate_library_thumbnails,
    generate_thumbnails,
)
from PIL import Image


@pytest.fixture
async def db_with_photos(tmp_path: Path) -> tuple[Database, Path]:
    """Setup: database + 3 real JPEG files + 3 photos rows."""
    db = Database(tmp_path / "thumb_test.db")
    await db.connect()
    await db.conn.execute(
        "INSERT INTO libraries (id, display_name, parent_path, root_path, "
        "created_at, last_opened_at) VALUES ('lib-1', 'X', '/p', '/p/r', "
        "'2026-04-24', '2026-04-24')",
    )
    photo_dir = tmp_path / "photos"
    photo_dir.mkdir()
    for i in range(3):
        path = photo_dir / f"p{i}.jpg"
        # 制作一张足够大的原图，确认 resize 真的缩小
        Image.new("RGB", (4000, 3000), color=(10 * i, 20 * i, 30 * i)).save(
            path, "JPEG", quality=85,
        )
        await db.conn.execute(
            "INSERT INTO photos (id, file_path, file_name, file_size, "
            "file_mtime, created_at, library_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (f"photo-{i}", str(path), f"p{i}.jpg", 100,
             "2026-04-24", "2026-04-24", "lib-1"),
        )
    await db.conn.commit()
    yield db, tmp_path / "cache"
    await db.close()


class TestGenerateThumbnails:
    async def test_creates_both_levels(self, tmp_path: Path) -> None:
        src = tmp_path / "a.jpg"
        Image.new("RGB", (4000, 3000), (50, 100, 150)).save(src, "JPEG")
        cache = tmp_path / "cache"

        paths = await generate_thumbnails(src, "photo-a", cache)
        assert paths.grid.exists()
        assert paths.preview.exists()

        with Image.open(paths.grid) as g:
            assert max(g.size) == GRID_LONG_EDGE
        with Image.open(paths.preview) as p:
            assert max(p.size) == PREVIEW_LONG_EDGE

    async def test_preserves_aspect_ratio(self, tmp_path: Path) -> None:
        src = tmp_path / "landscape.jpg"
        Image.new("RGB", (4000, 2000), (200, 200, 200)).save(src, "JPEG")
        cache = tmp_path / "cache"

        paths = await generate_thumbnails(src, "ls", cache)
        with Image.open(paths.grid) as g:
            # 4000:2000 = 2:1 → grid 应是 384×192
            assert g.size == (384, 192)
        with Image.open(paths.preview) as p:
            assert p.size == (1920, 960)

    async def test_small_source_not_upscaled(self, tmp_path: Path) -> None:
        """若原图已经比目标尺寸小，不应放大。"""
        src = tmp_path / "tiny.jpg"
        Image.new("RGB", (200, 150), (100, 100, 100)).save(src, "JPEG")
        cache = tmp_path / "cache"

        paths = await generate_thumbnails(src, "tiny", cache)
        with Image.open(paths.preview) as p:
            assert p.size == (200, 150)
        with Image.open(paths.grid) as g:
            # grid 也不会放大（但 preview 已经 <= 384 直接复用）
            assert max(g.size) <= GRID_LONG_EDGE


class TestEnsureThumbnailsForPhoto:
    async def test_builds_and_updates_photos_table(
        self, db_with_photos: tuple[Database, Path],
    ) -> None:
        db, cache = db_with_photos
        paths = await ensure_thumbnails_for_photo(db, "photo-0", cache)
        assert paths is not None
        assert paths.grid.exists()

        async with db.conn.execute(
            "SELECT thumb_grid, thumb_preview FROM photos WHERE id='photo-0'"
        ) as cur:
            row = await cur.fetchone()
        assert row is not None
        assert row["thumb_grid"] == "grid/photo-0.jpg"
        assert row["thumb_preview"] == "preview/photo-0.jpg"

    async def test_second_call_reuses_existing(
        self, db_with_photos: tuple[Database, Path],
    ) -> None:
        db, cache = db_with_photos
        first = await ensure_thumbnails_for_photo(db, "photo-1", cache)
        assert first is not None
        mtime1 = first.grid.stat().st_mtime

        # 手动把 mtime 往前拨 100 秒（避免 async 里 time.sleep），用于观测是否被重建
        import os
        os.utime(first.grid, (mtime1 - 100, mtime1 - 100))

        # 二次调用应该复用（mtime 不会被覆盖）
        second = await ensure_thumbnails_for_photo(db, "photo-1", cache)
        assert second is not None
        assert second.grid.stat().st_mtime == first.grid.stat().st_mtime

    async def test_force_rebuilds(
        self, db_with_photos: tuple[Database, Path],
    ) -> None:
        db, cache = db_with_photos
        first = await ensure_thumbnails_for_photo(db, "photo-2", cache)
        assert first is not None
        mtime1 = first.grid.stat().st_mtime

        # 手动把 mtime 往前拨 100 秒（避免 async 里 time.sleep），用于观测是否被重建
        import os
        os.utime(first.grid, (mtime1 - 100, mtime1 - 100))

        second = await ensure_thumbnails_for_photo(db, "photo-2", cache, force=True)
        assert second is not None
        # force 后 mtime 应被刷新
        assert second.grid.stat().st_mtime > mtime1 - 100

    async def test_missing_source_returns_none(
        self, db_with_photos: tuple[Database, Path],
    ) -> None:
        db, cache = db_with_photos
        # 插入一条 photo 指向不存在的文件
        await db.conn.execute(
            "INSERT INTO photos (id, file_path, file_name, file_size, "
            "file_mtime, created_at, library_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("photo-missing", "/nonexistent/file.jpg", "file.jpg", 0,
             "2026-04-24", "2026-04-24", "lib-1"),
        )
        await db.conn.commit()
        result = await ensure_thumbnails_for_photo(db, "photo-missing", cache)
        assert result is None


class TestBatchGenerate:
    async def test_library_batch(
        self, db_with_photos: tuple[Database, Path],
    ) -> None:
        db, cache = db_with_photos
        report = await generate_library_thumbnails(
            db, "lib-1", cache, concurrency=2,
        )
        assert report["built"] == 3
        assert report["failed"] == 0

        # 第二次运行应全部跳过（因为 photos.thumb_grid 已填）
        report2 = await generate_library_thumbnails(
            db, "lib-1", cache, concurrency=2,
        )
        # 第二轮 SELECT 条件是 thumb_grid IS NULL OR thumb_preview IS NULL
        # 所有 photo 已填 → 返回空列表 → 0 built
        assert report2["built"] == 0
