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

import asyncio
import json
import uuid
from datetime import UTC, datetime
from pathlib import Path

import structlog

from engine.core.database import Database
from engine.pipeline.models import PipelineResult
from engine.services import archive_cache
from engine.services.photo_input import SourceChangedError, StalePhotoInputError, source_fingerprint

logger = structlog.stdlib.get_logger()


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


async def get_active_result(db: Database, photo_id: str) -> PipelineResult | None:
    """Return the currently active analysis result for a photo, if any."""
    return await _read_current_result(db, photo_id, None)


async def get_result_for_version(
    db: Database,
    photo_id: str,
    pipeline_version: str,
) -> PipelineResult | None:
    """Reuse only results for the current content and unchanged physical sources."""
    return await _read_current_result(db, photo_id, pipeline_version)


async def _read_current_result(
    db: Database,
    photo_id: str,
    pipeline_version: str | None,
) -> PipelineResult | None:
    # Shared-connection reads must not observe another task's uncommitted
    # publication and subsequently resurrect it after that task rolls back.
    sql = (
        "SELECT ar.result_json,ar.source_fingerprint,p.file_path,p.companion_path "
        "FROM analysis_results ar JOIN photos p ON p.id=ar.photo_id "
        "WHERE ar.photo_id=? AND ar.input_revision=p.input_revision "
        "AND ar.input_hash IS p.file_hash "
    )
    params: tuple[object, ...] = (photo_id,)
    if pipeline_version is None:
        sql += "AND ar.is_active=1"
    else:
        sql += "AND ar.pipeline_version=?"
        params = (photo_id, pipeline_version)
    async with db.transaction() as conn, conn.execute(sql, params) as cur:
        row = await cur.fetchone()
    if row is None:
        return None
    fingerprint = row["source_fingerprint"]
    if fingerprint:
        companion = Path(str(row["companion_path"])) if row["companion_path"] else None
        current = await asyncio.to_thread(
            source_fingerprint, Path(str(row["file_path"])), companion
        )
        if current != fingerprint:
            return None
    return PipelineResult.model_validate_json(str(row["result_json"]))


async def store_result(
    db: Database,
    photo_id: str,
    result: PipelineResult,
    *,
    expected_input_revision: int | None = None,
    source_path: str | None = None,
    source_hash: str | None = None,
    fingerprint: str | None = None,
) -> str:
    """Publish under transaction ownership and reject obsolete in-flight results."""
    async with db.transaction() as conn:
        async with conn.execute(
            "SELECT input_revision,file_hash,file_path,companion_path FROM photos WHERE id=?",
            (photo_id,),
        ) as cur:
            photo = await cur.fetchone()
        if photo is None or (
            expected_input_revision is not None
            and int(photo["input_revision"]) != expected_input_revision
        ):
            raise StalePhotoInputError(f"Photo input changed before publication: {photo_id}")
        if fingerprint is not None:
            companion = Path(str(photo["companion_path"])) if photo["companion_path"] else None
            # Intentionally perform only a short stat inside the owned publish
            # scope; hashing and image/model work remain outside. A lock waiter
            # must not publish a source that changed since its pre-lock check.
            current = source_fingerprint(Path(str(photo["file_path"])), companion)
            if current != fingerprint:
                raise SourceChangedError(
                    photo_id,
                    int(photo["input_revision"]),
                    "Photo source changed before publication",
                )
        if (
            source_path == photo["file_path"]
            and source_hash
            and photo["file_hash"]
            and source_hash != photo["file_hash"]
        ):
            raise SourceChangedError(
                photo_id, int(photo["input_revision"]), "Primary source SHA-256 changed"
            )
        revision = int(photo["input_revision"])
        quality = result.best.quality.combined if result.best is not None else None
        grade = result.best.grade.value if result.best is not None else None
        species = result.best.species if result.best is not None and result.best.species else None
        async with conn.execute(
            "SELECT * FROM analysis_results WHERE photo_id=? AND pipeline_version=?",
            (photo_id, result.pipeline_version),
        ) as cur:
            existing = await cur.fetchone()
        if existing is not None and (
            int(existing["input_revision"]) != revision
            or existing["input_hash"] != photo["file_hash"]
            or (source_hash is not None and existing["source_hash"] != source_hash)
        ):
            # Keep the previous input's exact output and provenance before the
            # main (photo_id,pipeline_version) slot is reused for new content.
            await conn.execute(
                "INSERT INTO analysis_input_history(id,photo_id,pipeline_version,input_revision,"
                "input_hash,source_hash,result_json,snapshot_json,archived_at) "
                "VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
                (
                    str(uuid.uuid4()),
                    photo_id,
                    result.pipeline_version,
                    int(existing["input_revision"]),
                    existing["input_hash"],
                    existing["source_hash"],
                    existing["result_json"],
                    json.dumps(dict(existing)),
                    _now_iso(),
                ),
            )
        row_id = str(existing["id"]) if existing else str(uuid.uuid4())
        await conn.execute("UPDATE analysis_results SET is_active=0 WHERE photo_id=?", (photo_id,))
        await conn.execute(
            "INSERT INTO analysis_results(id,photo_id,pipeline_version,result_json,quality_score,"
            "grade,bird_count,species,created_at,is_active,input_revision,input_hash,source_path,"
            "source_hash,source_fingerprint) VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?,?,?) "
            "ON CONFLICT(photo_id,pipeline_version) DO UPDATE SET result_json=excluded.result_json,"
            "quality_score=excluded.quality_score,grade=excluded.grade,bird_count=excluded.bird_count,"
            "species=excluded.species,created_at=excluded.created_at,is_active=1,"
            "input_revision=excluded.input_revision,input_hash=excluded.input_hash,"
            "source_path=COALESCE(excluded.source_path,analysis_results.source_path),"
            "source_hash=COALESCE(excluded.source_hash,analysis_results.source_hash),"
            "source_fingerprint=COALESCE(excluded.source_fingerprint,analysis_results.source_fingerprint)",
            (
                row_id,
                photo_id,
                result.pipeline_version,
                result.model_dump_json(),
                quality,
                grade,
                result.bird_count,
                species,
                _now_iso(),
                revision,
                photo["file_hash"],
                source_path,
                source_hash,
                fingerprint,
            ),
        )
    archive_cache.invalidate()
    await logger.ainfo(
        "Stored analysis result",
        photo_id=photo_id,
        pipeline_version=result.pipeline_version,
        input_revision=revision,
        row_id=row_id,
    )
    return row_id


async def list_input_history(db: Database, photo_id: str) -> list[dict]:
    """Archived raw results/provenance for previous inputs of this photo path."""
    async with (
        db.transaction() as conn,
        conn.execute(
            "SELECT snapshot_json FROM analysis_input_history WHERE photo_id=? "
            "ORDER BY input_revision DESC,archived_at DESC",
            (photo_id,),
        ) as cur,
    ):
        rows = await cur.fetchall()
    return [json.loads(str(row["snapshot_json"])) for row in rows]


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
    async with db.transaction():
        async with db.conn.execute(
            "DELETE FROM analysis_results WHERE photo_id = ?",
            (photo_id,),
        ) as cur:
            deleted = cur.rowcount or 0
        if deleted:
            archive_cache.invalidate()
        return int(deleted)


async def invalidate_old_versions(
    db: Database,
    keep_version: str,
    dry_run: bool = False,
) -> int:
    """Optionally delete analysis rows that don't match the current pipeline_version.

    Use cautiously — TECHNICAL_SPEC §5.1 says旧版本结果永久保留。
    该函数仅在用户显式"清理历史版本"时调用。
    """
    async with db.transaction():
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
        return int(deleted)


def _dump_json(obj: object) -> str:
    """Utility — serialize anything to JSON (used by some callers directly)."""
    return json.dumps(obj, ensure_ascii=False, default=str)
