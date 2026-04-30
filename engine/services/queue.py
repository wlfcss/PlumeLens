# pyright: basic
"""Batch analysis task queue with state machine (TECHNICAL_SPEC §5.1)."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum

import structlog

from engine.core.database import Database

logger = structlog.stdlib.get_logger()


class TaskStatus(StrEnum):
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    DEAD = "dead"
    CANCELLED = "cancelled"
    PAUSED = "paused"


# 合法状态转换（状态机严格管控，非法转换抛异常）
_LEGAL_TRANSITIONS: dict[TaskStatus, set[TaskStatus]] = {
    TaskStatus.PENDING: {TaskStatus.PROCESSING, TaskStatus.CANCELLED},
    TaskStatus.PROCESSING: {
        TaskStatus.COMPLETED,
        TaskStatus.FAILED,
        TaskStatus.PAUSED,
        TaskStatus.CANCELLED,
    },
    TaskStatus.FAILED: {TaskStatus.PENDING, TaskStatus.DEAD, TaskStatus.CANCELLED},
    TaskStatus.PAUSED: {TaskStatus.PENDING, TaskStatus.CANCELLED},
    # Terminal states：不允许再转出
    TaskStatus.COMPLETED: set(),
    TaskStatus.DEAD: set(),
    TaskStatus.CANCELLED: set(),
}

MAX_ATTEMPTS: int = 3


class IllegalTransitionError(Exception):
    """Attempted transition violates the state machine."""


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


@dataclass
class Task:
    """Projection of a task_queue row."""

    id: str
    photo_id: str
    library_id: str
    status: TaskStatus
    priority: int
    attempts: int
    error_message: str | None
    created_at: str
    started_at: str | None
    completed_at: str | None


def _row_to_task(row) -> Task:
    return Task(
        id=str(row["id"]),
        photo_id=str(row["photo_id"]),
        library_id=str(row["library_id"]),
        status=TaskStatus(str(row["status"])),
        priority=int(row["priority"]),
        attempts=int(row["attempts"]),
        error_message=(str(row["error_message"]) if row["error_message"] is not None else None),
        created_at=str(row["created_at"]),
        started_at=(str(row["started_at"]) if row["started_at"] is not None else None),
        completed_at=(str(row["completed_at"]) if row["completed_at"] is not None else None),
    )


# ---------------------------------------------------------------------------
# Enqueue
# ---------------------------------------------------------------------------


async def enqueue_photos(
    db: Database,
    library_id: str,
    photo_ids: list[str],
    *,
    priority: int = 0,
    current_pipeline_version: str | None = None,
    force_rerun: bool = False,
) -> int:
    """Enqueue analysis tasks for the given photo_ids.

    幂等性保证（去重维度）：
    1. 跳过已有 pending/processing/paused 任务的 photo（避免分析中再点击）
    2. 若给定 current_pipeline_version 且 force_rerun=False：跳过已经在该 version 完成分析（active）
       的 photo（避免重复点击「开始分析」累积 task_queue）

    没传 current_pipeline_version 时只做规则 1（兼容）。

    Returns: 实际新入队的任务数。
    """
    if not photo_ids:
        return 0

    conn = db.conn
    placeholders = ",".join("?" * len(photo_ids))

    # 规则 1：active task_queue 状态去重
    active_states = (
        TaskStatus.PENDING.value,
        TaskStatus.PROCESSING.value,
        TaskStatus.PAUSED.value,
    )
    active_placeholders = ",".join("?" * len(active_states))
    query_active = (
        f"SELECT photo_id FROM task_queue "
        f"WHERE photo_id IN ({placeholders}) AND status IN ({active_placeholders})"
    )
    async with conn.execute(query_active, (*photo_ids, *active_states)) as cur:
        skip_active = {str(r["photo_id"]) async for r in cur}

    # 规则 2：当前 pipeline_version 已分析过的 photo（active=1）
    skip_done: set[str] = set()
    if current_pipeline_version and not force_rerun:
        query_done = (
            f"SELECT photo_id FROM analysis_results "
            f"WHERE photo_id IN ({placeholders}) "
            f"  AND pipeline_version = ? "
            f"  AND is_active = 1"
        )
        async with conn.execute(
            query_done,
            (*photo_ids, current_pipeline_version),
        ) as cur:
            skip_done = {str(r["photo_id"]) async for r in cur}

    skip = skip_active | skip_done
    inserted = 0
    now = _now_iso()
    for pid in photo_ids:
        if pid in skip:
            continue
        await conn.execute(
            "INSERT INTO task_queue (id, photo_id, library_id, status, priority, "
            "attempts, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
            (str(uuid.uuid4()), pid, library_id, TaskStatus.PENDING.value, priority, now),
        )
        inserted += 1
    await conn.commit()
    await logger.ainfo(
        "Enqueued analysis tasks",
        library_id=library_id,
        requested=len(photo_ids),
        skipped_active=len(skip_active),
        skipped_done=len(skip_done),
        force_rerun=force_rerun,
        inserted=inserted,
    )
    return inserted


async def enqueue_library(
    db: Database,
    library_id: str,
    *,
    priority: int = 0,
    current_pipeline_version: str | None = None,
    force_rerun: bool = False,
) -> int:
    """Enqueue all photos in a library that have file_hash (阶段 2 已完成).

    只对已补齐 SHA-256 的 photo 入队，避免把"还没准备好"的 photo 提前分析。
    传 current_pipeline_version 让 enqueue_photos 跳过已分析的，避免重复点击
    「开始分析」累积 task_queue（之前 bug：3173 个 task / 783 个 photo = 4× 膨胀）。
    """
    async with db.conn.execute(
        "SELECT id FROM photos WHERE library_id = ? AND file_hash IS NOT NULL",
        (library_id,),
    ) as cur:
        rows = await cur.fetchall()
    photo_ids = [str(r["id"]) for r in rows]
    return await enqueue_photos(
        db,
        library_id,
        photo_ids,
        priority=priority,
        current_pipeline_version=current_pipeline_version,
        force_rerun=force_rerun,
    )


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------


async def list_tasks(
    db: Database,
    library_id: str | None = None,
    status: TaskStatus | None = None,
    limit: int = 200,
) -> list[Task]:
    """List tasks filtered by library/status."""
    conditions: list[str] = []
    params: list[object] = []
    if library_id is not None:
        conditions.append("library_id = ?")
        params.append(library_id)
    if status is not None:
        conditions.append("status = ?")
        params.append(status.value)
    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    params.append(limit)
    async with db.conn.execute(
        f"SELECT * FROM task_queue {where} ORDER BY priority DESC, created_at ASC LIMIT ?",
        params,
    ) as cur:
        rows = await cur.fetchall()
    return [_row_to_task(r) for r in rows]


async def get_stats(db: Database, library_id: str | None = None) -> dict[str, int]:
    """Return {status_value: count} for a library (or all libraries)."""
    if library_id is None:
        query = "SELECT status, COUNT(*) AS c FROM task_queue GROUP BY status"
        params: tuple = ()
    else:
        query = "SELECT status, COUNT(*) AS c FROM task_queue WHERE library_id = ? GROUP BY status"
        params = (library_id,)
    stats = {status.value: 0 for status in TaskStatus}
    async with db.conn.execute(query, params) as cur:
        async for row in cur:
            stats[str(row["status"])] = int(row["c"])
    return stats


async def clear_terminal_tasks(db: Database, library_id: str) -> int:
    """Remove old terminal queue rows before a new analysis run starts.

    `task_queue` is the live progress ledger, not an audit log. Keeping completed
    rows from a previous run makes SSE totals grow across reruns (for example
    783 completed + 783 pending = 1566 total). Analysis history is preserved in
    `analysis_results`; stale terminal queue rows can be dropped safely.
    """
    conn = db.conn
    async with conn.execute(
        "DELETE FROM task_queue "
        "WHERE library_id = ? AND status IN ('completed', 'dead', 'cancelled') "
        "RETURNING id",
        (library_id,),
    ) as cur:
        rows = list(await cur.fetchall())
    await conn.commit()
    return len(rows)


async def get_task(db: Database, task_id: str) -> Task | None:
    async with db.conn.execute(
        "SELECT * FROM task_queue WHERE id = ?",
        (task_id,),
    ) as cur:
        row = await cur.fetchone()
    return _row_to_task(row) if row else None


# ---------------------------------------------------------------------------
# Pick next / transitions
# ---------------------------------------------------------------------------


async def pick_next(db: Database, library_id: str | None = None) -> Task | None:
    """Atomically pick the highest-priority pending task and mark it PROCESSING.

    同一 SQLite 连接下通过 BEGIN IMMEDIATE + UPDATE ... WHERE status='pending' 保证原子。
    返回被选中的 task（已切到 PROCESSING）；无待办时返回 None。
    """
    conn = db.conn

    # 选最高优先级 + 最早入队的 pending
    if library_id is None:
        select_sql = (
            "SELECT id FROM task_queue WHERE status = 'pending' "
            "ORDER BY priority DESC, created_at ASC LIMIT 1"
        )
        select_params: tuple = ()
    else:
        select_sql = (
            "SELECT id FROM task_queue WHERE status = 'pending' AND library_id = ? "
            "ORDER BY priority DESC, created_at ASC LIMIT 1"
        )
        select_params = (library_id,)

    async with conn.execute(select_sql, select_params) as cur:
        row = await cur.fetchone()
    if row is None:
        return None
    task_id = str(row["id"])

    # 条件 UPDATE（status 仍是 pending 才执行）防止多个 worker 抢同一条
    now = _now_iso()
    async with conn.execute(
        "UPDATE task_queue SET status = ?, started_at = ? "
        "WHERE id = ? AND status = 'pending' "
        "RETURNING *",
        (TaskStatus.PROCESSING.value, now, task_id),
    ) as cur:
        updated = await cur.fetchone()
    await conn.commit()
    return _row_to_task(updated) if updated else None


async def transition(
    db: Database,
    task_id: str,
    to: TaskStatus,
    *,
    error_message: str | None = None,
) -> Task:
    """Move a task to `to` status, validating against the state machine.

    副作用：
    - PROCESSING：清空 error_message、更新 started_at（如果是首次）
    - COMPLETED / DEAD / CANCELLED：写 completed_at
    - FAILED：累加 attempts，记录 error_message

    Raises:
        IllegalTransitionError: 不合法的转换
        RuntimeError: task 不存在
    """
    task = await get_task(db, task_id)
    if task is None:
        msg = f"Task not found: {task_id}"
        raise RuntimeError(msg)

    legal = _LEGAL_TRANSITIONS[task.status]
    if to not in legal:
        msg = (
            f"Illegal transition: {task.status.value} → {to.value} "
            f"(allowed: {sorted(s.value for s in legal)})"
        )
        raise IllegalTransitionError(msg)

    now = _now_iso()
    conn = db.conn
    params: list[object] = [to.value]
    sets: list[str] = ["status = ?"]

    if to is TaskStatus.PROCESSING:
        sets.append("started_at = COALESCE(started_at, ?)")
        params.append(now)
        sets.append("error_message = NULL")
    elif to in (TaskStatus.COMPLETED, TaskStatus.DEAD, TaskStatus.CANCELLED):
        sets.append("completed_at = ?")
        params.append(now)
        if to is TaskStatus.COMPLETED:
            sets.append("error_message = NULL")
    elif to is TaskStatus.FAILED:
        sets.append("attempts = attempts + 1")
        sets.append("error_message = ?")
        params.append(error_message)
        sets.append("completed_at = ?")
        params.append(now)
    elif to is TaskStatus.PAUSED:
        # keep error_message as-is
        pass
    elif to is TaskStatus.PENDING:
        # 重试：清 completed_at 和 started_at（下次 pick 会设）
        sets.append("started_at = NULL")
        sets.append("completed_at = NULL")
        if error_message is not None:
            sets.append("error_message = ?")
            params.append(error_message)

    params.append(task_id)
    await conn.execute(
        f"UPDATE task_queue SET {', '.join(sets)} WHERE id = ?",
        params,
    )
    await conn.commit()
    updated = await get_task(db, task_id)
    assert updated is not None
    return updated


async def mark_failed_with_retry(
    db: Database,
    task_id: str,
    error: str,
) -> Task:
    """Shorthand: mark FAILED, then auto-requeue to PENDING or DEAD.

    attempts < MAX_ATTEMPTS → FAILED → PENDING（重试）
    attempts >= MAX_ATTEMPTS → FAILED → DEAD（放弃）
    """
    task = await transition(db, task_id, TaskStatus.FAILED, error_message=error)
    if task.attempts < MAX_ATTEMPTS:
        return await transition(db, task_id, TaskStatus.PENDING)
    return await transition(db, task_id, TaskStatus.DEAD)


# ---------------------------------------------------------------------------
# Startup recovery
# ---------------------------------------------------------------------------


async def recover_on_startup(db: Database) -> int:
    """Recover tasks left as PROCESSING when the app crashed.

    策略：processing → pending（重新排队），不计 attempts，避免把 crash 误判为 retry。
    Returns: 恢复的任务数。
    """
    conn = db.conn
    async with conn.execute(
        "UPDATE task_queue SET status = 'pending', started_at = NULL "
        "WHERE status = 'processing' "
        "RETURNING id",
    ) as cur:
        rows = list(await cur.fetchall())
    await conn.commit()
    recovered = len(rows)
    if recovered > 0:
        await logger.ainfo("Recovered processing tasks", count=recovered)
    return recovered


# 一张照片正常分析(YOLO + pose + IQA + species)经验值 ~0.4-1s。冷启 species 第一推
# 包含 backbone JIT/cache 预热,5s 内能过。300s = 5 分钟,远超任何正常推理时长 + 留
# 出 bf16 backbone reload / GIL 拥塞等极端情况的 buffer。超过这个值仍 PROCESSING
# 视为某个 worker 卡死(MPS hang / 死锁 / I/O 永久阻塞),mark_failed 让 attempts 累加,
# 队列恢复推进。
STUCK_TASK_THRESHOLD_SEC = 300


async def mark_stuck_tasks_failed(
    db: Database,
    *,
    threshold_sec: int = STUCK_TASK_THRESHOLD_SEC,
) -> int:
    """Find PROCESSING tasks whose started_at is older than threshold and fail them.

    Used by a periodic background sweeper(lifespan 启动)。被卡死的 task 算一次失败,
    走 mark_failed_with_retry 路径:attempts<MAX → 回 PENDING 重试,>=MAX → DEAD。

    Returns: 处理的 stuck task 数。
    """
    cutoff = (datetime.now(UTC) - timedelta(seconds=threshold_sec)).isoformat()
    conn = db.conn
    async with conn.execute(
        "SELECT id FROM task_queue "
        "WHERE status = ? AND started_at IS NOT NULL AND started_at < ?",
        (TaskStatus.PROCESSING.value, cutoff),
    ) as cur:
        stuck_ids = [str(row["id"]) for row in await cur.fetchall()]

    if not stuck_ids:
        return 0

    handled = 0
    for task_id in stuck_ids:
        try:
            await mark_failed_with_retry(
                db,
                task_id,
                f"Stuck in PROCESSING > {threshold_sec}s — assumed worker hang",
            )
            handled += 1
        except Exception:
            logger.exception("Failed to mark stuck task as failed", task_id=task_id)
    if handled > 0:
        await logger.awarning(
            "Marked stuck tasks as failed",
            count=handled,
            threshold_sec=threshold_sec,
        )
    return handled


# ---------------------------------------------------------------------------
# Pause / resume / cancel batch ops
# ---------------------------------------------------------------------------


async def pause_library(db: Database, library_id: str) -> int:
    """Pause all PROCESSING + PENDING tasks in a library."""
    conn = db.conn
    async with conn.execute(
        "UPDATE task_queue SET status = 'paused' "
        "WHERE library_id = ? AND status IN ('pending', 'processing') "
        "RETURNING id",
        (library_id,),
    ) as cur:
        rows = list(await cur.fetchall())
    await conn.commit()
    return len(rows)


async def resume_library(db: Database, library_id: str) -> int:
    """Resume all PAUSED tasks in a library → PENDING."""
    conn = db.conn
    async with conn.execute(
        "UPDATE task_queue SET status = 'pending' "
        "WHERE library_id = ? AND status = 'paused' "
        "RETURNING id",
        (library_id,),
    ) as cur:
        rows = list(await cur.fetchall())
    await conn.commit()
    return len(rows)


async def cancel_library(db: Database, library_id: str) -> int:
    """Cancel all non-terminal tasks in a library."""
    conn = db.conn
    async with conn.execute(
        "UPDATE task_queue SET status = 'cancelled', completed_at = ? "
        "WHERE library_id = ? AND status IN ('pending', 'processing', 'paused', 'failed') "
        "RETURNING id",
        (_now_iso(), library_id),
    ) as cur:
        rows = list(await cur.fetchall())
    await conn.commit()
    return len(rows)
