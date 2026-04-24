"""Tests for photo decision service (user layer)."""

from __future__ import annotations

from pathlib import Path

import pytest
from engine.core.database import Database
from engine.services.decisions import (
    Decision,
    count_by_decision,
    get_decision,
    list_decisions,
    set_decision,
    set_decisions_batch,
)


@pytest.fixture
async def db_with_photos(tmp_path: Path) -> Database:
    db = Database(tmp_path / "decision_test.db")
    await db.connect()
    await db.conn.execute(
        "INSERT INTO libraries (id, display_name, parent_path, root_path, "
        "created_at, last_opened_at) VALUES ('lib-1', 'X', '/p', '/p/r', "
        "'2026-04-25', '2026-04-25')",
    )
    for i in range(4):
        await db.conn.execute(
            "INSERT INTO photos (id, file_path, file_name, file_size, file_mtime, "
            "created_at, library_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (f"photo-{i}", f"/p/{i}.jpg", f"{i}.jpg", 100, "2026-04-25",
             "2026-04-25", "lib-1"),
        )
    await db.conn.commit()
    yield db
    await db.close()


class TestGetSet:
    async def test_default_is_unreviewed(self, db_with_photos: Database) -> None:
        d = await get_decision(db_with_photos, "photo-0")
        assert d is Decision.UNREVIEWED

    async def test_set_and_read_back(self, db_with_photos: Database) -> None:
        await set_decision(db_with_photos, "photo-0", Decision.SELECTED)
        assert await get_decision(db_with_photos, "photo-0") is Decision.SELECTED

    async def test_upsert_overwrites(self, db_with_photos: Database) -> None:
        await set_decision(db_with_photos, "photo-0", Decision.MAYBE)
        await set_decision(db_with_photos, "photo-0", Decision.REJECTED)
        assert await get_decision(db_with_photos, "photo-0") is Decision.REJECTED

    async def test_set_raises_on_unknown_photo(self, db_with_photos: Database) -> None:
        with pytest.raises(RuntimeError, match="Photo not found"):
            await set_decision(db_with_photos, "nonexistent", Decision.SELECTED)


class TestBatch:
    async def test_batch_upsert(self, db_with_photos: Database) -> None:
        updates = [
            ("photo-0", Decision.SELECTED),
            ("photo-1", Decision.REJECTED),
            ("photo-2", Decision.MAYBE),
        ]
        n = await set_decisions_batch(db_with_photos, updates)
        assert n == 3
        assert await get_decision(db_with_photos, "photo-0") is Decision.SELECTED
        assert await get_decision(db_with_photos, "photo-1") is Decision.REJECTED
        assert await get_decision(db_with_photos, "photo-2") is Decision.MAYBE

    async def test_batch_empty_returns_zero(self, db_with_photos: Database) -> None:
        assert await set_decisions_batch(db_with_photos, []) == 0


class TestList:
    async def test_list_returns_only_explicit_rows(
        self, db_with_photos: Database,
    ) -> None:
        await set_decision(db_with_photos, "photo-0", Decision.SELECTED)
        await set_decision(db_with_photos, "photo-2", Decision.REJECTED)

        decisions = await list_decisions(db_with_photos, "lib-1")
        assert decisions == {
            "photo-0": Decision.SELECTED,
            "photo-2": Decision.REJECTED,
        }

    async def test_counts_include_unreviewed_fallback(
        self, db_with_photos: Database,
    ) -> None:
        # Library has 4 photos, mark 1 selected + 1 rejected
        await set_decision(db_with_photos, "photo-0", Decision.SELECTED)
        await set_decision(db_with_photos, "photo-1", Decision.REJECTED)

        counts = await count_by_decision(db_with_photos, "lib-1")
        assert counts["selected"] == 1
        assert counts["rejected"] == 1
        assert counts["maybe"] == 0
        assert counts["unreviewed"] == 2  # 剩下 2 张未显式决定


class TestCascadeDelete:
    async def test_photo_deletion_cascades_to_decision(
        self, db_with_photos: Database,
    ) -> None:
        await set_decision(db_with_photos, "photo-0", Decision.SELECTED)
        # 删 photo 应级联删 decision
        await db_with_photos.conn.execute(
            "DELETE FROM photos WHERE id = ?", ("photo-0",),
        )
        await db_with_photos.conn.commit()

        async with db_with_photos.conn.execute(
            "SELECT COUNT(*) AS c FROM photo_decisions WHERE photo_id = 'photo-0'"
        ) as cur:
            row = await cur.fetchone()
        assert row is not None
        assert row["c"] == 0
