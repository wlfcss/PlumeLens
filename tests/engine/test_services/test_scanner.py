"""Tests for folder scanner (two-phase scan + hash backfill)."""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest
from engine.core.database import Database
from engine.services.scanner import backfill_hashes, scan_library
from PIL import Image


@pytest.fixture
async def db(tmp_path: Path) -> Database:
    db = Database(tmp_path / "scan_test.db")
    await db.connect()
    # 插入一个 library 供 scan 使用
    await db.conn.execute(
        "INSERT INTO libraries (id, display_name, parent_path, root_path, "
        "created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?)",
        ("lib-test", "Test Lib", "/tmp", "/tmp/lib-test", "2026-04-24", "2026-04-24"),
    )
    await db.conn.commit()
    yield db
    await db.close()


def _make_jpeg(path: Path, size: tuple[int, int] = (64, 48)) -> None:
    """Write a minimal valid JPEG file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, color=(100, 120, 140)).save(path, "JPEG", quality=80)


class TestScanLibrary:
    async def test_scan_empty_dir(self, db: Database, tmp_path: Path) -> None:
        root = tmp_path / "empty"
        root.mkdir()
        report = await scan_library(db, "lib-test", root)
        assert report.added == 0
        assert report.updated == 0
        assert report.unchanged == 0

    async def test_adds_supported_files(self, db: Database, tmp_path: Path) -> None:
        root = tmp_path / "library"
        _make_jpeg(root / "a.jpg")
        _make_jpeg(root / "b.jpeg")
        # 不支持的格式应该被跳过
        (root / "readme.txt").write_text("hello")

        report = await scan_library(db, "lib-test", root)
        assert report.added == 2
        assert report.errors == []

        async with db.conn.execute(
            "SELECT COUNT(*) FROM photos WHERE library_id = 'lib-test'"
        ) as cur:
            row = await cur.fetchone()
        assert row is not None
        assert row[0] == 2

    async def test_recursive_flag(self, db: Database, tmp_path: Path) -> None:
        root = tmp_path / "lib"
        _make_jpeg(root / "top.jpg")
        _make_jpeg(root / "sub" / "deep.jpg")

        report_flat = await scan_library(
            db, "lib-test", root, recursive=False,
        )
        assert report_flat.added == 1  # 只有 top.jpg

        # 再跑一次 recursive=True 应新增 1 张（deep.jpg）
        report_recursive = await scan_library(db, "lib-test", root, recursive=True)
        assert report_recursive.added == 1  # 仅新增深层那张
        assert report_recursive.unchanged == 1

    async def test_width_height_populated(self, db: Database, tmp_path: Path) -> None:
        root = tmp_path / "lib"
        _make_jpeg(root / "photo.jpg", size=(320, 240))
        await scan_library(db, "lib-test", root)

        async with db.conn.execute(
            "SELECT width, height FROM photos WHERE library_id = 'lib-test'"
        ) as cur:
            row = await cur.fetchone()
        assert row is not None
        assert row["width"] == 320
        assert row["height"] == 240


class TestIncrementalScan:
    async def test_unchanged_file_skipped(self, db: Database, tmp_path: Path) -> None:
        root = tmp_path / "lib"
        _make_jpeg(root / "a.jpg")

        first = await scan_library(db, "lib-test", root)
        assert first.added == 1

        second = await scan_library(db, "lib-test", root)
        assert second.added == 0
        assert second.unchanged == 1

    async def test_modified_file_updates_and_clears_hash(
        self, db: Database, tmp_path: Path,
    ) -> None:
        root = tmp_path / "lib"
        path = root / "a.jpg"
        _make_jpeg(path, size=(100, 100))

        await scan_library(db, "lib-test", root)
        # 模拟哈希已写入
        await db.conn.execute(
            "UPDATE photos SET file_hash = ? WHERE file_path = ?",
            ("deadbeef", str(path)),
        )
        await db.conn.commit()

        # 改文件尺寸 + 手动调 mtime，避免 async 环境里的 sleep
        _make_jpeg(path, size=(200, 200))
        import os
        st = path.stat()
        # 把 mtime 往前拨 10 秒，保证与之前记录的 mtime 字符串不同
        os.utime(path, (st.st_atime, st.st_mtime + 10))

        report = await scan_library(db, "lib-test", root)
        assert report.updated == 1
        assert report.added == 0

        # hash 应被清空（等阶段 2 重算）
        async with db.conn.execute(
            "SELECT file_hash, width FROM photos WHERE file_path = ?",
            (str(path),),
        ) as cur:
            row = await cur.fetchone()
        assert row is not None
        assert row["file_hash"] is None
        assert row["width"] == 200


class TestBackfillHashes:
    async def test_fills_null_hashes(self, db: Database, tmp_path: Path) -> None:
        root = tmp_path / "lib"
        p1 = root / "a.jpg"
        p2 = root / "b.jpg"
        _make_jpeg(p1)
        _make_jpeg(p2)

        await scan_library(db, "lib-test", root)
        # 阶段 1 后 hash 应为 NULL
        async with db.conn.execute(
            "SELECT COUNT(*) FROM photos WHERE file_hash IS NULL"
        ) as cur:
            row = await cur.fetchone()
        assert row is not None
        assert row[0] == 2

        count = await backfill_hashes(db, "lib-test")
        assert count == 2

        # 每个 hash 匹配实际文件内容
        expected1 = hashlib.sha256(p1.read_bytes()).hexdigest()
        async with db.conn.execute(
            "SELECT file_hash FROM photos WHERE file_path = ?", (str(p1),),
        ) as cur:
            row = await cur.fetchone()
        assert row is not None
        assert row["file_hash"] == expected1

    async def test_backfill_idempotent(self, db: Database, tmp_path: Path) -> None:
        root = tmp_path / "lib"
        _make_jpeg(root / "a.jpg")
        await scan_library(db, "lib-test", root)
        first = await backfill_hashes(db, "lib-test")
        second = await backfill_hashes(db, "lib-test")
        assert first == 1
        assert second == 0  # 没有 NULL hash 的照片了

    async def test_missing_file_skipped(
        self, db: Database, tmp_path: Path,
    ) -> None:
        root = tmp_path / "lib"
        path = root / "a.jpg"
        _make_jpeg(path)
        await scan_library(db, "lib-test", root)

        # 先删掉文件
        path.unlink()

        count = await backfill_hashes(db, "lib-test")
        # 文件消失不报错，只是 hash 仍为 NULL
        assert count == 0
