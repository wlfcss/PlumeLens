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
        assert len(overrides["photo-0"]) == 1
        record = overrides["photo-0"][0]
        assert record["bird_index"] == 1
        assert record["canonical_sci"] == "Zosterops simplex"
        assert record["canonical_zh"] == "暗绿绣眼鸟"
        assert record["bbox"] is None  # 没传 bbox → 老 schema 行为

        await set_species_override(db_with_photos, "photo-0", 1, None)

        assert await list_species_overrides(db_with_photos, "lib-1") == {}

    async def test_set_with_bbox_persists_and_returns_in_list(
        self,
        db_with_photos: Database,
    ) -> None:
        """v6 schema: 写入时带 bbox → list 返回应包含 bbox tuple。"""
        await set_species_override(
            db_with_photos,
            "photo-0",
            0,
            {
                "canonical_sci": "Egretta garzetta",
                "canonical_zh": "白鹭",
                "canonical_en": "Little Egret",
            },
            bbox=(100.5, 200.0, 300.0, 400.5),
        )
        overrides = await list_species_overrides(db_with_photos, "lib-1")
        record = overrides["photo-0"][0]
        assert record["bbox"] == (100.5, 200.0, 300.0, 400.5)
        assert record["canonical_sci"] == "Egretta garzetta"

    async def test_set_overwrites_bbox_on_update(
        self,
        db_with_photos: Database,
    ) -> None:
        """同一 (photo, bird_index) 二次写入应覆盖 bbox（用户重新分析后再确认时 bbox 会更新）。"""
        await set_species_override(
            db_with_photos,
            "photo-0",
            0,
            {"canonical_sci": "Sp.A", "canonical_zh": None, "canonical_en": None},
            bbox=(0.0, 0.0, 100.0, 100.0),
        )
        await set_species_override(
            db_with_photos,
            "photo-0",
            0,
            {"canonical_sci": "Sp.A", "canonical_zh": None, "canonical_en": None},
            bbox=(50.0, 50.0, 150.0, 150.0),
        )
        overrides = await list_species_overrides(db_with_photos, "lib-1")
        assert overrides["photo-0"][0]["bbox"] == (50.0, 50.0, 150.0, 150.0)

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

    async def test_clear_after_pipeline_bump_finds_old_row_by_bbox(
        self,
        db_with_photos: Database,
    ) -> None:
        """场景:写入时 bird_index=0、bbox=A;再分析后 caller(UI) 看到该鸟在
        bird_index=2(detections 数组重排) 但 bbox 不变(IoU 命中)。Clear 时 caller 传
        bird_index=2 + bbox=A;后端应 IoU 反查到 DB 的 bird_index=0 行并删,而不是
        按 bird_index=2 找(删错鸟 / 找不到行)。"""
        await set_species_override(
            db_with_photos,
            "photo-0",
            0,
            {"canonical_sci": "Sp.A", "canonical_zh": None, "canonical_en": None},
            bbox=(100.0, 100.0, 200.0, 200.0),
        )

        # 模拟 pipeline_version bump:caller 看到该鸟在新数组的 bird_index=2,bbox 不变
        await set_species_override(
            db_with_photos,
            "photo-0",
            2,
            None,
            bbox=(100.0, 100.0, 200.0, 200.0),
        )

        overrides = await list_species_overrides(db_with_photos, "lib-1")
        assert overrides == {}, "应通过 IoU 反查到 bird_index=0 的行删掉"

    async def test_update_after_pipeline_bump_no_stale_row(
        self,
        db_with_photos: Database,
    ) -> None:
        """同上,但 update 改物种。DB 应仍只有 1 行(原 bird_index=0,species 改 Sp.B,
        bbox 更新为新位置),不留 stale 行让 read-time 匹配产生非确定性。"""
        await set_species_override(
            db_with_photos,
            "photo-0",
            0,
            {"canonical_sci": "Sp.A", "canonical_zh": None, "canonical_en": None},
            bbox=(100.0, 100.0, 200.0, 200.0),
        )

        # caller 看到该鸟在新 bird_index=2,bbox 微动(同一只鸟,IoU 仍 >= 0.3)
        await set_species_override(
            db_with_photos,
            "photo-0",
            2,
            {"canonical_sci": "Sp.B", "canonical_zh": None, "canonical_en": None},
            bbox=(105.0, 105.0, 205.0, 205.0),
        )

        overrides = await list_species_overrides(db_with_photos, "lib-1")
        assert len(overrides["photo-0"]) == 1
        assert overrides["photo-0"][0]["bird_index"] == 0  # PK 保持稳定
        assert overrides["photo-0"][0]["canonical_sci"] == "Sp.B"
        assert overrides["photo-0"][0]["bbox"] == (105.0, 105.0, 205.0, 205.0)

    async def test_set_with_bbox_no_iou_match_creates_new_row(
        self,
        db_with_photos: Database,
    ) -> None:
        """新鸟(与已有 override 的 bbox 都不匹配 IoU)→ 用 caller 传入的 bird_index
        新建一行,不会误覆盖到旧行。"""
        await set_species_override(
            db_with_photos,
            "photo-0",
            0,
            {"canonical_sci": "Sp.A", "canonical_zh": None, "canonical_en": None},
            bbox=(100.0, 100.0, 200.0, 200.0),
        )

        # 不同位置的鸟 — IoU=0,应新建 bird_index=1 行
        await set_species_override(
            db_with_photos,
            "photo-0",
            1,
            {"canonical_sci": "Sp.B", "canonical_zh": None, "canonical_en": None},
            bbox=(500.0, 500.0, 600.0, 600.0),
        )

        overrides = await list_species_overrides(db_with_photos, "lib-1")
        assert len(overrides["photo-0"]) == 2
        bis = sorted(r["bird_index"] for r in overrides["photo-0"])
        assert bis == [0, 1]

    async def test_clear_without_bbox_falls_back_to_bird_index(
        self,
        db_with_photos: Database,
    ) -> None:
        """老 client 不传 bbox(向后兼容)→ 后端按 caller 传入的 bird_index 直接删,
        与 v5 行为一致。"""
        await set_species_override(
            db_with_photos,
            "photo-0",
            0,
            {"canonical_sci": "Sp.A", "canonical_zh": None, "canonical_en": None},
            bbox=(100.0, 100.0, 200.0, 200.0),
        )

        await set_species_override(db_with_photos, "photo-0", 0, None)  # bbox=None

        overrides = await list_species_overrides(db_with_photos, "lib-1")
        assert overrides == {}
