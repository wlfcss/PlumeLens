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
    list_species_overrides,
    set_decision,
    set_decisions_batch,
    set_species_override,
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
            (f"photo-{i}", f"/p/{i}.jpg", f"{i}.jpg", 100, "2026-04-25", "2026-04-25", "lib-1"),
        )
    await db.conn.commit()
    yield db
    await db.close()


class TestGetSet:
    async def test_default_is_none(self, db_with_photos: Database) -> None:
        d = await get_decision(db_with_photos, "photo-0")
        assert d is None

    async def test_set_and_read_back(self, db_with_photos: Database) -> None:
        await set_decision(db_with_photos, "photo-0", Decision.SELECT)
        assert await get_decision(db_with_photos, "photo-0") is Decision.SELECT

    async def test_upsert_overwrites(self, db_with_photos: Database) -> None:
        await set_decision(db_with_photos, "photo-0", Decision.RECORD)
        await set_decision(db_with_photos, "photo-0", Decision.REJECT)
        assert await get_decision(db_with_photos, "photo-0") is Decision.REJECT

    async def test_clear_manual_override(self, db_with_photos: Database) -> None:
        await set_decision(db_with_photos, "photo-0", Decision.USABLE)
        await set_decision(db_with_photos, "photo-0", None)
        assert await get_decision(db_with_photos, "photo-0") is None

    async def test_set_raises_on_unknown_photo(self, db_with_photos: Database) -> None:
        with pytest.raises(RuntimeError, match="Photo not found"):
            await set_decision(db_with_photos, "nonexistent", Decision.SELECT)


class TestBatch:
    async def test_batch_upsert(self, db_with_photos: Database) -> None:
        updates = [
            ("photo-0", Decision.SELECT),
            ("photo-1", Decision.REJECT),
            ("photo-2", Decision.USABLE),
        ]
        n = await set_decisions_batch(db_with_photos, updates)
        assert n == 3
        assert await get_decision(db_with_photos, "photo-0") is Decision.SELECT
        assert await get_decision(db_with_photos, "photo-1") is Decision.REJECT
        assert await get_decision(db_with_photos, "photo-2") is Decision.USABLE

    async def test_batch_empty_returns_zero(self, db_with_photos: Database) -> None:
        assert await set_decisions_batch(db_with_photos, []) == 0

    async def test_batch_clear_manual_override(self, db_with_photos: Database) -> None:
        await set_decision(db_with_photos, "photo-0", Decision.USABLE)

        n = await set_decisions_batch(db_with_photos, [("photo-0", None)])

        assert n == 1
        assert await get_decision(db_with_photos, "photo-0") is None

    async def test_batch_raises_on_unknown_photo(self, db_with_photos: Database) -> None:
        with pytest.raises(RuntimeError, match="Photo not found"):
            await set_decisions_batch(db_with_photos, [("missing-photo", Decision.SELECT)])


class TestList:
    async def test_list_returns_only_explicit_rows(
        self,
        db_with_photos: Database,
    ) -> None:
        await set_decision(db_with_photos, "photo-0", Decision.SELECT)
        await set_decision(db_with_photos, "photo-2", Decision.REJECT)

        decisions = await list_decisions(db_with_photos, "lib-1")
        assert decisions == {
            "photo-0": Decision.SELECT,
            "photo-2": Decision.REJECT,
        }

    async def test_counts_include_manual_grades_only(
        self,
        db_with_photos: Database,
    ) -> None:
        await set_decision(db_with_photos, "photo-0", Decision.SELECT)
        await set_decision(db_with_photos, "photo-1", Decision.REJECT)

        counts = await count_by_decision(db_with_photos, "lib-1")
        assert counts["select"] == 1
        assert counts["reject"] == 1
        assert counts["usable"] == 0
        assert counts["record"] == 0


class TestCascadeDelete:
    async def test_photo_deletion_cascades_to_decision(
        self,
        db_with_photos: Database,
    ) -> None:
        await set_decision(db_with_photos, "photo-0", Decision.SELECT)
        # 删 photo 应级联删 decision
        await db_with_photos.conn.execute(
            "DELETE FROM photos WHERE id = ?",
            ("photo-0",),
        )
        await db_with_photos.conn.commit()

        async with db_with_photos.conn.execute(
            "SELECT COUNT(*) AS c FROM photo_decisions WHERE photo_id = 'photo-0'"
        ) as cur:
            row = await cur.fetchone()
        assert row is not None
        assert row["c"] == 0


class TestSpeciesOverrides:
    async def test_set_list_and_clear_species_override(
        self,
        db_with_photos: Database,
    ) -> None:
        await set_species_override(
            db_with_photos,
            "photo-0",
            1,
            {
                "canonical_sci": "Zosterops simplex",
                "canonical_zh": "暗绿绣眼鸟",
                "canonical_en": "Swinhoe's white-eye",
            },
        )

        overrides = await list_species_overrides(db_with_photos, "lib-1")
        assert overrides["photo-0"][1]["canonical_sci"] == "Zosterops simplex"
        assert overrides["photo-0"][1]["canonical_zh"] == "暗绿绣眼鸟"

        await set_species_override(db_with_photos, "photo-0", 1, None)

        assert await list_species_overrides(db_with_photos, "lib-1") == {}

    async def test_species_override_rejects_unknown_photo(
        self,
        db_with_photos: Database,
    ) -> None:
        with pytest.raises(RuntimeError, match="Photo not found"):
            await set_species_override(
                db_with_photos,
                "missing",
                0,
                {
                    "canonical_sci": "Zosterops simplex",
                    "canonical_zh": "暗绿绣眼鸟",
                    "canonical_en": "Swinhoe's white-eye",
                },
            )
