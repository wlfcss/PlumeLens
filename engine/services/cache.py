# pyright: basic
"""Analysis result cache (backed by analysis_results table).

缓存键：`(file_hash, pipeline_version)`

两个关键语义：
1. **同一 photo + 同一 pipeline_version 结果唯一**（UNIQUE 约束保证）
   → 用户手动重新分析时走 INSERT OR REPLACE
2. **每张照片只有一条 is_active**（uq_analysis_active 部分唯一索引保证）
   → 新版本结果落地时需先把该 photo 的其他行置为 inactive

所有查询都以 photo_id 为主键（photos.file_hash 是 photo 的副属性，
由 scanner backfill_hashes 填入；缓存命中需要通过 photo_id 索引）。
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime

import structlog

from engine.core.database import Database
from engine.pipeline.models import PipelineResult

logger = structlog.stdlib.get_logger()


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


async def get_active_result(db: Database, photo_id: str) -> PipelineResult | None:
    """Return the currently active analysis result for a photo, if any."""
    async with db.conn.execute(
        "SELECT result_json FROM analysis_results "
        "WHERE photo_id = ? AND is_active = 1",
        (photo_id,),
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        return None
    return PipelineResult.model_validate_json(str(row["result_json"]))


async def get_result_for_version(
    db: Database, photo_id: str, pipeline_version: str,
) -> PipelineResult | None:
    """Lookup analysis result for a specific (photo, pipeline_version) pair.

    This is the cache hit check in the analyzer path: if we have a result for
    the current pipeline_version, we can reuse it instead of rerunning ONNX.
    """
    async with db.conn.execute(
        "SELECT result_json FROM analysis_results "
        "WHERE photo_id = ? AND pipeline_version = ?",
        (photo_id, pipeline_version),
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        return None
    return PipelineResult.model_validate_json(str(row["result_json"]))


async def store_result(
    db: Database, photo_id: str, result: PipelineResult,
) -> str:
    """Store a fresh analysis result and mark it as the active version.

    保证数据库层约束：
    1. (photo_id, pipeline_version) UNIQUE → INSERT OR REPLACE 允许同版本覆写
    2. uq_analysis_active → 先把该 photo 的其他行置 is_active=0

    Args:
        db: Database instance
        photo_id: 关联 photos.id
        result: 管线输出（含 pipeline_version）

    Returns:
        analysis_results.id（新建或复用的行的 id）
    """
    conn = db.conn
    now = _now_iso()
    result_json = result.model_dump_json()
    quality = (
        result.best.quality.combined if result.best is not None else None
    )
    grade = result.best.grade.value if result.best is not None else None
    species = (
        result.best.species if result.best is not None and result.best.species else None
    )

    # Step 1: 把该 photo 的所有现有行置 inactive（避免 partial unique 冲突）
    await conn.execute(
        "UPDATE analysis_results SET is_active = 0 WHERE photo_id = ?",
        (photo_id,),
    )

    # Step 2: 检查同版本是否已存在（支持"重新分析"覆写语义）
    async with conn.execute(
        "SELECT id FROM analysis_results WHERE photo_id = ? AND pipeline_version = ?",
        (photo_id, result.pipeline_version),
    ) as cur:
        existing = await cur.fetchone()

    if existing is not None:
        # Update existing row and reactivate
        row_id = str(existing["id"])
        await conn.execute(
            "UPDATE analysis_results SET "
            "result_json = ?, quality_score = ?, grade = ?, "
            "bird_count = ?, species = ?, created_at = ?, is_active = 1 "
            "WHERE id = ?",
            (
                result_json, quality, grade, result.bird_count, species, now,
                row_id,
            ),
        )
    else:
        row_id = str(uuid.uuid4())
        await conn.execute(
            "INSERT INTO analysis_results (id, photo_id, pipeline_version, "
            "result_json, quality_score, grade, bird_count, species, "
            "created_at, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
            (
                row_id, photo_id, result.pipeline_version, result_json,
                quality, grade, result.bird_count, species, now,
            ),
        )

    await conn.commit()
    await logger.ainfo(
        "Stored analysis result",
        photo_id=photo_id,
        pipeline_version=result.pipeline_version,
        row_id=row_id,
    )
    return row_id


async def list_versions(db: Database, photo_id: str) -> list[dict]:
    """Return all analysis versions for a photo (for history/diagnostics)."""
    async with db.conn.execute(
        "SELECT id, pipeline_version, quality_score, grade, bird_count, "
        "created_at, is_active FROM analysis_results "
        "WHERE photo_id = ? ORDER BY created_at DESC",
        (photo_id,),
    ) as cur:
        rows = await cur.fetchall()
    return [
        {
            "id": str(r["id"]),
            "pipeline_version": str(r["pipeline_version"]),
            "quality_score": (
                float(r["quality_score"]) if r["quality_score"] is not None else None
            ),
            "grade": (str(r["grade"]) if r["grade"] is not None else None),
            "bird_count": int(r["bird_count"]),
            "created_at": str(r["created_at"]),
            "is_active": bool(int(r["is_active"])),
        }
        for r in rows
    ]


async def invalidate_photo(db: Database, photo_id: str) -> int:
    """Delete all analysis rows for a photo (hard invalidation)."""
    async with db.conn.execute(
        "DELETE FROM analysis_results WHERE photo_id = ?", (photo_id,),
    ) as cur:
        deleted = cur.rowcount or 0
    await db.conn.commit()
    return int(deleted)


async def invalidate_old_versions(
    db: Database, keep_version: str, dry_run: bool = False,
) -> int:
    """Optionally delete analysis rows that don't match the current pipeline_version.

    Use cautiously — TECHNICAL_SPEC §5.1 says旧版本结果永久保留。
    该函数仅在用户显式"清理历史版本"时调用。
    """
    if dry_run:
        async with db.conn.execute(
            "SELECT COUNT(*) FROM analysis_results WHERE pipeline_version != ?",
            (keep_version,),
        ) as cur:
            row = await cur.fetchone()
        return int(row[0]) if row else 0

    # 不能删当前 active（即使 version 不符，也应该等新版本先就位）
    async with db.conn.execute(
        "DELETE FROM analysis_results WHERE pipeline_version != ? AND is_active = 0",
        (keep_version,),
    ) as cur:
        deleted = cur.rowcount or 0
    await db.conn.commit()
    return int(deleted)


def _dump_json(obj: object) -> str:
    """Utility — serialize anything to JSON (used by some callers directly)."""
    return json.dumps(obj, ensure_ascii=False, default=str)
