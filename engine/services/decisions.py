# pyright: basic
"""Manual photo grading.

The app has one visible grading vocabulary: select / usable / record / reject.
Pipeline results provide the system grade; rows in photo_decisions are manual
overrides and take precedence when present.
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, TypedDict

import aiosqlite
import structlog

from engine.core.database import Database
from engine.services import archive_cache

logger = structlog.stdlib.get_logger()


class Decision(StrEnum):
    """Manual grade override for a photo."""

    SELECT = "select"
    USABLE = "usable"
    RECORD = "record"
    REJECT = "reject"


class SpeciesOverride(TypedDict):
    """Manual species override payload (set 调用方传入)。"""

    canonical_sci: str
    canonical_zh: str | None
    canonical_en: str | None


class SpeciesOverrideRecord(TypedDict):
    """list_species_overrides 返回的记录 — 含 bird_index + bbox 用于 read-time 匹配。

    bbox 是 (x1, y1, x2, y2) 原图像素坐标（与 detection.bbox 同坐标系）。
    None 表示老数据（v5 schema 无 bbox 字段），caller 应 fallback 到 bird_index 匹配。
    """

    bird_index: int
    canonical_sci: str
    canonical_zh: str | None
    canonical_en: str | None
    bbox: tuple[float, float, float, float] | None


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


async def _ensure_photos_exist(db: Database, photo_ids: list[str]) -> None:
    unique_ids = list(dict.fromkeys(photo_ids))
    if not unique_ids:
        return

    found: set[str] = set()
    chunk_size = 500
    for start in range(0, len(unique_ids), chunk_size):
        chunk = unique_ids[start : start + chunk_size]
        placeholders = ",".join("?" for _ in chunk)
        async with db.conn.execute(
            f"SELECT id FROM photos WHERE id IN ({placeholders})",
            chunk,
        ) as cur:
            async for row in cur:
                found.add(str(row["id"]))

    missing = [pid for pid in unique_ids if pid not in found]
    if missing:
        msg = f"Photo not found: {missing[0]}"
        raise RuntimeError(msg)


async def get_decision(db: Database, photo_id: str) -> Decision | None:
    """Lookup the manual grade override for a photo.

    Returns None when the photo has no explicit manual override.
    """
    async with db.read_snapshot() as conn, conn.execute(
        "SELECT decision FROM photo_decisions WHERE photo_id = ?",
        (photo_id,),
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        return None
    return Decision(str(row["decision"]))


async def set_decision(db: Database, photo_id: str, decision: Decision | None) -> Decision | None:
    """Upsert or clear the manual grade override for a photo.

    Raises:
        RuntimeError: photo_id not in photos table.
    """
    async with db.transaction():
        async with db.conn.execute(
            "SELECT 1 FROM photos WHERE id = ?",
            (photo_id,),
        ) as cur:
            if await cur.fetchone() is None:
                msg = f"Photo not found: {photo_id}"
                raise RuntimeError(msg)

        if decision is None:
            await db.conn.execute("DELETE FROM photo_decisions WHERE photo_id = ?", (photo_id,))
        else:
            now = _now_iso()
            # UPSERT: INSERT ... ON CONFLICT DO UPDATE
            await db.conn.execute(
                "INSERT INTO photo_decisions (photo_id, decision, updated_at) "
                "VALUES (?, ?, ?) "
                "ON CONFLICT(photo_id) DO UPDATE SET decision = excluded.decision, "
                "updated_at = excluded.updated_at",
                (photo_id, decision.value, now),
            )
    # Invalidate after COMMIT so concurrent archive readers never repopulate stale state.
    archive_cache.invalidate()
    if decision is None:
        await logger.ainfo("Decision cleared", photo_id=photo_id)
        return None
    await logger.ainfo("Decision set", photo_id=photo_id, decision=decision.value)
    return decision


async def set_decisions_batch(
    db: Database,
    updates: list[tuple[str, Decision | None]],
) -> int:
    """Bulk upsert multiple (photo_id, decision) pairs in one transaction.

    Use-case: "keep best 1" — 把一张置 select，其他置 reject。

    Returns: 成功写入的行数。
    """
    if not updates:
        return 0
    # Deduplicate keeping last-write-wins semantics per photo_id.
    deduped = dict(updates)
    async with db.transaction():
        await _ensure_photos_exist(db, list(deduped.keys()))
        now = _now_iso()
        rows = [(pid, d.value, now) for pid, d in deduped.items() if d is not None]
        clear_ids = [(pid,) for pid, d in deduped.items() if d is None]
        if rows:
            await db.conn.executemany(
                "INSERT INTO photo_decisions (photo_id, decision, updated_at) "
                "VALUES (?, ?, ?) "
                "ON CONFLICT(photo_id) DO UPDATE SET decision = excluded.decision, "
                "updated_at = excluded.updated_at",
                rows,
            )
        if clear_ids:
            await db.conn.executemany(
                "DELETE FROM photo_decisions WHERE photo_id = ?",
                clear_ids,
            )
    # Invalidate after COMMIT so concurrent archive readers see the committed grades.
    archive_cache.invalidate()
    return len(deduped)


async def list_decisions(
    db: Database,
    library_id: str,
) -> dict[str, Decision]:
    """All manual overrides for photos in a library, as {photo_id: Decision}.

    Photos without a row in photo_decisions are omitted.
    """
    async with db.read_snapshot() as conn, conn.execute(
        "SELECT pd.photo_id, pd.decision FROM photo_decisions pd "
        "JOIN photos p ON pd.photo_id = p.id "
        "WHERE p.library_id = ?",
        (library_id,),
    ) as cur:
        rows = await cur.fetchall()
    return {str(r["photo_id"]): Decision(str(r["decision"])) for r in rows}


async def count_by_decision(db: Database, library_id: str) -> dict[str, int]:
    """Summary counts per manual grade for a library."""
    counts = {d.value: 0 for d in Decision}
    async with db.read_snapshot() as conn, conn.execute(
        "SELECT pd.decision, COUNT(*) AS c FROM photo_decisions pd "
        "JOIN photos p ON pd.photo_id = p.id "
        "WHERE p.library_id = ? GROUP BY pd.decision",
        (library_id,),
    ) as cur:
        async for row in cur:
            counts[str(row["decision"])] = int(row["c"])
    return counts


def _iou_xyxy(
    a: tuple[float, float, float, float],
    b: tuple[float, float, float, float],
) -> float:
    """IoU between two (x1,y1,x2,y2) bboxes — 与 routes/library._iou_tuple 同实现，
    write-time 解析稳定身份用。"""
    inter_x1 = max(a[0], b[0])
    inter_y1 = max(a[1], b[1])
    inter_x2 = min(a[2], b[2])
    inter_y2 = min(a[3], b[3])
    inter_w = max(0.0, inter_x2 - inter_x1)
    inter_h = max(0.0, inter_y2 - inter_y1)
    inter = inter_w * inter_h
    if inter <= 0:
        return 0.0
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    union = area_a + area_b - inter
    if union <= 0:
        return 0.0
    return inter / union


# write-time IoU 阈值 — 与 read-time SPECIES_OVERRIDE_MATCH_IOU (0.3) 一致,
# 保证写入和读取看到的是"同一只鸟"。
_SET_OVERRIDE_MATCH_IOU = 0.3


async def _resolve_db_bird_index(
    db: Database,
    photo_id: str,
    input_revision: int,
    caller_bird_index: int,
    bbox: tuple[float, float, float, float] | None,
    *,
    for_clear: bool = False,
) -> int | None:
    """Find the actual DB row's bird_index for this physical bird.

    bbox 给了 → 在当前 input_revision 内按 IoU 反查已存在的 override 行;
    未匹配上时:
    - 清除路径(for_clear=True):仅当 caller_bird_index 是旧版无 bbox 行时删除,
      绝不误删另一只鸟的 override。
    - 写入路径(for_clear=False):若 caller_bird_index 已被另一只带不同 bbox 的鸟占用,
      分配未占用的新 bird_index 避免覆盖另一只鸟的标注。
    """
    if bbox is None:
        return caller_bird_index

    async with db.conn.execute(
        "SELECT bird_index, bbox_x1, bbox_y1, bbox_x2, bbox_y2, input_revision "
        "FROM photo_species_overrides WHERE photo_id = ?",
        (photo_id,),
    ) as cur:
        rows = await cur.fetchall()

    best_iou = 0.0
    best_bi: int | None = None
    existing_indices: set[int] = set()
    caller_row: Any = None
    for row in rows:
        bi = int(row["bird_index"])
        existing_indices.add(bi)
        if int(row["input_revision"]) != input_revision:
            continue
        if bi == caller_bird_index:
            caller_row = row
        x1, y1, x2, y2 = row["bbox_x1"], row["bbox_y1"], row["bbox_x2"], row["bbox_y2"]
        if x1 is None or y1 is None or x2 is None or y2 is None:
            continue
        iou = _iou_xyxy(bbox, (float(x1), float(y1), float(x2), float(y2)))
        if iou > best_iou:
            best_iou = iou
            best_bi = bi
    if best_iou >= _SET_OVERRIDE_MATCH_IOU and best_bi is not None:
        return best_bi

    if for_clear:
        if caller_row is not None and caller_row["bbox_x1"] is None:
            return caller_bird_index
        return None

    # Writing a new override: avoid colliding with a stale revision row or a
    # completely disjoint bird occupying the same index after reorder.
    if caller_bird_index not in existing_indices:
        return caller_bird_index
    if caller_row is not None:
        cx1, cy1, cx2, cy2 = (
            caller_row["bbox_x1"],
            caller_row["bbox_y1"],
            caller_row["bbox_x2"],
            caller_row["bbox_y2"],
        )
        if cx1 is None or cy1 is None or cx2 is None or cy2 is None:
            return caller_bird_index
        if _iou_xyxy(bbox, (float(cx1), float(cy1), float(cx2), float(cy2))) > 0.0:
            return caller_bird_index
    return max(existing_indices) + 1


async def set_species_override(
    db: Database,
    photo_id: str,
    bird_index: int,
    species: SpeciesOverride | None,
    *,
    bbox: tuple[float, float, float, float] | None = None,
) -> SpeciesOverride | None:
    """Set or clear a manual species override for one detected bird.

    `bird_index` 是 caller(UI)看到的 detections 数组位置(不稳定 — pipeline_version
    bump 后可能错配)。`bbox` 是该 detection 当时的原图像素坐标 (x1, y1, x2, y2);
    给了 bbox → 后端先 IoU 反查 DB 已存在的 override 行,以稳定身份 UPSERT/DELETE,
    避免 bump 后删错行 / 留 stale 行。bbox=None 兼容老调用方(v5 schema)。
    """
    target_bird_index: int | None = None
    async with db.transaction():
        if bird_index < 0:
            msg = f"Invalid bird index: {bird_index}"
            raise RuntimeError(msg)

        async with db.conn.execute(
            "SELECT input_revision FROM photos WHERE id = ?",
            (photo_id,),
        ) as cur:
            photo = await cur.fetchone()
            if photo is None:
                msg = f"Photo not found: {photo_id}"
                raise RuntimeError(msg)
            input_revision = int(photo["input_revision"])

        # bbox 给了就 IoU 反查 DB 行的稳定 bird_index;否则按 caller 传入的处理
        target_bird_index = await _resolve_db_bird_index(
            db,
            photo_id,
            input_revision,
            bird_index,
            bbox,
            for_clear=species is None,
        )

        if species is None:
            if target_bird_index is not None:
                await db.conn.execute(
                    "DELETE FROM photo_species_overrides WHERE photo_id = ? AND bird_index = ?",
                    (photo_id, target_bird_index),
                )
        else:
            assert target_bird_index is not None
            now = _now_iso()
            bbox_x1 = bbox[0] if bbox else None
            bbox_y1 = bbox[1] if bbox else None
            bbox_x2 = bbox[2] if bbox else None
            bbox_y2 = bbox[3] if bbox else None
            await db.conn.execute(
                "INSERT INTO photo_species_overrides "
                "(photo_id, bird_index, canonical_sci, canonical_zh, canonical_en, "
                " bbox_x1, bbox_y1, bbox_x2, bbox_y2, updated_at, input_revision) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(photo_id, bird_index) DO UPDATE SET "
                "canonical_sci = excluded.canonical_sci, "
                "canonical_zh = excluded.canonical_zh, "
                "canonical_en = excluded.canonical_en, "
                "bbox_x1 = excluded.bbox_x1, "
                "bbox_y1 = excluded.bbox_y1, "
                "bbox_x2 = excluded.bbox_x2, "
                "bbox_y2 = excluded.bbox_y2, "
                "updated_at = excluded.updated_at, input_revision = excluded.input_revision",
                (
                    photo_id,
                    target_bird_index,
                    species["canonical_sci"],
                    species.get("canonical_zh"),
                    species.get("canonical_en"),
                    bbox_x1,
                    bbox_y1,
                    bbox_x2,
                    bbox_y2,
                    now,
                    input_revision,
                ),
            )

    # Invalidate after COMMIT so concurrent archive reads see the committed override.
    archive_cache.invalidate()
    if species is None:
        await logger.ainfo(
            "Species override cleared",
            photo_id=photo_id,
            caller_bird_index=bird_index,
            db_bird_index=target_bird_index,
        )
        return None
    await logger.ainfo(
        "Species override set",
        photo_id=photo_id,
        caller_bird_index=bird_index,
        db_bird_index=target_bird_index,
        canonical_sci=species["canonical_sci"],
        has_bbox=bbox is not None,
    )
    return species


async def list_species_overrides(
    db: Database,
    library_id: str,
    photo_ids: list[str] | None = None,
    *,
    connection: aiosqlite.Connection | None = None,
) -> dict[str, list[SpeciesOverrideRecord]]:
    """Return manual species overrides in a library, grouped by photo_id.

    Each record carries bird_index + bbox（v6 schema 之后写入的会有 bbox；老数据 None）。
    Caller (library.py) uses bbox 做 IoU 匹配新 detections；老数据 fallback 到 bird_index。
    Pass a connection to read these rows in the caller's snapshot.
    """
    unique_photo_ids: list[str] | None = None
    if photo_ids is not None:
        unique_photo_ids = list(dict.fromkeys(photo_ids))
        if not unique_photo_ids:
            return {}

    out: dict[str, list[SpeciesOverrideRecord]] = {}
    base_sql = (
        "SELECT pso.photo_id, pso.bird_index, pso.canonical_sci, "
        "pso.canonical_zh, pso.canonical_en, "
        "pso.bbox_x1, pso.bbox_y1, pso.bbox_x2, pso.bbox_y2 "
        "FROM photo_species_overrides pso "
        "JOIN photos p ON pso.photo_id = p.id "
        "WHERE p.library_id = ? AND pso.input_revision=p.input_revision"
    )

    conn = db.conn if connection is None else connection

    async def _collect(sql: str, params: tuple[object, ...]) -> None:
        async with conn.execute(sql, params) as cur:
            async for row in cur:
                photo_id = str(row["photo_id"])
                x1 = row["bbox_x1"]
                y1 = row["bbox_y1"]
                x2 = row["bbox_x2"]
                y2 = row["bbox_y2"]
                bbox: tuple[float, float, float, float] | None
                if x1 is not None and y1 is not None and x2 is not None and y2 is not None:
                    bbox = (float(x1), float(y1), float(x2), float(y2))
                else:
                    bbox = None
                record: SpeciesOverrideRecord = {
                    "bird_index": int(row["bird_index"]),
                    "canonical_sci": str(row["canonical_sci"]),
                    "canonical_zh": (
                        str(row["canonical_zh"]) if row["canonical_zh"] is not None else None
                    ),
                    "canonical_en": (
                        str(row["canonical_en"]) if row["canonical_en"] is not None else None
                    ),
                    "bbox": bbox,
                }
                out.setdefault(photo_id, []).append(record)

    if unique_photo_ids is None:
        await _collect(base_sql, (library_id,))
    else:
        chunk_size = 500
        for start in range(0, len(unique_photo_ids), chunk_size):
            chunk = unique_photo_ids[start : start + chunk_size]
            placeholders = ",".join("?" for _ in chunk)
            await _collect(
                f"{base_sql} AND pso.photo_id IN ({placeholders})",
                (library_id, *chunk),
            )
    return out
