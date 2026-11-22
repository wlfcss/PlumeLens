"""Opt-in timing hooks for the isolated library benchmark backend."""

from __future__ import annotations

import asyncio
import gc
import json
import os
import time
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from itertools import count
from threading import get_ident
from typing import Any, TextIO
from unittest.mock import patch
from urllib.parse import parse_qs

from fastapi import routing
from starlette.types import ASGIApp, Message, Receive, Scope, Send

REQUEST_HEADER = b"x-plumelens-benchmark-request-id"
_THREAD_STAGES = {
    "exists": "library.path_stat",
    "project_library_photos": "photo_projection",
    "prepare_summary_rows": "summary.prepare",
    "build_selection_projection": "selection_snapshot",
    "projection_revision": "projection_revision",
    "_project_selection": "pinned_selection",
    "_project_live_selection": "live_selection",
}


@dataclass
class _RequestTiming:
    id: str
    spans: list[dict[str, str | int]] = field(default_factory=list[dict[str, str | int]])

    def record(self, name: str, start_ns: int, end_ns: int, cpu_ns: int | None = None) -> None:
        span = {"name": name, "startNs": start_ns, "endNs": end_ns}
        if cpu_ns is not None:
            span["threadCpuNs"] = cpu_ns
        self.spans.append(span)


_active_request: ContextVar[_RequestTiming | None] = ContextVar("benchmark_request", default=None)


def active_request_id() -> str | None:
    trace = _active_request.get()
    return trace.id if trace else None


@contextmanager
def timing_span(name: str, *, cpu: bool = False) -> Iterator[None]:
    trace = _active_request.get()
    if trace is None:
        yield
        return
    start = time.perf_counter_ns()
    cpu_start = time.thread_time_ns() if cpu else None
    try:
        yield
    finally:
        cpu_ns = time.thread_time_ns() - cpu_start if cpu_start is not None else None
        trace.record(name, start, time.perf_counter_ns(), cpu_ns)


class _TimedAsyncio:
    """Keep the production executor and instrument only named request work."""

    def __getattr__(self, name: str) -> Any:
        return getattr(asyncio, name)

    async def to_thread(self, function: Any, /, *args: Any, **kwargs: Any) -> Any:
        trace = _active_request.get()
        stage = _THREAD_STAGES.get(getattr(function, "__name__", ""))
        if trace is None or stage is None:
            return await asyncio.to_thread(function, *args, **kwargs)

        submitted = time.perf_counter_ns()
        finished: int | None = None

        def worker() -> Any:
            nonlocal finished
            trace.record(f"{stage}.queue", submitted, time.perf_counter_ns())
            try:
                with timing_span(f"{stage}.cpu", cpu=True):
                    return function(*args, **kwargs)
            finally:
                finished = time.perf_counter_ns()

        try:
            return await asyncio.to_thread(worker)
        finally:
            if finished is not None:
                trace.record(f"{stage}.resume", finished, time.perf_counter_ns())


class _TimedASGI:
    def __init__(self, app: ASGIApp, library_id: str, output: TextIO) -> None:
        self.app = app
        self.output = output
        self.library_path = f"/library/{library_id}"
        self.selection_path = f"{self.library_path}/selection/query"
        self.ids = count(1)

    def _route(self, scope: Scope) -> str | None:
        if scope["type"] != "http":
            return None
        method, path = scope["method"], scope["path"]
        if method == "GET" and path == self.library_path:
            query = parse_qs(scope["query_string"].decode("ascii", errors="replace"))
            return "library.summary" if query.get("view") == ["summary"] else "library.full"
        if method == "POST" and path == self.selection_path:
            query = parse_qs(scope["query_string"].decode("ascii", errors="replace"))
            return "selection.pinned" if "projection_revision" in query else "selection.live"
        return None

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        route = self._route(scope)
        if route is None:
            await self.app(scope, receive, send)
            return

        start = time.perf_counter_ns()
        start_wall = time.time_ns()
        start_cpu = time.process_time_ns()
        trace = _RequestTiming(f"{os.getpid()}-{next(self.ids)}")
        active = _active_request.set(trace)
        status: int | None = None
        headers: int | None = None
        first_body: int | None = None
        last_body: int | None = None
        body_bytes = 0
        send_ns = 0

        async def timed_send(message: Message) -> None:
            nonlocal status, headers, first_body, last_body, body_bytes, send_ns
            sent = time.perf_counter_ns()
            message_type = message["type"]
            if message_type == "http.response.start":
                status = message["status"]
                headers = sent
                message = {
                    **message,
                    "headers": [*message.get("headers", []), (REQUEST_HEADER, trace.id.encode())],
                }
            elif message_type == "http.response.body":
                if first_body is None:
                    first_body = sent
                body_bytes += len(message.get("body", b""))
            await send(message)
            finished = time.perf_counter_ns()
            send_ns += finished - sent
            if message_type == "http.response.body" and not message.get("more_body", False):
                last_body = finished

        try:
            await self.app(scope, receive, timed_send)
        finally:
            _active_request.reset(active)
            _write_row(
                self.output,
                {
                    "id": trace.id,
                    "route": route,
                    "status": status,
                    "responseBytes": body_bytes,
                    "startedWallNs": start_wall,
                    "startedNs": start,
                    "headersNs": headers,
                    "firstBodyNs": first_body,
                    "lastBodyNs": last_body,
                    "doneNs": time.perf_counter_ns(),
                    "processCpuNs": time.process_time_ns() - start_cpu,
                    "sendNs": send_ns,
                    "spans": sorted(trace.spans, key=lambda span: span["startNs"]),
                },
            )


def _write_row(output: TextIO, row: dict[str, Any]) -> None:
    output.write(json.dumps(row, separators=(",", ":")) + "\n")


async def sample_event_loop(output: TextIO) -> None:
    """Record late wakes; the app cannot directly see waiting before ASGI starts."""
    interval = 0.020
    while True:
        expected = time.perf_counter_ns() + int(interval * 1e9)
        await asyncio.sleep(interval)
        resumed = time.perf_counter_ns()
        if resumed - expected >= 5_000_000:
            _write_row(
                output,
                {"expectedNs": expected, "resumedNs": resumed, "wallNs": time.time_ns()},
            )


@contextmanager
def trace_gc(output: TextIO) -> Iterator[None]:
    """Collect long GC pauses alongside requests without changing the collector."""
    starts: dict[int, tuple[int, int]] = {}

    def record_gc(phase: str, info: dict[str, int]) -> None:
        thread = get_ident()
        if phase == "start":
            starts[thread] = (time.perf_counter_ns(), time.thread_time_ns())
            return
        started = starts.pop(thread, None)
        if started is None:
            return
        ended = time.perf_counter_ns()
        if ended - started[0] < 5_000_000:
            return
        row: dict[str, int | str] = {
            "startNs": started[0],
            "endNs": ended,
            "wallNs": time.time_ns(),
            "threadCpuNs": time.thread_time_ns() - started[1],
            "generation": info["generation"],
            "collected": info["collected"],
            "uncollectable": info["uncollectable"],
            "threadId": thread,
        }
        request_id = active_request_id()
        if request_id is not None:
            row["requestId"] = request_id
        _write_row(output, row)

    gc.callbacks.append(record_gc)
    try:
        yield
    finally:
        gc.callbacks.remove(record_gc)


@contextmanager
def trace_requests(app: ASGIApp, library_id: str, output: TextIO) -> Iterator[ASGIApp]:
    """Instrument the installed FastAPI stack without changing production modules on disk."""
    from engine.api.routes import library
    from engine.services import library_projection, library_summary, selection

    endpoint = routing.run_endpoint_function
    serialize = routing.serialize_response
    fetch_metadata = library._fetch_library_summary  # pyright: ignore[reportPrivateUsage]
    encode_summary_rows = getattr(library, "_encode_summary_rows", None)
    selection_revision = selection.projection_revision

    async def timed_endpoint(*args: Any, **kwargs: Any) -> Any:
        with timing_span("endpoint"):
            return await endpoint(*args, **kwargs)

    async def timed_serialize(*args: Any, **kwargs: Any) -> Any:
        with timing_span("response.encode", cpu=True):
            return await serialize(*args, **kwargs)

    async def timed_metadata(*args: Any, **kwargs: Any) -> Any:
        with timing_span("library.metadata"):
            return await fetch_metadata(*args, **kwargs)

    def timed_selection_revision(*args: Any, **kwargs: Any) -> str:
        with timing_span("selection_snapshot.revision", cpu=True):
            return selection_revision(*args, **kwargs)

    timed_asyncio = _TimedAsyncio()
    with ExitStack() as stack:
        stack.enter_context(patch.object(routing, "run_endpoint_function", timed_endpoint))
        stack.enter_context(patch.object(routing, "serialize_response", timed_serialize))
        stack.enter_context(patch.object(library, "_fetch_library_summary", timed_metadata))
        stack.enter_context(patch.object(library, "asyncio", timed_asyncio))
        stack.enter_context(patch.object(library_projection, "asyncio", timed_asyncio))
        stack.enter_context(patch.object(library_summary, "asyncio", timed_asyncio))
        stack.enter_context(patch.object(selection, "asyncio", timed_asyncio))
        stack.enter_context(
            patch.object(selection, "projection_revision", timed_selection_revision)
        )
        if encode_summary_rows is not None:

            def timed_summary_rows(*args: Any, **kwargs: Any) -> bytes:
                with timing_span("response.encode", cpu=True):
                    return encode_summary_rows(*args, **kwargs)

            stack.enter_context(patch.object(library, "_encode_summary_rows", timed_summary_rows))
        yield _TimedASGI(app, library_id, output)
