"""Tests for engine.services.event_bus — SSE subscriber cap (H3)."""

from __future__ import annotations

import pytest
from engine.services.event_bus import (
    MAX_SSE_PER_LIBRARY,
    TooManySubscribersError,
    publish_library_event,
    subscribe_library_events,
    unsubscribe_library_events,
)


def test_subscribe_allows_up_to_limit() -> None:
    queues = [subscribe_library_events("lib-1") for _ in range(MAX_SSE_PER_LIBRARY)]
    assert len(queues) == MAX_SSE_PER_LIBRARY
    for q in queues:
        unsubscribe_library_events("lib-1", q)


def test_subscribe_rejects_above_limit() -> None:
    queues = [subscribe_library_events("lib-2") for _ in range(MAX_SSE_PER_LIBRARY)]
    try:
        with pytest.raises(TooManySubscribersError) as exc_info:
            subscribe_library_events("lib-2")
        assert exc_info.value.library_id == "lib-2"
        assert exc_info.value.limit == MAX_SSE_PER_LIBRARY
    finally:
        for q in queues:
            unsubscribe_library_events("lib-2", q)


def test_unsubscribe_releases_slot() -> None:
    # 占满
    queues = [subscribe_library_events("lib-3") for _ in range(MAX_SSE_PER_LIBRARY)]
    # 释放一个 — 下一个 subscribe 应该能成功
    unsubscribe_library_events("lib-3", queues[0])
    extra = subscribe_library_events("lib-3")
    try:
        assert extra is not None
    finally:
        unsubscribe_library_events("lib-3", extra)
        for q in queues[1:]:
            unsubscribe_library_events("lib-3", q)


def test_publish_with_no_subscribers_is_noop() -> None:
    # 不抛错;最常见路径(scene grouping 后台跑,无 renderer 连接时 publish 缩略图就绪)
    publish_library_event("lib-empty", "thumbnail_ready", {"photo_id": "p1"})
