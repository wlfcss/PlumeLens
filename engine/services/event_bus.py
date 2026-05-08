# pyright: strict
"""Small in-process event fanout for local desktop SSE streams."""

from __future__ import annotations

import asyncio
from contextlib import suppress
from datetime import UTC, datetime
from typing import Any

import structlog

MAX_EVENT_QUEUE_SIZE = 128

# 单 library 最多允许的并发 SSE 连接数。
#
# 单进程本地桌面应用,正常 renderer 顶多 1 个长连接(再加 hot-reload 偶发 2 个);
# 8 给充足缓冲(开发期 strict-mode + Playwright + 真应用同时跑也够),也阻止
# 恶意/失控调用方靠不停 open EventSource 把 _subscribers 拖到几千 queue 级别
# 占满 RAM(每个 queue 维护 128 个 event,理论可能 ~MB 级泄漏)。
MAX_SSE_PER_LIBRARY = 8


class TooManySubscribersError(RuntimeError):
    """Raised when SSE subscriber cap is reached for a library."""

    def __init__(self, library_id: str, limit: int) -> None:
        super().__init__(f"library {library_id!r} already has {limit} active SSE subscribers")
        self.library_id = library_id
        self.limit = limit


LibraryEvent = dict[str, Any]

_subscribers: dict[str, set[asyncio.Queue[LibraryEvent]]] = {}
logger = structlog.stdlib.get_logger()


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def subscribe_library_events(library_id: str) -> asyncio.Queue[LibraryEvent]:
    """Register one SSE client queue for a library.

    Raises:
        TooManySubscribersError: when the library already has
            ``MAX_SSE_PER_LIBRARY`` active queues. Caller (route handler)
            converts to HTTP 429 — protects against renderer leak / abuse
            that would otherwise pin RAM.
    """
    bucket = _subscribers.setdefault(library_id, set())
    if len(bucket) >= MAX_SSE_PER_LIBRARY:
        raise TooManySubscribersError(library_id, MAX_SSE_PER_LIBRARY)
    queue: asyncio.Queue[LibraryEvent] = asyncio.Queue(maxsize=MAX_EVENT_QUEUE_SIZE)
    bucket.add(queue)
    return queue


def unsubscribe_library_events(library_id: str, queue: asyncio.Queue[LibraryEvent]) -> None:
    """Remove one SSE client queue."""
    subscribers = _subscribers.get(library_id)
    if subscribers is None:
        return
    subscribers.discard(queue)
    if not subscribers:
        _subscribers.pop(library_id, None)


def publish_library_event(
    library_id: str,
    event_type: str,
    payload: dict[str, Any] | None = None,
) -> None:
    """Fan out a library event to connected local UI clients.

    This is intentionally best-effort. If a renderer is slow, we drop its oldest
    queued event and keep the latest state transition moving.
    """
    subscribers = list(_subscribers.get(library_id, ()))
    if not subscribers:
        return

    event: LibraryEvent = {
        "type": event_type,
        "library_id": library_id,
        "payload": payload or {},
        "created_at": _now_iso(),
    }

    for queue in subscribers:
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            with suppress(asyncio.QueueEmpty):
                queue.get_nowait()
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                logger.warning(
                    "Library event dropped",
                    library_id=library_id,
                    event_type=event_type,
                    subscriber_count=len(subscribers),
                    queue_size=queue.qsize(),
                )
