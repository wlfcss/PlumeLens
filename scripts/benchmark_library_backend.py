#!/usr/bin/env python3
"""Run the real PlumeLens API against an isolated, deterministic library.

In analysis mode the controller starts actual inference with POST /analysis/batch
after arranging its start boundary. Both modes run a 5 Hz write-lock probe.
The shared public-domain source exercises the real pipeline, while seeded results
give the library distinct shot times, species, placements and scene memberships.
"""

from __future__ import annotations

import argparse
import asyncio
import ctypes
import hashlib
import importlib
import json
import os
import shutil
import socket
import sys
import time
from collections.abc import AsyncIterator
from contextlib import ExitStack, asynccontextmanager, suppress
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TextIO
from unittest.mock import patch

import uvicorn
from fastapi import FastAPI
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.core.config import settings  # noqa: E402
from engine.core.database import Database  # noqa: E402
from engine.pipeline.models import (  # noqa: E402
    BirdAnalysis,
    BoundingBox,
    Keypoint,
    PipelineResult,
    PoseInfo,
    QualityGrade,
    QualityScores,
    SpeciesCandidate,
)
from engine.services.photo_input import encode_source_fingerprint, source_stamp  # noqa: E402
from engine.services.thumbnail import thumbnail_cache_root  # noqa: E402
from scripts.benchmark_library_trace import (  # noqa: E402
    active_request_id,
    sample_event_loop,
    timing_span,
    trace_gc,
    trace_requests,
)

LIBRARY_ID = "benchmark"
DISPLAY_NAME = "Benchmark library"
FIXTURE_VERSION = "benchmark-seed"
LOCK_LOG = "db-write-lock.jsonl"
READ_LOCK_LOG = "db-read-lock.jsonl"
REQUEST_LOG = "backend-requests.jsonl"
EVENT_LOOP_LOG = "backend-event-loop.jsonl"
GC_LOG = "backend-gc.jsonl"
PROBE_INTERVAL = 0.2
ASSET = ROOT / "resources/species-artwork/passer_montanus.webp"
SHOT_START = datetime(2026, 4, 10, 8, tzinfo=UTC)
SCENE_SIZE = 6
SPECIES = (
    ("Passer montanus", "树麻雀", "Eurasian Tree Sparrow"),
    ("Alcedo atthis", "普通翠鸟", "Common Kingfisher"),
    ("Streptopelia orientalis", "山斑鸠", "Oriental Turtle Dove"),
    ("Pica serica", "东方喜鹊", "Oriental Magpie"),
    ("Pycnonotus sinensis", "白头鹎", "Light-vented Bulbul"),
    ("Motacilla alba", "白鹡鸰", "White Wagtail"),
    ("Anas platyrhynchos", "绿头鸭", "Mallard"),
    ("Ardea cinerea", "苍鹭", "Grey Heron"),
    ("Lanius schach", "棕背伯劳", "Long-tailed Shrike"),
    ("Milvus migrans", "黑鸢", "Black Kite"),
    ("Bambusicola thoracicus", "灰胸竹鸡", "Chinese Bamboo Partridge"),
    ("Turdus merula", "乌鸫", "Common Blackbird"),
)


def _lock_kind() -> str:
    frame = sys._getframe(1)
    while frame is not None:
        name = frame.f_code.co_name
        module = frame.f_globals.get("__name__", "")
        if name == "_lock_probe":
            return "probe"
        if module == "engine.services.library_projection":
            return "projection_read"
        if module == "engine.services.cache":
            return "analysis_publish" if name == "store_result" else "analysis_read"
        if module == "engine.services.queue":
            return {
                "pick_next": "analysis_claim",
                "transition": "analysis_transition",
                "enqueue_photos": "analysis_enqueue",
            }.get(name, "other")
        if module == "engine.services.analyzer":
            return "analysis_read"
        frame = frame.f_back
    return "other"


class MeasuredLock(asyncio.Lock):
    """Measure one application mutex without changing its transactions."""

    def __init__(self, output: TextIO, *, profiling: bool = False) -> None:
        super().__init__()
        self.output = output
        self.started_ns = 0
        self.acquired_ns = 0
        self.kind = "other"
        self.profiling = profiling
        self.request_id: str | None = None

    async def acquire(self) -> bool:
        kind = _lock_kind()
        started = time.perf_counter_ns()
        acquired = await super().acquire()
        self.acquired_ns = time.perf_counter_ns()
        self.started_ns = started
        self.kind = kind
        if self.profiling:
            self.request_id = active_request_id()
        return acquired

    def release(self) -> None:
        ended = time.perf_counter_ns()
        super().release()
        row = {
            "kind": self.kind,
            "waitMs": (self.acquired_ns - self.started_ns) / 1_000_000,
            "holdMs": (ended - self.acquired_ns) / 1_000_000,
            "atNs": ended,
            "wallNs": time.time_ns(),
        }
        if self.request_id is not None:
            row["requestId"] = self.request_id
        self.output.write(json.dumps(row, separators=(",", ":")) + "\n")


async def _lock_probe(db: Database) -> None:
    while True:
        await asyncio.sleep(PROBE_INTERVAL)
        async with db.transaction():
            pass


def _species_candidate(index: int, confidence: float, state: str) -> SpeciesCandidate:
    scientific, chinese, english = SPECIES[index % len(SPECIES)]
    return SpeciesCandidate(
        canonical_sci=scientific,
        canonical_zh=chinese,
        canonical_en=english,
        confidence=confidence,
        recognition_state=state,
        iucn="LC",
        reject_score=0.19,
        top1_top2_margin=0.65,
    )


def _detection(index: int, width: int, height: int, *, secondary: bool = False) -> BirdAnalysis:
    grade = tuple(QualityGrade)[(index + int(secondary) * 2) % 4]
    score = (0.36, 0.52, 0.65, 0.8)[tuple(QualityGrade).index(grade)] + (index % 10) / 1000
    species_idx = index // SCENE_SIZE if not secondary else index // SCENE_SIZE + 3
    state = "uncertain" if index % 17 == 0 else "recognized"
    top = _species_candidate(species_idx, 0.82 if state == "recognized" else 0.48, state)
    x = width * (0.54 if secondary else 0.13)
    y = height * (0.24 if secondary else 0.19)
    key = Keypoint(x=x + width * 0.12, y=y + height * 0.1, confidence=0.93)
    return BirdAnalysis(
        bbox=BoundingBox(x1=x, y1=y, x2=x + width * 0.3, y2=y + height * 0.57, confidence=0.93),
        quality=QualityScores(clipiqa=score - 0.03, hyperiqa=score + 0.02, combined=score),
        grade=grade,
        pose=PoseInfo(
            bill=key,
            crown=key,
            nape=key,
            left_eye=key,
            right_eye=key,
            belly=key,
            breast=key,
            back=key,
            tail=key,
            left_wing=key,
            right_wing=key,
            head_visible=True,
            eye_visible=True,
            body_visible=True,
            wings_visible=True,
            tail_visible=True,
            view_angle="side",
            facing="left",
            posture="flying" if index % 5 == 1 else "perched",
            posture_confidence=0.92,
            posture_method="classifier",
        ),
        species_candidates=[
            top,
            _species_candidate(species_idx + 1, 0.10, "uncertain"),
            _species_candidate(species_idx + 2, 0.03, "uncertain"),
        ],
        species=top.canonical_zh if state == "recognized" else None,
    )


def _generate_sample(source_dir: Path, data_dir: Path) -> tuple[Path, int, int]:
    representative = source_dir / ".representative.jpg"
    with Image.open(ASSET) as opened:
        image = opened.convert("RGB")
    image.save(representative, "JPEG", quality=92)
    thumbs = thumbnail_cache_root(data_dir)
    for directory, size in (("grid", (300, 300)), ("preview", (900, 900))):
        output = thumbs / directory / "benchmark.jpg"
        output.parent.mkdir(parents=True)
        ImageOps.contain(image, size).save(output, "JPEG", quality=88)
    return representative, image.width, image.height


async def _seed(data_dir: Path, total: int) -> dict[str, object]:
    database_path = data_dir / "plumelens.db"
    if database_path.exists():
        raise FileExistsError(f"Refusing to replace an existing database: {database_path}")
    catalog = data_dir / "source"
    catalog.mkdir(parents=True)
    # Keep each hardlink group below any modest filesystem inode link limit.
    sample, width, height = _generate_sample(catalog, data_dir)
    digest = hashlib.sha256(sample.read_bytes()).hexdigest()
    analyzed_count = 0
    detection_count = 0
    result_bytes = 0
    db = Database(database_path)
    await db.connect()
    try:
        async with db.transaction() as conn:
            await conn.execute(
                "INSERT INTO libraries(id,display_name,parent_path,root_path,status,recursive,"
                "created_at,last_opened_at,last_scanned_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    LIBRARY_ID,
                    DISPLAY_NAME,
                    str(data_dir),
                    str(catalog),
                    "ready",
                    1,
                    SHOT_START.isoformat(),
                    SHOT_START.isoformat(),
                    SHOT_START.isoformat(),
                ),
            )
        for start in range(0, total, 1000):
            shard = catalog / f"set-{start // 1000:03d}"
            shard.mkdir()
            base = shard / ".bytes.jpg"
            shutil.copy2(sample, base)
            indices = range(start, min(start + 1000, total))
            paths = [shard / f"IMG_{index:07d}.jpg" for index in indices]
            for path in paths:
                os.link(base, path)
            files = []
            pending_results = []
            decisions = []
            # Adding a hardlink changes the inode's ctime on some filesystems.
            # Capture its identity after its complete set of names exists.
            stamp = source_stamp(base)
            assert stamp is not None
            for index, path in zip(indices, paths, strict=True):
                photo_id = f"fixture_{index:07d}"
                shot = SHOT_START + timedelta(seconds=index // SCENE_SIZE * 45 + index % SCENE_SIZE)
                exif = json.dumps(
                    {
                        "Make": "Nikon" if index % 2 else "Sony",
                        "Model": "Z 8" if index % 2 else "ILCE-1",
                        "LensModel": "600mm f/4",
                        "Orientation": 1,
                        "FNumber": 4 + index % 4 / 2,
                        "ExposureTime": 1 / (1250 + (index % 4) * 250),
                        "ISOSpeedRatings": 400 * (1 + index % 5),
                        "FocalLength": 600,
                        "DateTimeOriginal": shot.strftime("%Y:%m:%d %H:%M:%S"),
                    },
                    separators=(",", ":"),
                )
                files.append(
                    (
                        photo_id,
                        str(path),
                        path.name,
                        stamp.size,
                        stamp.mtime,
                        digest,
                        "JPG",
                        width,
                        height,
                        exif,
                        "grid/benchmark.jpg",
                        "preview/benchmark.jpg",
                        index // SCENE_SIZE,
                        shot.isoformat(),
                        LIBRARY_ID,
                    )
                )
                if index % 5 == 0:
                    continue
                primary = _detection(index, width, height)
                birds = [primary]
                if index % 7 == 0:
                    birds.append(_detection(index, width, height, secondary=True))
                payload = PipelineResult(
                    photo_id=photo_id,
                    detections=birds,
                    best=primary,
                    bird_count=len(birds),
                    pipeline_version=FIXTURE_VERSION,
                    duration_ms=430,
                    image_width=width,
                    image_height=height,
                ).model_dump_json()
                pending_results.append(
                    (
                        f"result_{index:07d}",
                        photo_id,
                        FIXTURE_VERSION,
                        payload,
                        primary.quality.combined,
                        primary.grade.value,
                        len(birds),
                        primary.species,
                        shot.isoformat(),
                        digest,
                        str(path),
                        digest,
                        encode_source_fingerprint(path, stamp, None, None),
                    )
                )
                if index % 43 == 0:
                    decisions.append((photo_id, "select", shot.isoformat()))
                analyzed_count += 1
                detection_count += len(birds)
                result_bytes += len(payload.encode("utf-8"))
            async with db.transaction() as conn:
                await conn.executemany(
                    "INSERT INTO photos(id,file_path,file_name,file_size,file_mtime,file_hash,"
                    "format,width,height,exif_json,thumb_grid,thumb_preview,scene_id,created_at,"
                    "library_id) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    files,
                )
                await conn.executemany(
                    "INSERT INTO analysis_results(id,photo_id,pipeline_version,result_json,"
                    "quality_score,grade,bird_count,species,created_at,input_hash,source_path,"
                    "source_hash,source_fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    pending_results,
                )
                await conn.executemany(
                    "INSERT INTO photo_decisions(photo_id,decision,updated_at) VALUES(?,?,?)",
                    decisions,
                )
    finally:
        await db.close()
    return {
        "preanalyzed": analyzed_count,
        "analysisEligible": total - analyzed_count,
        "scenes": (total + SCENE_SIZE - 1) // SCENE_SIZE,
        "detections": detection_count,
        "meanResultBytes": round(result_bytes / max(1, analyzed_count), 1),
        "sourceArtifact": str(ASSET.relative_to(ROOT)),
        "sourceShape": [width, height],
        "sourceDiskLayout": "one hardlink backing file per 1000 photos",
        "probeIntervalMs": round(PROBE_INTERVAL * 1000),
    }


class _DarwinTaskInfo(ctypes.Structure):
    # sys/proc_info.h struct proc_taskinfo. Remaining fields only set buffer size.
    _fields_ = [
        ("virtual_size", ctypes.c_uint64),
        ("resident_size", ctypes.c_uint64),
        ("activity_times", ctypes.c_uint64 * 4),
        ("activity_counts", ctypes.c_int32 * 12),
    ]


def _backend_memory() -> dict[str, int | None]:
    resident = None
    peak = None
    if sys.platform == "darwin":
        info = _DarwinTaskInfo()
        query = ctypes.CDLL("/usr/lib/libproc.dylib").proc_pidinfo
        query.argtypes = [
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_uint64,
            ctypes.c_void_p,
            ctypes.c_int,
        ]
        query.restype = ctypes.c_int
        size = ctypes.sizeof(info)
        if query(os.getpid(), 4, 0, ctypes.byref(info), size) == size:  # PROC_PIDTASKINFO
            resident = info.resident_size
    elif sys.platform.startswith("linux"):
        usage = Path("/proc/self/statm").read_text(encoding="ascii").split()
        resident = int(usage[1]) * os.sysconf("SC_PAGE_SIZE")
    if os.name == "posix":
        import resource

        raw_peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        peak = int(raw_peak) if sys.platform == "darwin" else int(raw_peak * 1024)
    return {"wallNs": time.time_ns(), "rssBytes": resident, "rssPeakBytes": peak}


async def _serve(args: argparse.Namespace) -> None:
    data_dir = args.data_dir.resolve()
    details = await _seed(data_dir, args.photos)
    settings.data_dir = data_dir
    settings.parent_pid = None
    settings.api_token = None
    settings.require_api_token = False
    settings.log_level = "WARNING"
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

    from engine.main import create_app

    app = create_app()
    production_lifespan = app.router.lifespan_context
    lifespan_module = importlib.import_module("engine.core.lifespan")
    write_lock_path = data_dir / LOCK_LOG
    read_lock_path = data_dir / READ_LOCK_LOG
    request_path = data_dir / REQUEST_LOG
    loop_path = data_dir / EVENT_LOOP_LOG
    gc_path = data_dir / GC_LOG
    profiling = os.environ.get("PLUMELENS_BENCHMARK_PROFILING") == "1"
    with ExitStack() as stack:
        writes = stack.enter_context(write_lock_path.open("w", encoding="utf-8", buffering=1))
        reads = stack.enter_context(read_lock_path.open("w", encoding="utf-8", buffering=1))
        if profiling:
            requests = stack.enter_context(request_path.open("w", encoding="utf-8", buffering=1))
            loop_delays = stack.enter_context(loop_path.open("w", encoding="utf-8", buffering=1))
            gc_events = stack.enter_context(gc_path.open("w", encoding="utf-8", buffering=1))
            stack.enter_context(trace_gc(gc_events))
            server_app = stack.enter_context(trace_requests(app, LIBRARY_ID, requests))
        else:
            loop_delays = None
            server_app = app

        class TimedDatabase(Database):
            def __init__(self, path: Path) -> None:
                super().__init__(path)
                self._write_lock = MeasuredLock(writes, profiling=profiling)
                self._read_lock = MeasuredLock(reads, profiling=profiling)

            if profiling:

                @asynccontextmanager
                async def read_snapshot(self):
                    with timing_span("library.sql"):
                        async with super().read_snapshot() as reader:
                            yield reader

        @asynccontextmanager
        async def measured_lifespan(application: FastAPI) -> AsyncIterator[None]:
            with patch.object(lifespan_module, "Database", TimedDatabase):
                async with production_lifespan(application):
                    db = application.state.db
                    pipeline = application.state.pipeline
                    if not pipeline.is_ready:
                        raise RuntimeError("The production analysis pipeline is unavailable")
                    # Existing results should count as current when the real
                    # batch route decides which rows need their first analysis.
                    async with db.transaction() as conn:
                        await conn.execute(
                            "UPDATE analysis_results SET pipeline_version=?, "
                            "result_json=json_set(result_json,'$.pipeline_version',?) "
                            "WHERE pipeline_version=?",
                            (pipeline.pipeline_version, pipeline.pipeline_version, FIXTURE_VERSION),
                        )
                    probes = [asyncio.create_task(_lock_probe(db))]
                    if loop_delays is not None:
                        probes.append(asyncio.create_task(sample_event_loop(loop_delays)))
                    try:
                        yield
                    finally:
                        for probe in probes:
                            probe.cancel()
                        for probe in probes:
                            with suppress(asyncio.CancelledError):
                                await probe

        app.router.lifespan_context = measured_lifespan
        app.get("/__benchmark/runtime")(_backend_memory)
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
            server = uvicorn.Server(
                uvicorn.Config(
                    server_app, host="127.0.0.1", port=port, log_level="warning", access_log=False
                )
            )
            server_task = asyncio.create_task(server.serve(sockets=[listener]))
            try:
                while not server.started:
                    if server_task.done():
                        await server_task
                        raise RuntimeError("Benchmark backend failed to start")
                    await asyncio.sleep(0.025)
                metadata = {
                    "port": port,
                    "pid": os.getpid(),
                    "libraryId": LIBRARY_ID,
                    "displayName": DISPLAY_NAME,
                    "photoCount": args.photos,
                    "workload": args.mode,
                    "workloadDetails": details,
                    "speciesKeys": [f"sci:{scientific}" for scientific, _, _ in SPECIES],
                    "pipelineVersion": app.state.pipeline.pipeline_version,
                    "providers": app.state.pipeline.model_providers,
                    "analysisConcurrency": settings.analysis_concurrency,
                    "engineLogLevel": settings.log_level,
                    "lockLog": str(write_lock_path),
                    "readLockLog": str(read_lock_path),
                    "readyWallNs": time.time_ns(),
                }
                if profiling:
                    metadata.update(
                        requestTraceLog=str(request_path),
                        eventLoopTraceLog=str(loop_path),
                        gcTraceLog=str(gc_path),
                    )
                port_file = args.port_file.resolve()
                port_file.parent.mkdir(parents=True, exist_ok=True)
                temporary = port_file.with_suffix(port_file.suffix + ".tmp")
                temporary.write_text(
                    json.dumps(metadata, ensure_ascii=False) + "\n", encoding="utf-8"
                )
                temporary.replace(port_file)
                await server_task
            finally:
                if not server_task.done():
                    server.should_exit = True
                    await server_task


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--photos", type=int, required=True)
    parser.add_argument("--mode", choices=("idle", "analysis"), required=True)
    parser.add_argument("--port-file", type=Path, required=True)
    args = parser.parse_args()
    if args.photos < 1:
        parser.error("--photos must be positive")
    if args.port_file.exists():
        parser.error("--port-file already exists. Use a fresh benchmark directory.")
    asyncio.run(_serve(args))


if __name__ == "__main__":
    main()
