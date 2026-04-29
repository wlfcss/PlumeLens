# pyright: strict
"""Small in-process event fanout for local desktop SSE streams."""

from __future__ import annotations

import asyncio
from contextlib import suppress
from datetime import UTC, datetime
from typing import Any

MAX_EVENT_QUEUE_SIZE = 128

LibraryEvent = dict[str, Any]

_subscribers: dict[str, set[asyncio.Queue[LibraryEvent]]] = {}


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def subscribe_library_events(library_id: str) -> asyncio.Queue[LibraryEvent]:
    """Register one SSE client queue for a library."""
    queue: asyncio.Queue[LibraryEvent] = asyncio.Queue(maxsize=MAX_EVENT_QUEUE_SIZE)
    _subscribers.setdefault(library_id, set()).add(queue)
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
            with suppress(asyncio.QueueFull):
                queue.put_nowait(event)
