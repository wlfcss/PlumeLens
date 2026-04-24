# pyright: basic
"""Photo review decisions (user layer - separate from model grading).

PRODUCT_UX_PLAN §18.1：模型评级（淘汰/记录/可用/精选）与用户决定（未复核/
已选/待定/淘汰）分开。本服务管理后者，持久化到 photo_decisions 表。
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum

import structlog

from engine.core.database import Database

logger = structlog.stdlib.get_logger()


class Decision(StrEnum):
    """User's review decision for a photo."""

    UNREVIEWED = "unreviewed"
    SELECTED = "selected"
    MAYBE = "maybe"
    REJECTED = "rejected"


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


async def get_decision(db: Database, photo_id: str) -> Decision:
    """Lookup the user's decision for a photo.

    Default to UNREVIEWED when the photo has no explicit decision row yet.
    """
    async with db.conn.execute(
        "SELECT decision FROM photo_decisions WHERE photo_id = ?", (photo_id,),
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        return Decision.UNREVIEWED
    return Decision(str(row["decision"]))


async def set_decision(db: Database, photo_id: str, decision: Decision) -> Decision:
    """Upsert the user's decision for a photo.

    Raises:
        RuntimeError: photo_id not in photos table.
    """
    async with db.conn.execute(
        "SELECT 1 FROM photos WHERE id = ?", (photo_id,),
    ) as cur:
        if await cur.fetchone() is None:
            msg = f"Photo not found: {photo_id}"
            raise RuntimeError(msg)

    now = _now_iso()
    # UPSERT: INSERT ... ON CONFLICT DO UPDATE
    await db.conn.execute(
        "INSERT INTO photo_decisions (photo_id, decision, updated_at) "
        "VALUES (?, ?, ?) "
        "ON CONFLICT(photo_id) DO UPDATE SET decision = excluded.decision, "
        "updated_at = excluded.updated_at",
        (photo_id, decision.value, now),
    )
    await db.conn.commit()
    await logger.ainfo("Decision set", photo_id=photo_id, decision=decision.value)
    return decision


async def set_decisions_batch(
    db: Database, updates: list[tuple[str, Decision]],
) -> int:
    """Bulk upsert multiple (photo_id, decision) pairs in one transaction.

    Use-case: "keep best 1" — 把一张置 SELECTED，其他置 REJECTED。

    Returns: 成功写入的行数。
    """
    if not updates:
        return 0
    now = _now_iso()
    rows = [(pid, d.value, now) for pid, d in updates]
    await db.conn.executemany(
        "INSERT INTO photo_decisions (photo_id, decision, updated_at) "
        "VALUES (?, ?, ?) "
        "ON CONFLICT(photo_id) DO UPDATE SET decision = excluded.decision, "
        "updated_at = excluded.updated_at",
        rows,
    )
    await db.conn.commit()
    return len(updates)


async def list_decisions(
    db: Database, library_id: str,
) -> dict[str, Decision]:
    """All decisions for photos in a library, as {photo_id: Decision}.

    Photos without a row in photo_decisions are omitted (callers should default
    to UNREVIEWED for missing keys).
    """
    async with db.conn.execute(
        "SELECT pd.photo_id, pd.decision FROM photo_decisions pd "
        "JOIN photos p ON pd.photo_id = p.id "
        "WHERE p.library_id = ?",
        (library_id,),
    ) as cur:
        rows = await cur.fetchall()
    return {str(r["photo_id"]): Decision(str(r["decision"])) for r in rows}


async def count_by_decision(db: Database, library_id: str) -> dict[str, int]:
    """Summary counts per decision for a library."""
    counts = {d.value: 0 for d in Decision}
    async with db.conn.execute(
        "SELECT pd.decision, COUNT(*) AS c FROM photo_decisions pd "
        "JOIN photos p ON pd.photo_id = p.id "
        "WHERE p.library_id = ? GROUP BY pd.decision",
        (library_id,),
    ) as cur:
        async for row in cur:
            counts[str(row["decision"])] = int(row["c"])
    # 未复核 = 总照片数 - 有决定记录的数
    async with db.conn.execute(
        "SELECT COUNT(*) AS total FROM photos WHERE library_id = ?",
        (library_id,),
    ) as cur:
        total_row = await cur.fetchone()
    total = int(total_row["total"]) if total_row else 0
    with_decision = sum(counts.values())
    counts[Decision.UNREVIEWED.value] = max(0, total - with_decision)
    return counts
