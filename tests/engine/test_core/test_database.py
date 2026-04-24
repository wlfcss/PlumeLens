"""Tests for SQLite database layer (schema, pragmas, constraints)."""

from __future__ import annotations

from pathlib import Path

import aiosqlite
import pytest
from engine.core.database import SCHEMA_VERSION, Database


@pytest.fixture
async def db(tmp_path: Path) -> Database:
    """Fresh on-disk database per test (not :memory: so WAL mode is exercised)."""
    db = Database(tmp_path / "test.db")
    await db.connect()
    yield db
    await db.close()


class TestDatabaseInit:
    async def test_connect_creates_file(self, tmp_path: Path) -> None:
        db_path = tmp_path / "init.db"
        assert not db_path.exists()
        db = Database(db_path)
        await db.connect()
        try:
            assert db_path.exists()
        finally:
            await db.close()

    async def test_connect_is_idempotent(self, db: Database) -> None:
        # Second connect() should be a no-op, not open a new connection
        original_conn = db.conn
        await db.connect()
        assert db.conn is original_conn

    async def test_schema_version_recorded(self, db: Database) -> None:
        version = await db.get_schema_version()
        assert version == SCHEMA_VERSION

    async def test_raises_before_connect(self, tmp_path: Path) -> None:
        db = Database(tmp_path / "x.db")
        with pytest.raises(RuntimeError, match="not connected"):
            _ = db.conn

    async def test_close_is_safe_without_connect(self, tmp_path: Path) -> None:
        db = Database(tmp_path / "noop.db")
        await db.close()  # should not raise


class TestSchema:
    async def test_all_expected_tables_created(self, db: Database) -> None:
        tables = await db.list_tables()
        assert set(tables) >= {
            "libraries", "photos", "analysis_results", "task_queue",
        }

    async def test_pragmas_applied(self, db: Database) -> None:
        async with db.conn.execute("PRAGMA journal_mode;") as cur:
            row = await cur.fetchone()
        assert row is not None
        # SQLite 返回小写字符串 "wal"
        assert str(row[0]).lower() == "wal"

        async with db.conn.execute("PRAGMA foreign_keys;") as cur:
            row = await cur.fetchone()
        assert row is not None
        assert int(row[0]) == 1

        async with db.conn.execute("PRAGMA busy_timeout;") as cur:
            row = await cur.fetchone()
        assert row is not None
        assert int(row[0]) == 5000


class TestConstraints:
    """验证关键约束在数据库层真正生效（不靠应用逻辑）。"""

    async def _insert_library(self, db: Database, lib_id: str = "lib-1") -> None:
        await db.conn.execute(
            "INSERT INTO libraries (id, display_name, parent_path, root_path, "
            "created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?)",
            (lib_id, "Test", "/parent", f"/root/{lib_id}", "2026-04-24", "2026-04-24"),
        )

    async def _insert_photo(
        self, db: Database, photo_id: str = "p1", lib_id: str = "lib-1",
    ) -> None:
        await db.conn.execute(
            "INSERT INTO photos (id, file_path, file_name, file_size, file_mtime, "
            "created_at, library_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (photo_id, f"/photos/{photo_id}.jpg", f"{photo_id}.jpg", 1000,
             "2026-04-24", "2026-04-24", lib_id),
        )

    async def test_partial_unique_active_result(self, db: Database) -> None:
        """uq_analysis_active：每张照片至多一条 is_active=1。"""
        await self._insert_library(db)
        await self._insert_photo(db)

        # 第一条 active 应该成功
        await db.conn.execute(
            "INSERT INTO analysis_results (id, photo_id, pipeline_version, "
            "result_json, created_at, is_active) VALUES (?, ?, ?, ?, ?, ?)",
            ("r1", "p1", "v1-aaa", "{}", "2026-04-24", 1),
        )
        await db.conn.commit()

        # 第二条 active（同一 photo_id，不同 pipeline_version）应该被部分唯一索引阻止
        with pytest.raises(aiosqlite.IntegrityError):
            await db.conn.execute(
                "INSERT INTO analysis_results (id, photo_id, pipeline_version, "
                "result_json, created_at, is_active) VALUES (?, ?, ?, ?, ?, ?)",
                ("r2", "p1", "v1-bbb", "{}", "2026-04-24", 1),
            )
            await db.conn.commit()

    async def test_partial_unique_allows_one_active_one_inactive(
        self, db: Database,
    ) -> None:
        """is_active=0 的记录不受部分唯一索引限制（历史版本可保留）。"""
        await self._insert_library(db)
        await self._insert_photo(db)

        # 历史 inactive + 当前 active，都应允许
        await db.conn.execute(
            "INSERT INTO analysis_results (id, photo_id, pipeline_version, "
            "result_json, created_at, is_active) VALUES (?, ?, ?, ?, ?, ?)",
            ("r_old", "p1", "v1-old", "{}", "2026-04-24", 0),
        )
        await db.conn.execute(
            "INSERT INTO analysis_results (id, photo_id, pipeline_version, "
            "result_json, created_at, is_active) VALUES (?, ?, ?, ?, ?, ?)",
            ("r_new", "p1", "v1-new", "{}", "2026-04-24", 1),
        )
        await db.conn.commit()

        async with db.conn.execute(
            "SELECT COUNT(*) FROM analysis_results WHERE photo_id = 'p1'"
        ) as cur:
            row = await cur.fetchone()
        assert row is not None
        assert row[0] == 2

    async def test_photo_path_unique(self, db: Database) -> None:
        await self._insert_library(db)
        await self._insert_photo(db, photo_id="p1")
        await db.conn.commit()

        # 同 file_path 不同 id → UNIQUE 约束应拒绝
        with pytest.raises(aiosqlite.IntegrityError):
            await db.conn.execute(
                "INSERT INTO photos (id, file_path, file_name, file_size, "
                "file_mtime, created_at, library_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
                ("p2", "/photos/p1.jpg", "p1.jpg", 2000,
                 "2026-04-25", "2026-04-25", "lib-1"),
            )
            await db.conn.commit()

    async def test_foreign_key_enforced(self, db: Database) -> None:
        # 插入引用不存在 library_id 的 photo，应被 FK 拒绝
        with pytest.raises(aiosqlite.IntegrityError):
            await db.conn.execute(
                "INSERT INTO photos (id, file_path, file_name, file_size, "
                "file_mtime, created_at, library_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
                ("p_orphan", "/x/y.jpg", "y.jpg", 100, "2026-04-24",
                 "2026-04-24", "nonexistent-library"),
            )
            await db.conn.commit()

    async def test_cascade_delete_removes_photos_and_results(
        self, db: Database,
    ) -> None:
        await self._insert_library(db)
        await self._insert_photo(db, photo_id="p1")
        await db.conn.execute(
            "INSERT INTO analysis_results (id, photo_id, pipeline_version, "
            "result_json, created_at, is_active) VALUES (?, ?, ?, ?, ?, ?)",
            ("r1", "p1", "v1-x", "{}", "2026-04-24", 1),
        )
        await db.conn.commit()

        # 删除 library 应级联删除 photo 和 analysis_results
        await db.conn.execute("DELETE FROM libraries WHERE id = 'lib-1'")
        await db.conn.commit()

        async with db.conn.execute("SELECT COUNT(*) FROM photos") as cur:
            row = await cur.fetchone()
        assert row is not None
        assert row[0] == 0
        async with db.conn.execute(
            "SELECT COUNT(*) FROM analysis_results",
        ) as cur:
            row = await cur.fetchone()
        assert row is not None
        assert row[0] == 0
