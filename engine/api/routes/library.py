# pyright: basic
"""Library management endpoints (import / list / detail / delete / scan)."""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path

import structlog
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from fastapi.responses import StreamingResponse

from engine.api.schemas.library import (
    BestDetection,
    BirdDetectionDetail,
    ImportLibraryRequest,
    LibraryDetail,
    LibraryStatus,
    LibrarySummary,
    PhotoRow,
)
from engine.core.config import settings as app_settings
from engine.core.database import Database
from engine.services.decisions import SpeciesOverride, list_species_overrides
from engine.services.event_bus import (
    publish_library_event,
    subscribe_library_events,
    unsubscribe_library_events,
)
from engine.services.scanner import backfill_hashes, scan_library
from engine.services.thumbnail import (
    ensure_thumbnails_for_photo,
    generate_library_thumbnails,
    thumbnail_cache_root,
)

logger = structlog.stdlib.get_logger()

router = APIRouter(prefix="/library", tags=["library"])


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


async def _backfill_then_thumbnails(db: Database, library_id: str) -> None:
    """阶段 2/3/4：补 SHA-256 + 生成缩略图 + 跑场景分组。"""
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


async def _db(request: Request) -> Database:
    db = getattr(request.app.state, "db", None)
    if db is None:
        raise HTTPException(status_code=503, detail="Database not initialized")
    return db


async def _fetch_library_summary(db: Database, library_id: str) -> LibrarySummary | None:
    async with db.conn.execute(
        "SELECT * FROM libraries WHERE id = ?",
        (library_id,),
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        return None
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
        status=LibraryStatus(str(row["status"])),
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


def _best_candidate(photo: PhotoRow) -> tuple[str | None, str | None, float]:
    candidates = photo.best_detection.species_candidates if photo.best_detection else []
    if not candidates:
        return None, None, 0.0
    first = candidates[0]
    sci = _candidate_sci(first)
    if not sci:
        return None, None, 0.0
    name, _ = _candidate_display(first, sci)
    return sci, name, _species_candidate_confidence(first)


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


def _apply_effective_species(photo: PhotoRow, name: str, sci: str, source: str) -> None:
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
                0.45 * winner_share
                + 0.35 * support_ratio
                + 0.20 * min(1.0, margin * 2.0),
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
            original_sci, _original_name, original_conf = _best_candidate(photo)
            if original_sci == winner_sci:
                # 模型 top-1 与共识一致 → 通常不需要改 species_source。但若该照片
                # 当前是 'model_unconfirmed'（head 不可见但模型给了识别），共识就
                # 是"代审"信号 → 升级为 'group_consensus' 让它能进羽迹（规则 #3）。
                if photo.species_source == "model_unconfirmed":
                    _apply_effective_species(photo, winner_name, winner_sci, "group_consensus")
                continue
            if original_sci and original_conf > GROUP_SPECIES_MAX_CONFLICT_TOP1_CONF:
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

    queue = subscribe_library_events(library_id)

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


@router.get("/{library_id}", response_model=LibraryDetail)
async def library_detail(request: Request, library_id: str) -> LibraryDetail:
    """GET /library/{id} — summary + photos."""
    db = await _db(request)
    summary = await _fetch_library_summary(db, library_id)
    if summary is None:
        raise HTTPException(status_code=404, detail="Library not found")

    async with db.conn.execute(
        "SELECT p.id, p.file_path, p.file_name, p.format, p.width, p.height, "
        "p.thumb_grid, p.thumb_preview, p.created_at, p.file_mtime, p.exif_json, "
        "p.scene_id, "
        "ar.pipeline_version, ar.grade, ar.quality_score, ar.bird_count, ar.species, "
        "ar.result_json, "
        "pd.decision "
        "FROM photos p "
        "LEFT JOIN analysis_results ar ON ar.photo_id = p.id AND ar.is_active = 1 "
        "LEFT JOIN photo_decisions pd ON pd.photo_id = p.id "
        "WHERE p.library_id = ? "
        "ORDER BY p.file_mtime ASC",
        (library_id,),
    ) as cur:
        rows = await cur.fetchall()

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
                latin = latin or first.get("canonical_sci")
            return str(detection["species"]), (str(latin) if latin else None), False

        candidates = detection.get("species_candidates") or []
        if candidates:
            first = candidates[0] or {}
            sci = first.get("canonical_sci")
            name = first.get("canonical_zh") or first.get("canonical_en") or sci
            return (str(name) if name else None), (str(sci) if sci else None), False

        return None, None, False

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

            kpts = {n: _kp(n) for n in ("bill", "crown", "nape", "left_eye", "right_eye")}
            if all(kpts.values()):
                pose = {
                    **kpts,
                    "head_visible": bool(pose_d.get("head_visible", False)),
                    "eye_visible": bool(pose_d.get("eye_visible", False)),
                }

        species, latin, manual = _display_species(detection, override)
        # Detection-level species_source（多鸟图混合可见性的关键 — 每个 detection
        # 独立判断而非按 best detection 一刀切）。优先级：manual > model > model_unconfirmed > none。
        # group_consensus / conflict 由 _apply_group_species_consensus 在 photo 装配后改写。
        head_confirmed = pose is not None and pose["head_visible"]
        if manual:
            detection_source: str = "manual"
        elif species:
            detection_source = "model" if head_confirmed else "model_unconfirmed"
        else:
            detection_source = "none"
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
        overrides: Mapping[int, SpeciesOverride],
    ) -> tuple[list[BirdDetectionDetail] | None, BestDetection | None]:
        """Extract all detected birds and apply manual species overrides."""
        if not result_json:
            return None, None
        try:
            data = _json.loads(str(result_json))
            detections_raw = data.get("detections") or []
            if not detections_raw:
                return None, None
            best_index = max(
                range(len(detections_raw)),
                key=lambda i: _detection_score(detections_raw[i]),
            )
            detections = [
                _build_detection_detail(
                    index=i,
                    detection=d,
                    override=overrides.get(i),
                    is_best=i == best_index,
                )
                for i, d in enumerate(detections_raw)
            ]
            best = detections[best_index]
            return detections, BestDetection.model_validate(best.model_dump())
        except Exception:
            return None, None

    def _extract_model_species(result_json: object) -> tuple[str | None, str | None]:
        """Extract raw model species for the best detection, ignoring manual/group layers."""
        if not result_json:
            return None, None
        try:
            data = _json.loads(str(result_json))
            detections_raw = data.get("detections") or []
            if not detections_raw:
                return None, None
            best_index = max(
                range(len(detections_raw)),
                key=lambda i: _detection_score(detections_raw[i]),
            )
            species, latin, _manual = _display_species(detections_raw[best_index], None)
            return species, latin
        except Exception:
            return None, None

    species_overrides = await list_species_overrides(db, library_id)

    photos: list[PhotoRow] = []
    for r in rows:
        details, best = _extract_detection_details(
            r["result_json"],
            species_overrides.get(str(r["id"]), {}),
        )
        model_species, model_species_latin = _extract_model_species(r["result_json"])
        effective_species = (
            best.species
            if best and best.species
            else (str(r["species"]) if r["species"] is not None else None)
        )
        effective_species_latin = best.species_latin if best else model_species_latin
        manual_species = bool(best.manual_species) if best else False
        # photo-level species_source = best detection 的 species_source。
        # 每个 detection 自己的 species_source 已在 _build_detection_detail 计算好
        # （多鸟图混合可见性的关键：见 best_detection.species_source vs detections[i].species_source）。
        # group_consensus / conflict 由 _apply_group_species_consensus 后续改写。
        species_source: str = best.species_source if best else "none"
        photos.append(
            PhotoRow(
                id=str(r["id"]),
                file_path=str(r["file_path"]),
                file_name=str(r["file_name"]),
                format=(str(r["format"]) if r["format"] is not None else None),
                width=(int(r["width"]) if r["width"] is not None else None),
                height=(int(r["height"]) if r["height"] is not None else None),
                thumb_grid=(str(r["thumb_grid"]) if r["thumb_grid"] is not None else None),
                thumb_preview=(
                    str(r["thumb_preview"]) if r["thumb_preview"] is not None else None
                ),
                created_at=str(r["created_at"]),
                shot_at=_resolve_shot_at(r),
                scene_id=(int(r["scene_id"]) if r["scene_id"] is not None else None),
                pipeline_version=(
                    str(r["pipeline_version"]) if r["pipeline_version"] is not None else None
                ),
                grade=(str(r["grade"]) if r["grade"] is not None else None),
                quality_score=(
                    float(r["quality_score"]) if r["quality_score"] is not None else None
                ),
                bird_count=(int(r["bird_count"]) if r["bird_count"] is not None else None),
                species=effective_species,
                species_latin=effective_species_latin,
                manual_species=manual_species,
                species_source=species_source,
                model_species=model_species,
                model_species_latin=model_species_latin,
                decision=(str(r["decision"]) if r["decision"] is not None else None),
                exif=_parse_exif(r["exif_json"]),
                best_detection=best,
                detections=details,
            )
        )

    _apply_group_species_consensus(photos)

    return LibraryDetail(library=summary, photos=photos)


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
    """DELETE /library/{id} — cascades to photos / analysis_results / task_queue."""
    db = await _db(request)
    async with db.conn.execute(
        "SELECT id FROM libraries WHERE id = ?",
        (library_id,),
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Library not found")

    await db.conn.execute("DELETE FROM libraries WHERE id = ?", (library_id,))
    await db.conn.commit()
    await logger.ainfo("Library deleted", library_id=library_id)


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
