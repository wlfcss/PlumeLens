# pyright: basic
"""Manual photo grading.

The app has one visible grading vocabulary: select / usable / record / reject.
Pipeline results provide the system grade; rows in photo_decisions are manual
overrides and take precedence when present.
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import TypedDict

import structlog

from engine.core.database import Database

logger = structlog.stdlib.get_logger()


class Decision(StrEnum):
    """Manual grade override for a photo."""

    SELECT = "select"
    USABLE = "usable"
    RECORD = "record"
    REJECT = "reject"


class SpeciesOverride(TypedDict):
    """Manual species override for one detected bird in a photo."""

    canonical_sci: str
    canonical_zh: str | None
    canonical_en: str | None


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
    async with db.conn.execute(
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
    async with db.conn.execute(
        "SELECT 1 FROM photos WHERE id = ?",
        (photo_id,),
    ) as cur:
        if await cur.fetchone() is None:
            msg = f"Photo not found: {photo_id}"
            raise RuntimeError(msg)

    if decision is None:
        await db.conn.execute("DELETE FROM photo_decisions WHERE photo_id = ?", (photo_id,))
        await db.conn.commit()
        await logger.ainfo("Decision cleared", photo_id=photo_id)
        return None

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
    db: Database,
    updates: list[tuple[str, Decision | None]],
) -> int:
    """Bulk upsert multiple (photo_id, decision) pairs in one transaction.

    Use-case: "keep best 1" — 把一张置 select，其他置 reject。

    Returns: 成功写入的行数。
    """
    if not updates:
        return 0
    await _ensure_photos_exist(db, [pid for pid, _ in updates])
    now = _now_iso()
    rows = [(pid, d.value, now) for pid, d in updates if d is not None]
    clear_ids = [(pid,) for pid, d in updates if d is None]
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
    await db.conn.commit()
    return len(updates)


async def list_decisions(
    db: Database,
    library_id: str,
) -> dict[str, Decision]:
    """All manual overrides for photos in a library, as {photo_id: Decision}.

    Photos without a row in photo_decisions are omitted.
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
    """Summary counts per manual grade for a library."""
    counts = {d.value: 0 for d in Decision}
    async with db.conn.execute(
        "SELECT pd.decision, COUNT(*) AS c FROM photo_decisions pd "
        "JOIN photos p ON pd.photo_id = p.id "
        "WHERE p.library_id = ? GROUP BY pd.decision",
        (library_id,),
    ) as cur:
        async for row in cur:
            counts[str(row["decision"])] = int(row["c"])
    return counts


async def set_species_override(
    db: Database,
    photo_id: str,
    bird_index: int,
    species: SpeciesOverride | None,
) -> SpeciesOverride | None:
    """Set or clear a manual species override for one detected bird.

    `bird_index` is the index in analysis_results.result_json.detections.
    """
    if bird_index < 0:
        msg = f"Invalid bird index: {bird_index}"
        raise RuntimeError(msg)

    async with db.conn.execute(
        "SELECT 1 FROM photos WHERE id = ?",
        (photo_id,),
    ) as cur:
        if await cur.fetchone() is None:
            msg = f"Photo not found: {photo_id}"
            raise RuntimeError(msg)

    if species is None:
        await db.conn.execute(
            "DELETE FROM photo_species_overrides WHERE photo_id = ? AND bird_index = ?",
            (photo_id, bird_index),
        )
        await db.conn.commit()
        await logger.ainfo(
            "Species override cleared",
            photo_id=photo_id,
            bird_index=bird_index,
        )
        return None

    now = _now_iso()
    await db.conn.execute(
        "INSERT INTO photo_species_overrides "
        "(photo_id, bird_index, canonical_sci, canonical_zh, canonical_en, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(photo_id, bird_index) DO UPDATE SET "
        "canonical_sci = excluded.canonical_sci, "
        "canonical_zh = excluded.canonical_zh, "
        "canonical_en = excluded.canonical_en, "
        "updated_at = excluded.updated_at",
        (
            photo_id,
            bird_index,
            species["canonical_sci"],
            species.get("canonical_zh"),
            species.get("canonical_en"),
            now,
        ),
    )
    await db.conn.commit()
    await logger.ainfo(
        "Species override set",
        photo_id=photo_id,
        bird_index=bird_index,
        canonical_sci=species["canonical_sci"],
    )
    return species


async def list_species_overrides(
    db: Database,
    library_id: str,
) -> dict[str, dict[int, SpeciesOverride]]:
    """Return all manual species overrides in a library."""
    out: dict[str, dict[int, SpeciesOverride]] = {}
    async with db.conn.execute(
        "SELECT pso.photo_id, pso.bird_index, pso.canonical_sci, "
        "pso.canonical_zh, pso.canonical_en "
        "FROM photo_species_overrides pso "
        "JOIN photos p ON pso.photo_id = p.id "
        "WHERE p.library_id = ?",
        (library_id,),
    ) as cur:
        async for row in cur:
            photo_id = str(row["photo_id"])
            out.setdefault(photo_id, {})[int(row["bird_index"])] = {
                "canonical_sci": str(row["canonical_sci"]),
                "canonical_zh": (
                    str(row["canonical_zh"]) if row["canonical_zh"] is not None else None
                ),
                "canonical_en": (
                    str(row["canonical_en"]) if row["canonical_en"] is not None else None
                ),
            }
    return out
