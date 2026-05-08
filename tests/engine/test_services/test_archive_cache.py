"""Tests for engine.services.archive_cache.

Round-7 修复:archive 聚合缓存 + 写入路径 invalidate 钩子。
测试覆盖:
1. 基础 get/put/invalidate/size 行为
2. TTL 过期清除
3. LRU 上限驱逐
4. cache.store_result 落地后调 invalidate
5. decisions.set_decision / set_decisions_batch / set_species_override 调 invalidate
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest
from engine.core.database import Database
from engine.services import archive_cache


def setup_function() -> None:
    """每个测试开始前清空全局 cache 状态,避免相互污染。"""
    archive_cache.invalidate()


# ---------------------------------------------------------------------------
# 基础 get/put/invalidate
# ---------------------------------------------------------------------------


def test_get_returns_none_when_empty() -> None:
    assert archive_cache.get("missing") is None
    assert archive_cache.size() == 0


def test_put_then_get_within_ttl() -> None:
    archive_cache.put("k1", [1, 2, 3])
    assert archive_cache.get("k1") == [1, 2, 3]
    assert archive_cache.size() == 1


def test_put_returns_value() -> None:
    """put 返回 value,便于链式调用。"""
    out = archive_cache.put("k", {"a": 1})
    assert out == {"a": 1}


def test_invalidate_clears_all() -> None:
    archive_cache.put("a", 1)
    archive_cache.put("b", 2)
    archive_cache.put("c", 3)
    archive_cache.invalidate()
    assert archive_cache.get("a") is None
    assert archive_cache.get("b") is None
    assert archive_cache.get("c") is None
    assert archive_cache.size() == 0


def test_distinct_keys_isolated() -> None:
    archive_cache.put("provinces", ["a"])
    archive_cache.put("cities:江苏省", ["b"])
    assert archive_cache.get("provinces") == ["a"]
    assert archive_cache.get("cities:江苏省") == ["b"]


# ---------------------------------------------------------------------------
# TTL 过期
# ---------------------------------------------------------------------------


def test_get_evicts_after_ttl(monkeypatch: pytest.MonkeyPatch) -> None:
    """超过 TTL 的条目应在下次 get 时返回 None 并清掉。"""
    archive_cache.put("k", [1])
    assert archive_cache.size() == 1

    base = time.monotonic()
    monkeypatch.setattr(
        archive_cache,
        "monotonic",
        lambda: base + archive_cache.GEO_CACHE_TTL_SECONDS + 1,
    )
    assert archive_cache.get("k") is None
    assert archive_cache.size() == 0


# ---------------------------------------------------------------------------
# LRU 上限
# ---------------------------------------------------------------------------


def test_lru_eviction_drops_oldest() -> None:
    """超 64 上限时,最旧条目应被踢出。"""
    cap = archive_cache.GEO_CACHE_MAX_ENTRIES
    for i in range(cap):
        archive_cache.put(f"k{i}", i)
        # 给每条不同的 monotonic 时间戳确保排序稳定
        time.sleep(0.0005)
    assert archive_cache.size() == cap
    # 再 put 一个 → 总数仍为 cap,最旧 k0 被踢
    archive_cache.put("kN", "new")
    assert archive_cache.size() == cap
    assert archive_cache.get("k0") is None
    assert archive_cache.get("kN") == "new"


# ---------------------------------------------------------------------------
# cache.store_result invalidate 钩子
# ---------------------------------------------------------------------------


@pytest.fixture
async def db(tmp_path: Path) -> Database:
    """空 library 数据库。"""
    db = Database(tmp_path / "archive_cache_test.db")
    await db.connect()
    await db.conn.execute(
        "INSERT INTO libraries (id, display_name, parent_path, root_path, "
        "created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?)",
        ("lib-test", "Test", "/tmp", "/tmp/lib-test", "2026-04-01", "2026-04-01"),
    )
    await db.conn.execute(
        "INSERT INTO photos (id, file_path, file_name, file_size, file_mtime, "
        "exif_json, created_at, library_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            "p1",
            "/tmp/p1.jpg",
            "p1.jpg",
            1000,
            "2026-04-01T00:00:00",
            json.dumps({"Make": "Canon"}),
            "2026-04-01",
            "lib-test",
        ),
    )
    await db.conn.commit()
    yield db
    await db.close()


async def test_store_result_invalidates_archive_cache(db: Database) -> None:
    """新分析结果落地必须清 archive 缓存,否则 10s TTL 内羽迹仍是旧聚合。"""
    from engine.pipeline.models import (
        BirdAnalysis,
        BoundingBox,
        PipelineResult,
        QualityGrade,
        QualityScores,
    )
    from engine.services.cache import store_result

    archive_cache.put("provinces", ["stale"])
    assert archive_cache.get("provinces") == ["stale"]

    bird = BirdAnalysis(
        bbox=BoundingBox(x1=0.0, y1=0.0, x2=10.0, y2=10.0, confidence=0.9),
        quality=QualityScores(clipiqa=0.7, hyperiqa=0.7, combined=0.7),
        grade=QualityGrade.USABLE,
    )
    result = PipelineResult(
        photo_id="p1",
        detections=[bird],
        best=bird,
        bird_count=1,
        pipeline_version="test-v1",
        duration_ms=1.0,
    )
    await store_result(db, "p1", result)

    assert archive_cache.get("provinces") is None, "store_result 后缓存应已清"


# ---------------------------------------------------------------------------
# decisions invalidate 钩子
# ---------------------------------------------------------------------------


async def test_set_decision_invalidates_archive_cache(db: Database) -> None:
    """用户改决策必须立即在羽迹反映 — TTL 内不能再看到旧聚合。"""
    from engine.services.decisions import Decision, set_decision

    archive_cache.put("provinces", ["stale"])
    await set_decision(db, "p1", Decision.SELECT)
    assert archive_cache.get("provinces") is None


async def test_clear_decision_invalidates_archive_cache(db: Database) -> None:
    from engine.services.decisions import Decision, set_decision

    await set_decision(db, "p1", Decision.SELECT)  # 先写一个
    archive_cache.put("provinces", ["stale"])
    await set_decision(db, "p1", None)  # 再清
    assert archive_cache.get("provinces") is None


async def test_set_decisions_batch_invalidates_archive_cache(db: Database) -> None:
    """批量决策(连拍 keep best 1)是 archive cache 最容易失效的场景之一。"""
    from engine.services.decisions import Decision, set_decisions_batch

    archive_cache.put("provinces", ["stale"])
    await set_decisions_batch(db, [("p1", Decision.SELECT)])
    assert archive_cache.get("provinces") is None


async def test_set_species_override_invalidates_archive_cache(db: Database) -> None:
    """手工修正鸟种后,羽迹物种墙 + 三级地图聚合都要重算。"""
    from engine.services.decisions import set_species_override

    archive_cache.put("provinces", ["stale"])
    await set_species_override(
        db,
        "p1",
        bird_index=0,
        species={
            "canonical_sci": "Cyanistes caeruleus",
            "canonical_zh": "蓝山雀",
            "canonical_en": "Eurasian Blue Tit",
        },
    )
    assert archive_cache.get("provinces") is None


async def test_clear_species_override_invalidates_archive_cache(db: Database) -> None:
    from engine.services.decisions import set_species_override

    # 先写一个 override
    await set_species_override(
        db,
        "p1",
        bird_index=0,
        species={
            "canonical_sci": "Cyanistes caeruleus",
            "canonical_zh": "蓝山雀",
            "canonical_en": "Eurasian Blue Tit",
        },
    )
    archive_cache.put("provinces", ["stale"])
    # 再清
    await set_species_override(db, "p1", bird_index=0, species=None)
    assert archive_cache.get("provinces") is None
