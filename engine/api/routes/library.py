# pyright: basic
"""Library management endpoints (import / list / detail / delete / scan)."""

from __future__ import annotations

import asyncio
import json
import sqlite3
import uuid
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import structlog
from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from engine.api.schemas.library import (
    BestDetection,
    BirdDetectionDetail,
    ImportLibraryRequest,
    LibraryDetail,
    LibraryStatus,
    LibrarySummary,
    PhotoRow,
    RelinkLibraryRequest,
    RelinkLibraryResponse,
    SpeciesSource,
    UpdateLibraryRequest,
)
from engine.core.config import settings as app_settings
from engine.core.database import Database
from engine.services import archive_cache
from engine.services.decisions import (
    SpeciesOverride,
    SpeciesOverrideRecord,
    list_species_overrides,
)
from engine.services.event_bus import (
    TooManySubscribersError,
    publish_library_event,
    subscribe_library_events,
    unsubscribe_library_events,
)
from engine.services.geo_constants import UNRESOLVED_COUNTRY
from engine.services.scanner import backfill_hashes, scan_library
from engine.services.thumbnail import (
    delete_thumbnails_for_photos,
    ensure_thumbnails_for_photo,
    generate_library_thumbnails,
    thumbnail_cache_root,
)

logger = structlog.stdlib.get_logger()

router = APIRouter(prefix="/library", tags=["library"])


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _classify_analysis_error(error_msg: str) -> str:
    """把底层错误消息(英文,来自 PIL/rawpy/sweeper)归类为产品语义 code,
    供前端按 locale i18n 显示用户能看懂的文案。"""
    msg = error_msg.lower()
    if "broken data stream" in msg or "image file is truncated" in msg:
        return "broken_image"
    if "cannot identify image" in msg or "unidentifiedimageerror" in msg:
        return "invalid_image"
    if "no such file" in msg or "file not found" in msg:
        return "file_missing"
    if "stuck in processing" in msg:
        return "timeout"
    return "unknown"


async def _backfill_then_thumbnails(db: Database, library_id: str) -> None:
    """阶段 2/3/4/5：补 SHA-256 + 生成缩略图 + 跑场景分组 + GPS reverse geocoding。"""
    await backfill_hashes(db, library_id)
    cache_root = thumbnail_cache_root(app_settings.data_dir)
    await generate_library_thumbnails(db, library_id, cache_root)
    # 缩略图就绪后才能跑场景相似度（用 preview 缩略图算 AKAZE/颜色）
    from engine.services.scene_grouper import regroup_library

    try:
        report = await regroup_library(db, library_id, cache_root)
        publish_library_event(library_id, "scene_groups_ready", report)
    except Exception as e:
        # cv2 未安装/library import 失败不影响其他流程
        await logger.aexception("scene grouping failed", library_id=library_id)
        _ = e

    # 阶段 5：reverse geocoding。之前只有 lifespan 启动期跑过一次,新 import 的
    # library 要等用户下次开应用才有省/市/区字段(羽迹页显示「未解析地点」)。
    # 现在 import 完成后就在 BackgroundTasks 里跑 — 不阻塞响应,完成时通过
    # archive_cache.invalidate 刷新羽迹聚合缓存(backfill_library_locations 内部
    # 已处理)。失败被 try/except 吞,不影响其他 import 流程。
    try:
        from engine.services.location_backfill import backfill_library_locations

        await backfill_library_locations(db, library_id)
    except Exception:
        await logger.aexception("post-import location backfill failed", library_id=library_id)


async def _db(request: Request) -> Database:
    db = getattr(request.app.state, "db", None)
    if db is None:
        raise HTTPException(status_code=503, detail="Database not initialized")
    return db


async def _path_exists(path: str) -> bool:
    return await asyncio.to_thread(Path(path).exists)


async def _sync_library_path_status(db: Database, row: Any) -> LibraryStatus:
    """Keep library.status honest when the source root was moved/renamed externally."""
    current = LibraryStatus(str(row["status"]))
    root_path = str(row["root_path"])
    exists = await _path_exists(root_path)

    if not exists:
        if current != LibraryStatus.PATH_MISSING:
            await db.conn.execute(
                "UPDATE libraries SET status = ? WHERE id = ?",
                (LibraryStatus.PATH_MISSING.value, str(row["id"])),
            )
            await db.conn.commit()
        return LibraryStatus.PATH_MISSING

    if current == LibraryStatus.PATH_MISSING:
        await db.conn.execute(
            "UPDATE libraries SET status = ? WHERE id = ?",
            (LibraryStatus.READY.value, str(row["id"])),
        )
        await db.conn.commit()
        return LibraryStatus.READY

    return current


async def _fetch_library_summary(db: Database, library_id: str) -> LibrarySummary | None:
    async with db.conn.execute(
        "SELECT * FROM libraries WHERE id = ?",
        (library_id,),
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        return None
    status = await _sync_library_path_status(db, row)
    # Counts
    async with db.conn.execute(
        "SELECT COUNT(*) AS c FROM photos WHERE library_id = ?",
        (library_id,),
    ) as cur:
        total_row = await cur.fetchone()
    total = int(total_row["c"]) if total_row else 0
    async with db.conn.execute(
        "SELECT COUNT(*) AS c FROM analysis_results ar "
        "JOIN photos p ON ar.photo_id = p.id "
        "WHERE p.library_id = ? AND ar.is_active = 1",
        (library_id,),
    ) as cur:
        analyzed_row = await cur.fetchone()
    analyzed = int(analyzed_row["c"]) if analyzed_row else 0

    return LibrarySummary(
        id=str(row["id"]),
        display_name=str(row["display_name"]),
        parent_path=str(row["parent_path"]),
        root_path=str(row["root_path"]),
        status=status,
        total_count=total,
        analyzed_count=analyzed,
        recursive=bool(int(row["recursive"])),
        last_opened_at=str(row["last_opened_at"]),
        last_scanned_at=(
            str(row["last_scanned_at"]) if row["last_scanned_at"] is not None else None
        ),
        last_analyzed_at=(
            str(row["last_analyzed_at"]) if row["last_analyzed_at"] is not None else None
        ),
    )


GROUP_SPECIES_MAX_SPAN_SECONDS = 5 * 60
GROUP_SPECIES_MIN_EVIDENCE = 3
GROUP_SPECIES_MIN_SUPPORT_RATIO = 0.60
GROUP_SPECIES_MIN_WINNER_SHARE = 0.62
GROUP_SPECIES_MIN_MARGIN = 0.20
GROUP_SPECIES_MAX_CONFLICT_TOP1_CONF = 0.70


def _clamp01(value: object, default: float = 0.0) -> float:
    if not isinstance(value, (int, float, str)):
        return default
    try:
        number = float(value)
    except Exception:
        return default
    if number < 0:
        return 0.0
    if number > 1:
        return 1.0
    return number


def _parse_time_seconds(value: str) -> float | None:
    try:
        normalized = value.replace("Z", "+00:00")
        return datetime.fromisoformat(normalized).timestamp()
    except Exception:
        return None


def _candidate_sci(candidate: Mapping[str, object]) -> str | None:
    sci = candidate.get("canonical_sci")
    if isinstance(sci, str) and sci.strip():
        return sci.strip()
    return None


def _candidate_display(candidate: Mapping[str, object], sci: str) -> tuple[str, str | None]:
    zh = candidate.get("canonical_zh")
    en = candidate.get("canonical_en")
    name = zh if isinstance(zh, str) and zh else en if isinstance(en, str) and en else sci
    return str(name), str(en) if isinstance(en, str) and en else None


def _species_candidate_confidence(candidate: Mapping[str, object]) -> float:
    return _clamp01(candidate.get("confidence"), default=0.0)


def _species_candidate_state(candidate: Mapping[str, object]) -> str | None:
    state = candidate.get("recognition_state")
    return str(state) if state else None


def _species_candidate_auto_eligible(candidate: Mapping[str, object]) -> bool:
    """Whether a candidate may be used as an automatic species conclusion.

    Legacy v3 results do not carry recognition_state, so `None` remains eligible.
    v4 only allows explicit `recognized`; `uncertain` and `unrecognized` do not
    help form group consensus.
    """
    state = _species_candidate_state(candidate)
    return state is None or state == "recognized"


def _species_candidate_can_follow_consensus(candidate: Mapping[str, object]) -> bool:
    """Whether a top candidate may be overwritten by an already-formed consensus.

    `uncertain` is a review-only single-frame result, but a trusted scene-level
    consensus is stronger evidence. `unrecognized` means the reject head found no
    usable species candidate and should remain out of archive species.
    """
    return _species_candidate_state(candidate) != "unrecognized"


def _best_candidate(photo: PhotoRow) -> tuple[str | None, str | None, float]:
    candidates = photo.best_detection.species_candidates if photo.best_detection else []
    if not candidates:
        return None, None, 0.0
    first = candidates[0]
    if not _species_candidate_auto_eligible(first):
        return None, None, 0.0
    sci = _candidate_sci(first)
    if not sci:
        return None, None, 0.0
    name, _ = _candidate_display(first, sci)
    return sci, name, _species_candidate_confidence(first)


def _top_candidate_for_consensus_follow(
    photo: PhotoRow,
) -> tuple[str | None, str | None, float, str | None]:
    candidates = photo.best_detection.species_candidates if photo.best_detection else []
    if not candidates:
        return None, None, 0.0, None
    first = candidates[0]
    state = _species_candidate_state(first)
    if not _species_candidate_can_follow_consensus(first):
        return None, None, 0.0, state
    sci = _candidate_sci(first)
    if not sci:
        return None, None, 0.0, state
    name, _ = _candidate_display(first, sci)
    return sci, name, _species_candidate_confidence(first), state


def _consensus_photo_weight(photo: PhotoRow) -> float:
    best = photo.best_detection
    if best is None:
        return 0.0
    quality = _clamp01(best.quality.get("combined") if best.quality else photo.quality_score, 0.55)
    bbox_conf = _clamp01(best.bbox.confidence, 0.75)
    pose = best.pose
    if pose is not None and pose.head_visible and pose.eye_visible:
        pose_weight = 1.0
    elif pose is not None and pose.head_visible:
        pose_weight = 0.85
    else:
        pose_weight = 0.65
    return (0.35 + quality * 0.65) * (0.40 + bbox_conf * 0.60) * pose_weight


def _group_span_seconds(photos: list[PhotoRow]) -> float | None:
    values = [v for p in photos if (v := _parse_time_seconds(p.shot_at)) is not None]
    if len(values) < 2:
        return 0.0
    return max(values) - min(values)


def _iou_tuple(
    a: tuple[float, float, float, float],
    b: tuple[float, float, float, float],
) -> float:
    """IoU between two (x1, y1, x2, y2) bboxes (原图像素坐标系)。"""
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


# bird_index 不再是稳定 ID（IoU dedup / pipeline_version bump 让 detections 数组重排
# 会让旧 bird_index 错配到另一只鸟），改为 bbox IoU 匹配。0.3 是宽松阈值 — 用户标注
# 后再次分析,bbox 微调（不同 letterbox / 阈值）也能匹配上;真正不同的鸟 IoU 通常 < 0.2。
SPECIES_OVERRIDE_MATCH_IOU = 0.3


def _match_overrides_to_detections(
    detections_raw: list[dict],
    overrides: list[SpeciesOverrideRecord],
) -> dict[int, SpeciesOverride]:
    """对每个 detection 找最匹配的 manual species override。

    匹配策略（按优先级）:
    1. bbox IoU >= SPECIES_OVERRIDE_MATCH_IOU 的 override（贪心 one-to-one,按
       conf 隐式 — 实际是按 detection 顺序处理）
    2. fallback：老数据（bbox=NULL）按 bird_index 直接匹配,但仅在该 detection_index
       未被 IoU 占用时

    返回 {detection_index: SpeciesOverride}。未匹配的 override silent 忽略（避免
    错配到其他鸟）。
    """
    matched: dict[int, SpeciesOverride] = {}
    used_overrides: set[int] = set()

    detection_bboxes: list[tuple[float, float, float, float] | None] = []
    for d in detections_raw:
        bbox = d.get("bbox") or {}
        try:
            detection_bboxes.append(
                (
                    float(bbox.get("x1", 0)),
                    float(bbox.get("y1", 0)),
                    float(bbox.get("x2", 0)),
                    float(bbox.get("y2", 0)),
                )
            )
        except Exception:
            detection_bboxes.append(None)

    # Pass 1: bbox IoU 匹配（贪心 — 对每个 detection 找当前还能用的最高 IoU override）
    for det_idx, det_bbox in enumerate(detection_bboxes):
        if det_bbox is None:
            continue
        best_iou = 0.0
        best_override_idx: int | None = None
        for ov_idx, ov in enumerate(overrides):
            if ov_idx in used_overrides:
                continue
            ov_bbox = ov["bbox"]
            if ov_bbox is None:
                continue
            iou = _iou_tuple(det_bbox, ov_bbox)
            if iou > best_iou:
                best_iou = iou
                best_override_idx = ov_idx
        if best_iou >= SPECIES_OVERRIDE_MATCH_IOU and best_override_idx is not None:
            ov = overrides[best_override_idx]
            matched[det_idx] = {
                "canonical_sci": ov["canonical_sci"],
                "canonical_zh": ov["canonical_zh"],
                "canonical_en": ov["canonical_en"],
            }
            used_overrides.add(best_override_idx)

    # Pass 2: 老数据 fallback — bbox=NULL 的 override 按 bird_index 直接匹配,
    # 但仅在该 detection_index 还没被 IoU 占用时
    for ov_idx, ov in enumerate(overrides):
        if ov_idx in used_overrides:
            continue
        if ov["bbox"] is not None:
            continue  # 新数据 + 没匹配上 → silent 忽略,避免错配
        bi = ov["bird_index"]
        if 0 <= bi < len(detections_raw) and bi not in matched:
            matched[bi] = {
                "canonical_sci": ov["canonical_sci"],
                "canonical_zh": ov["canonical_zh"],
                "canonical_en": ov["canonical_en"],
            }
            used_overrides.add(ov_idx)

    return matched


def _apply_effective_species(photo: PhotoRow, name: str, sci: str, source: SpeciesSource) -> None:
    photo.species = name
    photo.species_latin = sci
    photo.species_source = source
    if photo.best_detection is not None:
        photo.best_detection.species = name
        photo.best_detection.species_latin = sci
        photo.best_detection.species_source = source
    if photo.detections:
        for detection in photo.detections:
            if detection.is_best:
                detection.species = name
                detection.species_latin = sci
                detection.species_source = source
                break


def _apply_group_species_consensus(photos: list[PhotoRow]) -> None:
    """Apply a read-time group species consensus to single-bird scene groups.

    This deliberately does not write back to analysis_results. The raw model
    result remains visible through model_species/model_species_latin, while the
    effective species used by the UI can be stabilized for obvious same-subject
    bursts.
    """
    groups: dict[int, list[PhotoRow]] = {}
    for photo in photos:
        if photo.scene_id is None:
            continue
        groups.setdefault(photo.scene_id, []).append(photo)

    for group_photos in groups.values():
        if len(group_photos) < 3:
            continue
        span = _group_span_seconds(group_photos)
        if span is not None and span > GROUP_SPECIES_MAX_SPAN_SECONDS:
            continue

        scores: dict[str, float] = {}
        meta: dict[str, tuple[str, str | None]] = {}
        top_support: dict[str, int] = {}
        evidence_count = 0

        for photo in group_photos:
            if photo.bird_count != 1 or photo.best_detection is None:
                continue
            if photo.manual_species and photo.species_latin and photo.species:
                sci = photo.species_latin
                scores[sci] = scores.get(sci, 0.0) + 1.35
                meta.setdefault(sci, (photo.species, None))
                top_support[sci] = top_support.get(sci, 0) + 1
                evidence_count += 1
                continue

            candidates = photo.best_detection.species_candidates
            if not candidates:
                continue
            if not _species_candidate_auto_eligible(candidates[0]):
                continue

            weight = _consensus_photo_weight(photo)
            if weight <= 0:
                continue
            top_sci = None
            added = False
            for index, candidate in enumerate(candidates[:5]):
                sci = _candidate_sci(candidate)
                if not sci:
                    continue
                confidence = _species_candidate_confidence(candidate)
                if confidence < 0.02:
                    continue
                name, en = _candidate_display(candidate, sci)
                meta.setdefault(sci, (name, en))
                # Lower-ranked candidates still count, but less than the model's
                # preferred answer for that one image.
                rank_weight = 1.0 if index == 0 else 0.75
                scores[sci] = scores.get(sci, 0.0) + weight * confidence * rank_weight
                if index == 0:
                    top_sci = sci
                added = True
            if added:
                evidence_count += 1
            if top_sci:
                top_support[top_sci] = top_support.get(top_sci, 0) + 1

        if evidence_count < GROUP_SPECIES_MIN_EVIDENCE or not scores:
            continue

        ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)
        winner_sci, winner_score = ranked[0]
        second_score = ranked[1][1] if len(ranked) > 1 else 0.0
        total_score = sum(scores.values())
        if total_score <= 0:
            continue
        winner_share = winner_score / total_score
        second_share = second_score / total_score
        margin = winner_share - second_share
        support = top_support.get(winner_sci, 0)
        support_ratio = support / evidence_count
        if (
            support_ratio < GROUP_SPECIES_MIN_SUPPORT_RATIO
            or winner_share < GROUP_SPECIES_MIN_WINNER_SHARE
            or margin < GROUP_SPECIES_MIN_MARGIN
        ):
            continue

        winner_name, _winner_en = meta.get(winner_sci, (winner_sci, None))
        confidence = min(
            0.99,
            max(
                0.0,
                0.45 * winner_share + 0.35 * support_ratio + 0.20 * min(1.0, margin * 2.0),
            ),
        )

        for photo in group_photos:
            photo.group_species = winner_name
            photo.group_species_latin = winner_sci
            photo.group_species_confidence = confidence
            photo.group_species_support = support
            photo.group_species_evidence = evidence_count
            photo.group_species_total = len(group_photos)

            if photo.bird_count != 1 or photo.best_detection is None or photo.manual_species:
                continue
            candidates = photo.best_detection.species_candidates
            if not candidates or not _species_candidate_can_follow_consensus(candidates[0]):
                continue
            original_sci, _original_name, original_conf, original_state = (
                _top_candidate_for_consensus_follow(photo)
            )
            if original_sci == winner_sci:
                # 模型 top-1 与共识一致 → 通常不需要改 species_source。但若该照片
                # 当前是 'model_unconfirmed'（head 不可见或 v4 uncertain），共识就
                # 是"代审"信号 → 升级为 'group_consensus' 让它能进羽迹（规则 #3）。
                if photo.species_source == "model_unconfirmed":
                    _apply_effective_species(photo, winner_name, winner_sci, "group_consensus")
                continue
            if (
                original_state != "uncertain"
                and original_sci
                and original_conf > GROUP_SPECIES_MAX_CONFLICT_TOP1_CONF
            ):
                photo.species_conflict = True
                photo.species_source = "conflict"
                if photo.best_detection is not None:
                    photo.best_detection.species_source = "conflict"
                if photo.detections:
                    for detection in photo.detections:
                        if detection.is_best:
                            detection.species_source = "conflict"
                            break
                continue
            _apply_effective_species(photo, winner_name, winner_sci, "group_consensus")


@router.get("", response_model=list[LibrarySummary])
async def list_libraries(request: Request) -> list[LibrarySummary]:
    """GET /library — all libraries, most recently opened first."""
    db = await _db(request)
    async with db.conn.execute(
        "SELECT id FROM libraries ORDER BY last_opened_at DESC",
    ) as cur:
        ids = [str(r["id"]) async for r in cur]
    out: list[LibrarySummary] = []
    for lid in ids:
        summary = await _fetch_library_summary(db, lid)
        if summary is not None:
            out.append(summary)
    return out


@router.get("/{library_id}/events")
async def library_events(request: Request, library_id: str) -> StreamingResponse:
    """GET /library/{id}/events — library-scoped SSE updates.

    Used for thumbnail readiness and scene grouping completion. The renderer can
    refresh the affected query only when the backend reports a state change,
    instead of polling the whole library while background work is running.
    """
    db = await _db(request)
    summary = await _fetch_library_summary(db, library_id)
    if summary is None:
        raise HTTPException(status_code=404, detail="Library not found")

    try:
        queue = subscribe_library_events(library_id)
    except TooManySubscribersError as exc:
        # 单 library 同时打开太多 SSE — renderer 泄漏 / 测试脚本 / 攻击。返
        # 429,客户端节流后再试。Retry-After 给 5s,renderer 重连不会立刻打爆。
        raise HTTPException(
            status_code=429,
            detail=f"Too many SSE subscribers for library (limit {exc.limit})",
            headers={"Retry-After": "5"},
        ) from exc

    async def _stream():
        try:
            snapshot = {
                "type": "library_snapshot",
                "library_id": library_id,
                "payload": {"status": summary.status.value},
                "created_at": _now_iso(),
            }
            yield f"event: library_snapshot\ndata: {json.dumps(snapshot)}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                except TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                event_type = str(event.get("type", "message"))
                payload = json.dumps(event, ensure_ascii=False)
                yield f"event: {event_type}\ndata: {payload}\n\n"
        finally:
            unsubscribe_library_events(library_id, queue)

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/import", response_model=LibrarySummary, status_code=201)
async def import_library(
    request: Request,
    body: ImportLibraryRequest,
    background_tasks: BackgroundTasks,
) -> LibrarySummary:
    """POST /library/import — register a folder and run phase-1 scan.

    阶段 2（SHA-256 backfill）通过 BackgroundTasks 异步进行：
    导入立刻返回，用户可浏览缩略图；哈希在后台补齐，分析任务依赖此哈希就绪。
    """
    db = await _db(request)
    # 纯同步路径操作耗时可忽略，不值得额外 asyncio.to_thread 包装
    root = Path(body.root_path).expanduser().resolve()  # noqa: ASYNC240
    if not root.exists():  # noqa: ASYNC240
        raise HTTPException(status_code=400, detail=f"Path does not exist: {root}")
    if not root.is_dir():  # noqa: ASYNC240
        raise HTTPException(status_code=400, detail=f"Not a directory: {root}")

    display = body.display_name or root.name or "未命名文件夹"
    parent = str(root.parent)
    root_str = str(root)
    now = _now_iso()

    # 如果已存在同 root_path，直接返回（幂等）
    async with db.conn.execute(
        "SELECT id FROM libraries WHERE root_path = ?",
        (root_str,),
    ) as cur:
        existing = await cur.fetchone()

    if existing is not None:
        library_id = str(existing["id"])
        await db.conn.execute(
            "UPDATE libraries SET last_opened_at = ?, status = ? WHERE id = ?",
            (now, LibraryStatus.SCANNING.value, library_id),
        )
    else:
        library_id = str(uuid.uuid4())
        await db.conn.execute(
            "INSERT INTO libraries (id, display_name, parent_path, root_path, "
            "status, recursive, created_at, last_opened_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                library_id,
                display,
                parent,
                root_str,
                LibraryStatus.SCANNING.value,
                1 if body.recursive else 0,
                now,
                now,
            ),
        )
    await db.conn.commit()

    # Phase 1 scan (同步执行，完成后回转 READY；大库可在此处 kick off 异步任务)
    try:
        report = await scan_library(
            db,
            library_id=library_id,
            root=root,
            recursive=body.recursive,
        )
        await db.conn.execute(
            "UPDATE libraries SET status = ?, last_scanned_at = ? WHERE id = ?",
            (LibraryStatus.READY.value, _now_iso(), library_id),
        )
        await db.conn.commit()
        await logger.ainfo(
            "Library imported",
            library_id=library_id,
            root=root_str,
            added=report.added,
            unchanged=report.unchanged,
            updated=report.updated,
        )
        # 阶段 2/3：后台补 SHA-256 + 生成缩略图（不阻塞 import 响应）
        background_tasks.add_task(_backfill_then_thumbnails, db, library_id)
    except Exception:
        await db.conn.execute(
            "UPDATE libraries SET status = ? WHERE id = ?",
            (LibraryStatus.ERROR.value, library_id),
        )
        await db.conn.commit()
        await logger.aexception("Library import scan failed", library_id=library_id)
        raise HTTPException(status_code=500, detail="Scan failed") from None

    summary = await _fetch_library_summary(db, library_id)
    assert summary is not None
    return summary


def _relative_to_root(path: Path, root: Path) -> Path | None:
    try:
        return path.relative_to(root)
    except ValueError:
        try:
            return path.resolve().relative_to(root.resolve())
        except ValueError:
            return None


def _format_from_path(path: Path, fallback: object) -> str | None:
    suffix = path.suffix.lstrip(".").upper()
    if suffix:
        return suffix
    return str(fallback) if fallback is not None else None


@router.post("/{library_id}/relink", response_model=RelinkLibraryResponse)
async def relink_library(
    request: Request,
    library_id: str,
    body: RelinkLibraryRequest,
) -> RelinkLibraryResponse:
    """POST /library/{id}/relink — point a moved/renamed library at a new root.

    The operation preserves photo ids, analysis results, decisions, thumbnails, and
    scene groups. Only absolute source paths are rewritten from old-root-relative
    paths to new-root-relative paths.
    """
    db = await _db(request)
    new_root = Path(body.root_path).expanduser().resolve()  # noqa: ASYNC240
    if not new_root.exists():  # noqa: ASYNC240
        raise HTTPException(status_code=400, detail=f"Path does not exist: {new_root}")
    if not new_root.is_dir():  # noqa: ASYNC240
        raise HTTPException(status_code=400, detail=f"Not a directory: {new_root}")

    async with db.conn.execute(
        "SELECT id, display_name, root_path FROM libraries WHERE id = ?",
        (library_id,),
    ) as cur:
        library = await cur.fetchone()
    if library is None:
        raise HTTPException(status_code=404, detail="Library not found")

    previous_root = Path(str(library["root_path"]))
    previous_root_path = str(previous_root)
    new_root_path = str(new_root)

    async with db.conn.execute(
        "SELECT id FROM libraries WHERE root_path = ? AND id != ?",
        (new_root_path, library_id),
    ) as cur:
        conflict = await cur.fetchone()
    if conflict is not None:
        raise HTTPException(status_code=409, detail="Path is already imported as another library")

    async with db.conn.execute(
        "SELECT id, file_path, file_size, companion_path, companion_format, companion_size "
        "FROM photos WHERE library_id = ?",
        (library_id,),
    ) as cur:
        rows = list(await cur.fetchall())

    updates: list[
        tuple[
            str,
            str | None,
            str | None,
            int | None,
            str,
        ]
    ] = []
    matched = 0
    relinked_companions = 0

    for row in rows:
        old_path = Path(str(row["file_path"]))
        rel = _relative_to_root(old_path, previous_root)
        if rel is None:
            continue

        next_path = new_root / rel
        try:
            if next_path.exists() and next_path.stat().st_size == int(row["file_size"]):
                matched += 1
        except OSError:
            pass

        companion_path: str | None = (
            str(row["companion_path"]) if row["companion_path"] is not None else None
        )
        companion_format: str | None = (
            str(row["companion_format"]) if row["companion_format"] is not None else None
        )
        companion_size: int | None = (
            int(row["companion_size"]) if row["companion_size"] is not None else None
        )
        if companion_path is not None:
            companion_rel = _relative_to_root(Path(companion_path), previous_root)
            if companion_rel is not None:
                next_companion = new_root / companion_rel
                companion_path = str(next_companion)
                companion_format = _format_from_path(next_companion, row["companion_format"])
                try:
                    if next_companion.exists():
                        companion_size = next_companion.stat().st_size
                        relinked_companions += 1
                except OSError:
                    pass

        updates.append(
            (
                str(next_path),
                companion_path,
                companion_format,
                companion_size,
                str(row["id"]),
            )
        )

    if rows:
        relinkable = len(updates)
        if relinkable == 0 or matched == 0:
            raise HTTPException(
                status_code=400,
                detail="New folder does not appear to contain this library's photos",
            )
        if relinkable >= 5 and matched / relinkable < 0.5:
            raise HTTPException(
                status_code=400,
                detail="New folder only matches a small part of this library",
            )

    try:
        await db.conn.execute("BEGIN IMMEDIATE")
        await db.conn.execute(
            "UPDATE libraries SET parent_path = ?, root_path = ?, status = ?, "
            "last_opened_at = ? WHERE id = ?",
            (
                str(new_root.parent),
                new_root_path,
                LibraryStatus.READY.value,
                _now_iso(),
                library_id,
            ),
        )
        for next_path, companion_path, companion_format, companion_size, photo_id in updates:
            await db.conn.execute(
                "UPDATE photos SET file_path = ?, companion_path = ?, companion_format = ?, "
                "companion_size = ? WHERE id = ?",
                (next_path, companion_path, companion_format, companion_size, photo_id),
            )
        await db.conn.commit()
    except sqlite3.IntegrityError as e:
        await db.conn.rollback()
        raise HTTPException(
            status_code=409,
            detail="Relinked paths conflict with existing photos",
        ) from e
    except Exception:
        await db.conn.rollback()
        await logger.aexception("Library relink failed", library_id=library_id)
        raise HTTPException(status_code=500, detail="Relink failed") from None

    summary = await _fetch_library_summary(db, library_id)
    assert summary is not None
    publish_library_event(
        library_id,
        "library_updated",
        {
            "root_path": summary.root_path,
            "status": summary.status.value,
        },
    )
    return RelinkLibraryResponse(
        library=summary,
        previous_root_path=previous_root_path,
        matched_photos=matched,
        relinked_photos=len(updates),
        missing_photos=max(0, len(rows) - matched),
        relinked_companions=relinked_companions,
    )


@router.patch("/{library_id}", response_model=LibrarySummary)
async def update_library(
    request: Request,
    library_id: str,
    body: UpdateLibraryRequest,
) -> LibrarySummary:
    """PATCH /library/{id} — update user-facing folder alias.

    The alias is stored in libraries.display_name, which is also the name used by
    export output folders and manifest metadata.
    """
    db = await _db(request)
    display_name = body.display_name.strip()
    if not display_name:
        raise HTTPException(status_code=400, detail="Display name cannot be empty")

    summary = await _fetch_library_summary(db, library_id)
    if summary is None:
        raise HTTPException(status_code=404, detail="Library not found")

    await db.conn.execute(
        "UPDATE libraries SET display_name = ? WHERE id = ?",
        (display_name, library_id),
    )
    await db.conn.commit()
    updated = await _fetch_library_summary(db, library_id)
    assert updated is not None
    publish_library_event(
        library_id,
        "library_updated",
        {"display_name": updated.display_name},
    )
    return updated


@router.get("/{library_id}", response_model=LibraryDetail)
async def library_detail(
    request: Request,
    library_id: str,
    limit: int | None = Query(default=None, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
) -> LibraryDetail:
    """GET /library/{id} — summary + photos.

    默认保持旧契约一次返回全量照片。传入 limit/offset 时按
    `(library_id, file_mtime)` 索引分页,为大图库前端逐步迁移做准备。
    """
    db = await _db(request)
    summary = await _fetch_library_summary(db, library_id)
    if summary is None:
        raise HTTPException(status_code=404, detail="Library not found")
    photo_total = summary.total_count

    # task_queue 一张 photo 可能存在多行(老的 dead/failed/completed + 新的 pending),
    # 直接 LEFT JOIN 会让 photos 出现重复。挑最新一行(rowid 最大)子查询:
    #   - photo 在 task 里没记录 → tq.* 全 NULL → analysis_status 走 done(若有 result)
    #     或 pending(无 result)的 fallback,不影响正确性
    #   - photo 有多行 task → 取最新那行的 status/error_message,
    #     更准确反映"用户最近一次 batch 的结果"
    select_from_sql = (
        "SELECT p.id, p.file_path, p.file_name, p.format, p.width, p.height, "
        "p.thumb_grid, p.thumb_preview, p.created_at, p.file_mtime, p.exif_json, "
        "p.scene_id, p.companion_path, p.companion_format, p.companion_size, "
        "p.country, p.province, p.city, p.district, p.place, "
        "ar.pipeline_version, ar.grade, ar.quality_score, ar.bird_count, ar.species, "
        "ar.result_json, "
        "pd.decision, "
        "tq.status AS task_status, tq.error_message AS task_error "
        "FROM photos p "
        "LEFT JOIN analysis_results ar ON ar.photo_id = p.id AND ar.is_active = 1 "
        "LEFT JOIN photo_decisions pd ON pd.photo_id = p.id "
        "LEFT JOIN task_queue tq ON tq.rowid = ("
        "    SELECT MAX(rowid) FROM task_queue WHERE photo_id = p.id"
        ") "
    )
    order_by_sql = "ORDER BY p.file_mtime ASC, p.id ASC"
    sql = select_from_sql + f"WHERE p.library_id = ? {order_by_sql}"
    params: tuple[object, ...]
    if limit is not None:
        sql += " LIMIT ? OFFSET ?"
        params = (library_id, limit, offset)
    else:
        params = (library_id,)
    async with db.conn.execute(sql, params) as cur:
        rows = list(await cur.fetchall())

    context_rows = rows
    if limit is not None:
        # Group consensus is computed at read time and needs all photos in the
        # same scene, otherwise a page boundary can hide the votes that should
        # upgrade model_unconfirmed/conflict rows.  Keep pagination cheap by
        # expanding only the scene groups touched by this page.
        scene_ids = sorted({int(row["scene_id"]) for row in rows if row["scene_id"] is not None})
        if scene_ids:
            placeholders = ",".join("?" for _ in scene_ids)
            async with db.conn.execute(
                select_from_sql
                + (f"WHERE p.library_id = ? AND p.scene_id IN ({placeholders}) {order_by_sql}"),
                (library_id, *scene_ids),
            ) as cur:
                expanded_rows = list(await cur.fetchall())
            seen_ids: set[str] = set()
            merged_rows = []
            for row in [*rows, *expanded_rows]:
                photo_id = str(row["id"])
                if photo_id in seen_ids:
                    continue
                seen_ids.add(photo_id)
                merged_rows.append(row)
            context_rows = merged_rows

    import json as _json

    def _parse_exif(raw: object) -> dict | None:
        if not raw:
            return None
        try:
            data = _json.loads(str(raw))
            return data if isinstance(data, dict) else None
        except Exception:
            return None

    def _resolve_shot_at(row: object) -> str:
        """优先级：EXIF DateTimeOriginal > file_mtime > created_at."""
        try:
            exif = row["exif_json"]  # type: ignore[index]
            if exif:
                data = _json.loads(str(exif))
                dto = data.get("DateTimeOriginal")
                if dto and isinstance(dto, str):
                    iso = dto.replace(":", "-", 2).replace(" ", "T")
                    return iso
        except Exception:
            pass
        try:
            mt = row["file_mtime"]  # type: ignore[index]
            if mt:
                return str(mt)
        except Exception:
            pass
        return str(row["created_at"])  # type: ignore[index]

    def _display_species(
        detection: dict,
        override: SpeciesOverride | None,
    ) -> tuple[str | None, str | None, bool]:
        """Return (display_name, latin_name, manual_override)."""
        if override is not None:
            sci = str(override["canonical_sci"])
            name = override.get("canonical_zh") or override.get("canonical_en") or sci
            return str(name), sci, True

        if detection.get("species"):
            direct_latin = detection.get("species_latin")
            candidates = detection.get("species_candidates") or []
            latin = direct_latin
            if candidates:
                first = candidates[0] or {}
                if first.get("recognition_state") == "unrecognized":
                    return None, None, False
                latin = latin or first.get("canonical_sci")
            return str(detection["species"]), (str(latin) if latin else None), False

        candidates = detection.get("species_candidates") or []
        if candidates:
            first = candidates[0] or {}
            if first.get("recognition_state") == "unrecognized":
                return None, None, False
            sci = first.get("canonical_sci")
            name = first.get("canonical_zh") or first.get("canonical_en") or sci
            return (str(name) if name else None), (str(sci) if sci else None), False

        return None, None, False

    def _candidate_recognition_state(detection: dict) -> str | None:
        candidates = detection.get("species_candidates") or []
        if not candidates:
            return None
        first = candidates[0] or {}
        state = first.get("recognition_state")
        return str(state) if state else None

    def _detection_score(detection: dict) -> float:
        quality = detection.get("quality") or {}
        try:
            return float(quality.get("combined", -1))
        except Exception:
            return -1.0

    def _build_detection_detail(
        index: int,
        detection: dict,
        override: SpeciesOverride | None,
        is_best: bool,
    ) -> BirdDetectionDetail:
        bbox_d = detection.get("bbox") or {}
        bbox = {
            "x1": float(bbox_d.get("x1", 0)),
            "y1": float(bbox_d.get("y1", 0)),
            "x2": float(bbox_d.get("x2", 0)),
            "y2": float(bbox_d.get("y2", 0)),
            "confidence": float(bbox_d.get("confidence", 0)),
        }
        pose: dict | None = None
        pose_d = detection.get("pose")
        if pose_d:

            def _kp(name: str) -> dict | None:
                kp = pose_d.get(name)
                if not kp:
                    return None
                return {
                    "x": float(kp.get("x", 0)),
                    "y": float(kp.get("y", 0)),
                    "confidence": float(kp.get("confidence", 0)),
                }

            # v2 schema:11 关键点(5 头 + 6 身) + 5 visibility + 3 posture。
            # 历史 bug:这里只取 5 头部点 + head/eye_visible,躯干点和 posture 全丢,
            # 前端 PoseDetail schema 用默认值(0,0,0 / false / "unknown")兜底,
            # 导致飞版升档徽标 / 躯干 chips / 躯干关键点叠加全部失效。
            head_keys = ("bill", "crown", "nape", "left_eye", "right_eye")
            torso_keys = ("belly", "breast", "back", "tail", "left_wing", "right_wing")
            head_kpts = {n: _kp(n) for n in head_keys}
            if all(head_kpts.values()):
                # 躯干点对老 v1 cache 可能缺失(数据迁移期),逐项 fallback 到默认占位。
                # 对 v2 数据,pose_d 一定 11 项齐全 → 全部填充正确值。
                placeholder_kp = {"x": 0.0, "y": 0.0, "confidence": 0.0}
                torso_kpts = {n: (_kp(n) or placeholder_kp) for n in torso_keys}
                pose = {
                    **head_kpts,
                    **torso_kpts,
                    "head_visible": bool(pose_d.get("head_visible", False)),
                    "eye_visible": bool(pose_d.get("eye_visible", False)),
                    "body_visible": bool(pose_d.get("body_visible", False)),
                    "tail_visible": bool(pose_d.get("tail_visible", False)),
                    "wings_visible": bool(pose_d.get("wings_visible", False)),
                    "view_angle": str(pose_d.get("view_angle", "unknown")),
                    "facing": str(pose_d.get("facing", "unknown")),
                    "posture": str(pose_d.get("posture", "unknown")),
                    "posture_confidence": float(pose_d.get("posture_confidence", 0.0)),
                    "posture_method": str(pose_d.get("posture_method", "heuristic")),
                }

        species, latin, manual = _display_species(detection, override)
        # Detection-level species_source（多鸟图混合可见性的关键 — 每个 detection
        # 独立判断而非按 best detection 一刀切）。
        # 优先级：manual > model > model_unconfirmed > none。
        # group_consensus / conflict 由 _apply_group_species_consensus 在装配后改写。
        head_confirmed = pose is not None and pose["head_visible"]
        candidate_state = _candidate_recognition_state(detection)
        if manual:
            detection_source: str = "manual"
        elif not species or candidate_state == "unrecognized":
            detection_source = "none"
        elif candidate_state == "uncertain":
            detection_source = "model_unconfirmed"
        else:
            detection_source = "model" if head_confirmed else "model_unconfirmed"
        if detection_source == "none":
            species = None
            latin = None
        return BirdDetectionDetail.model_validate(
            {
                "index": index,
                "bbox": bbox,
                "pose": pose,
                "quality": detection.get("quality"),
                "species": species,
                "species_latin": latin,
                "manual_species": manual,
                "species_source": detection_source,
                "species_candidates": detection.get("species_candidates", []),
                "is_best": is_best,
            }
        )

    def _extract_detection_details(
        result_json: object,
        overrides: list[SpeciesOverrideRecord],
    ) -> tuple[
        list[BirdDetectionDetail] | None,
        BestDetection | None,
        str | None,
        str | None,
    ]:
        """Extract all detected birds and apply manual species overrides.

        Manual overrides 的匹配按 bbox IoU 做（_match_overrides_to_detections） —
        bird_index 不再是稳定 ID（详见该 helper 注释）。
        """
        if not result_json:
            return None, None, None, None
        try:
            data = _json.loads(str(result_json))
            detections_raw = data.get("detections") or []
            if not detections_raw:
                return None, None, None, None
            best_index = max(
                range(len(detections_raw)),
                key=lambda i: _detection_score(detections_raw[i]),
            )
            model_species, model_latin, _manual = _display_species(
                detections_raw[best_index],
                None,
            )
            matched_overrides = _match_overrides_to_detections(detections_raw, overrides)
            detections = [
                _build_detection_detail(
                    index=i,
                    detection=d,
                    override=matched_overrides.get(i),
                    is_best=i == best_index,
                )
                for i, d in enumerate(detections_raw)
            ]
            best = detections[best_index]
            return (
                detections,
                BestDetection.model_validate(best.model_dump()),
                model_species,
                model_latin,
            )
        except Exception:
            return None, None, None, None

    override_photo_ids = [str(row["id"]) for row in context_rows] if limit is not None else None
    species_overrides = await list_species_overrides(db, library_id, override_photo_ids)

    photo_by_id: dict[str, PhotoRow] = {}
    for r in context_rows:
        details, best, model_species, model_species_latin = _extract_detection_details(
            r["result_json"],
            species_overrides.get(str(r["id"]), []),
        )
        effective_species = (
            best.species
            if best and best.species
            else (str(r["species"]) if r["species"] is not None else None)
        )
        effective_species_latin = best.species_latin if best else model_species_latin
        manual_species = bool(best.manual_species) if best else False
        # photo-level species_source = best detection 的 species_source。
        # 每个 detection 自己的 species_source 已在 _build_detection_detail 计算好
        # （多鸟图混合可见性的关键：见 best_detection.species_source vs
        # detections[i].species_source）。
        # group_consensus / conflict 由 _apply_group_species_consensus 后续改写。
        species_source: SpeciesSource = best.species_source if best else "none"
        # 分析任务状态映射:
        # - 已有 active analysis_results → done(无视 task 状态,因为 task 可能在后续 retrigger
        #   时被新建,但只要 analysis_results 仍 active 就是有效结果)
        # - 否则 task DEAD/FAILED → failed(图损坏 / 模型报错,attempts 已用尽)
        # - 否则 → pending(包含 task 不存在 / pending / processing / paused)
        has_result = r["pipeline_version"] is not None
        task_status_raw = str(r["task_status"]) if r["task_status"] is not None else None
        if has_result:
            analysis_status = "done"
        elif task_status_raw in ("dead", "failed"):
            analysis_status = "failed"
        else:
            analysis_status = "pending"
        analysis_error: str | None = None
        analysis_error_code: str | None = None
        if analysis_status == "failed" and r["task_error"] is not None:
            analysis_error = str(r["task_error"])
            analysis_error_code = _classify_analysis_error(analysis_error)
        photo = PhotoRow(
            id=str(r["id"]),
            file_path=str(r["file_path"]),
            file_name=str(r["file_name"]),
            format=(str(r["format"]) if r["format"] is not None else None),
            width=(int(r["width"]) if r["width"] is not None else None),
            height=(int(r["height"]) if r["height"] is not None else None),
            thumb_grid=(str(r["thumb_grid"]) if r["thumb_grid"] is not None else None),
            thumb_preview=(str(r["thumb_preview"]) if r["thumb_preview"] is not None else None),
            companion_path=(str(r["companion_path"]) if r["companion_path"] is not None else None),
            companion_format=(
                str(r["companion_format"]) if r["companion_format"] is not None else None
            ),
            companion_size=(int(r["companion_size"]) if r["companion_size"] is not None else None),
            country=(
                None
                if r["country"] is None or str(r["country"]) == UNRESOLVED_COUNTRY
                else str(r["country"])
            ),
            province=(str(r["province"]) if r["province"] is not None else None),
            city=(str(r["city"]) if r["city"] is not None else None),
            district=(str(r["district"]) if r["district"] is not None else None),
            place=(str(r["place"]) if r["place"] is not None else None),
            created_at=str(r["created_at"]),
            shot_at=_resolve_shot_at(r),
            scene_id=(int(r["scene_id"]) if r["scene_id"] is not None else None),
            pipeline_version=(
                str(r["pipeline_version"]) if r["pipeline_version"] is not None else None
            ),
            grade=(str(r["grade"]) if r["grade"] is not None else None),
            quality_score=(float(r["quality_score"]) if r["quality_score"] is not None else None),
            bird_count=(int(r["bird_count"]) if r["bird_count"] is not None else None),
            species=effective_species,
            species_latin=effective_species_latin,
            manual_species=manual_species,
            species_source=species_source,
            model_species=model_species,
            model_species_latin=model_species_latin,
            decision=(str(r["decision"]) if r["decision"] is not None else None),
            analysis_status=analysis_status,
            analysis_error_code=analysis_error_code,
            analysis_error=analysis_error,
            exif=_parse_exif(r["exif_json"]),
            best_detection=best,
            detections=details,
        )
        photo_by_id[photo.id] = photo

    _apply_group_species_consensus(list(photo_by_id.values()))
    page_ids = [str(row["id"]) for row in rows]
    photos = [photo_by_id[photo_id] for photo_id in page_ids if photo_id in photo_by_id]

    next_offset = None
    if limit is not None and offset + len(rows) < photo_total:
        next_offset = offset + len(rows)

    return LibraryDetail(
        library=summary,
        photos=photos,
        photo_total=photo_total,
        photo_offset=offset,
        photo_limit=limit,
        next_offset=next_offset,
    )


@router.post("/photo/{photo_id}/thumbnail", status_code=200)
async def build_photo_thumbnail(request: Request, photo_id: str) -> dict:
    """POST /library/photo/{photo_id}/thumbnail — rebuild one visible thumbnail."""
    db = await _db(request)
    async with db.conn.execute(
        "SELECT library_id FROM photos WHERE id = ?",
        (photo_id,),
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Photo not found")

    library_id = str(row["library_id"])
    settings = request.app.state.settings if hasattr(request.app.state, "settings") else None
    if settings is None:
        from engine.core.config import settings as app_settings

        settings = app_settings
    cache_root = thumbnail_cache_root(settings.data_dir)

    result = await ensure_thumbnails_for_photo(db, photo_id, cache_root, force=True)
    async with db.conn.execute(
        "SELECT thumb_grid, thumb_preview FROM photos WHERE id = ?",
        (photo_id,),
    ) as cur:
        updated = await cur.fetchone()

    built = result is not None
    payload = {
        "photo_id": photo_id,
        "library_id": library_id,
        "built": built,
        "thumb_grid": str(updated["thumb_grid"]) if updated and updated["thumb_grid"] else None,
        "thumb_preview": (
            str(updated["thumb_preview"]) if updated and updated["thumb_preview"] else None
        ),
    }
    publish_library_event(
        library_id,
        "thumbnail_ready" if built else "thumbnail_failed",
        payload,
    )
    return payload


@router.delete("/{library_id}", status_code=204)
async def delete_library(request: Request, library_id: str) -> None:
    """DELETE /library/{id} — 移除应用内的全部记录,**不动源文件夹**。

    DB 侧靠外键 CASCADE 清 photos / analysis_results / task_queue / decisions;
    缩略图是磁盘文件不受 CASCADE 管,必须在删行之前把 photo_id 取出来,否则行
    一没就再也定位不到那些文件 —— 那是永久泄漏。
    """
    db = await _db(request)
    async with db.conn.execute(
        "SELECT id FROM libraries WHERE id = ?",
        (library_id,),
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Library not found")

    async with db.conn.execute(
        "SELECT id FROM photos WHERE library_id = ?",
        (library_id,),
    ) as cur:
        photo_ids = [str(photo["id"]) for photo in await cur.fetchall()]

    async with db.conn.execute(
        "DELETE FROM libraries WHERE id = ?",
        (library_id,),
    ) as cur:
        deleted = cur.rowcount or 0
    await db.conn.commit()
    if deleted == 0:
        # 上面已检查过 row 存在,DELETE 的 rowcount 为 0 表示约束阻止删除(外键
        # 缺 CASCADE / 触发器拦下等)。返回 500 而非静默成功 — 用户可能看到删除
        # 按钮按了无反应,需要排查。
        raise HTTPException(status_code=500, detail="Library deletion failed (constraint)")

    settings = getattr(request.app.state, "settings", None)
    if settings is None:
        from engine.core.config import settings as app_settings

        settings = app_settings
    removed_thumbnails = await asyncio.to_thread(
        delete_thumbnails_for_photos,
        photo_ids,
        thumbnail_cache_root(settings.data_dir),
    )

    archive_cache.invalidate()
    await logger.ainfo(
        "Library deleted",
        library_id=library_id,
        photos=len(photo_ids),
        thumbnails_removed=removed_thumbnails,
    )


@router.post("/{library_id}/thumbnails", status_code=200)
async def build_thumbnails(request: Request, library_id: str) -> dict:
    """POST /library/{id}/thumbnails — generate missing thumbnails."""
    db = await _db(request)
    settings = request.app.state.settings if hasattr(request.app.state, "settings") else None
    if settings is None:
        from engine.core.config import settings as app_settings

        settings = app_settings
    cache_root = thumbnail_cache_root(settings.data_dir)

    summary = await _fetch_library_summary(db, library_id)
    if summary is None:
        raise HTTPException(status_code=404, detail="Library not found")

    report = await generate_library_thumbnails(db, library_id, cache_root)
    return report


@router.post("/{library_id}/scene-groups", status_code=200)
async def regroup_scenes(request: Request, library_id: str) -> dict:
    """POST /library/{id}/scene-groups — 重新计算 scene_id（AKAZE 特征 + 颜色直方图）。

    用 preview 缩略图（1920px）做相似度，避免重新解码原 RAW。
    """
    db = await _db(request)
    summary = await _fetch_library_summary(db, library_id)
    if summary is None:
        raise HTTPException(status_code=404, detail="Library not found")

    cache_root = thumbnail_cache_root(app_settings.data_dir)
    from engine.services.scene_grouper import regroup_library

    return await regroup_library(db, library_id, cache_root)
