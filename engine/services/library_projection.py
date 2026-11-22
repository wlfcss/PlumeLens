# pyright: basic
"""Shared photo projection: manual identity, detection sources and full scene consensus.

Library views, selection facets and export snapshots consume this one projection.
This service performs SQL reads only; filesystem checks remain in route/lifecycle code.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Iterable, Iterator, Mapping, Sequence
from datetime import datetime
from itertools import islice
from sqlite3 import Row
from typing import Any, Literal, cast, overload

import aiosqlite

from engine.api.schemas.library import (
    BestDetection,
    BirdDetectionDetail,
    BirdDetectionSummary,
    DetectionSummary,
    PhotoRow,
    PhotoSummary,
    SpeciesSource,
)
from engine.core.database import Database
from engine.services.decisions import (
    SpeciesOverride,
    SpeciesOverrideRecord,
    list_species_overrides,
)
from engine.services.geo_constants import UNRESOLVED_COUNTRY

ProjectedPhoto = PhotoRow | PhotoSummary
_SUMMARY_EXIF_KEYS = (
    "ExposureTime",
    "FNumber",
    "FocalLength",
    "ISOSpeedRatings",
    "PhotographicSensitivity",
    "ISO",
)
_GPS_KEYS = ("GPSLatitudeRef", "GPSLatitude", "GPSLongitudeRef", "GPSLongitude")
_SUMMARY_CANDIDATE_KEYS = (
    "canonical_sci",
    "canonical_zh",
    "canonical_en",
    "confidence",
    "recognition_state",
)


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


def _candidate_english(candidates: Sequence[Mapping[str, object]], latin: str | None) -> str | None:
    if latin:
        for candidate in candidates:
            if candidate.get("canonical_sci") == latin and candidate.get("canonical_en"):
                return str(candidate["canonical_en"])
    return None


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


def _best_candidate(photo: ProjectedPhoto) -> tuple[str | None, str | None, float]:
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
    photo: ProjectedPhoto,
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


def _consensus_photo_weight(photo: ProjectedPhoto) -> float:
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


def _group_span_seconds(photos: Sequence[ProjectedPhoto]) -> float | None:
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


def _apply_effective_species(
    photo: ProjectedPhoto,
    name: str,
    sci: str,
    source: SpeciesSource,
    english_name: str | None = None,
) -> None:
    photo.species = name
    photo.species_latin = sci
    photo.species_source = source
    if photo.best_detection is not None:
        photo.best_detection.species = name
        photo.best_detection.species_latin = sci
        photo.best_detection.species_english = english_name
        photo.best_detection.species_source = source
    if photo.detections:
        for detection in photo.detections:
            if detection.is_best:
                detection.species = name
                detection.species_latin = sci
                detection.species_english = english_name
                detection.species_source = source
                break


def _apply_group_species_consensus(photos: Sequence[ProjectedPhoto]) -> None:
    """Apply a read-time group species consensus to single-bird scene groups.

    This deliberately does not write back to analysis_results. The raw model
    result remains visible through model_species/model_species_latin, while the
    effective species used by the UI can be stabilized for obvious same-subject
    bursts.
    """
    groups: dict[int, list[ProjectedPhoto]] = {}
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
                meta.setdefault(sci, (photo.species, photo.best_detection.species_english))
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

        winner_name, winner_en = meta.get(winner_sci, (winner_sci, None))
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
                    _apply_effective_species(
                        photo, winner_name, winner_sci, "group_consensus", winner_en
                    )
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
            _apply_effective_species(photo, winner_name, winner_sci, "group_consensus", winner_en)


_PROJECTION_REVISION_BATCH_SIZE = 256


_PROJECTION_REVISION_FIELDS = (
    "id",
    "file_path",
    "file_name",
    "input_revision",
    "file_hash",
    "pipeline_version",
    "companion_path",
    "companion_format",
    "companion_size",
    "format",
    "shot_at",
    "scene_id",
    "analysis_status",
    "grade",
    "decision",
    "quality_score",
    "bird_count",
    "species",
    "species_latin",
    "species_source",
    "_selection_revision",
)


def projection_revision_row(photo: ProjectedPhoto) -> tuple[object, ...]:
    return tuple(getattr(photo, field) for field in _PROJECTION_REVISION_FIELDS)


def projection_revision_from_rows(library_id: str, rows: Iterable[tuple[object, ...]]) -> str:
    """Hash the same ordered JSON payload regardless of how scenes were processed."""
    encode = json.JSONEncoder(ensure_ascii=False, separators=(",", ":")).encode
    digest = hashlib.sha256()
    digest.update(b"[" + encode(library_id).encode("utf-8") + b",[")
    iterator = iter(rows)
    separator = b""
    while batch := list(islice(iterator, _PROJECTION_REVISION_BATCH_SIZE)):
        digest.update(separator)
        digest.update(encode(batch)[1:-1].encode("utf-8"))
        separator = b","
    digest.update(b"]]")
    return digest.hexdigest()


def projection_revision(library_id: str, photos: Sequence[ProjectedPhoto]) -> str:
    """Hash the same source and effective selection state in both views."""
    return projection_revision_from_rows(library_id, map(projection_revision_row, photos))


def _stamp_photo_revisions(photo: ProjectedPhoto, row: Row) -> None:
    """Keep selection pins independent of display-only review changes."""
    digest = hashlib.blake2b(digest_size=16)

    def _add_raw(raw: object) -> None:
        value = str(raw).encode("utf-8") if raw is not None else b""
        digest.update(len(value).to_bytes(8, "big"))
        digest.update(value)

    def _add_values(values: object) -> None:
        digest.update(json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))

    _add_raw(row["result_json"])
    _add_values(
        [
            (
                bird.index,
                bird.species,
                bird.species_latin,
                bird.species_english
                or _candidate_english(bird.species_candidates, bird.species_latin),
                bird.species_source,
            )
            for bird in photo.detections or ()
        ]
    )
    photo._selection_revision = digest.hexdigest()

    _add_raw(row["exif_json"])
    _add_values(
        (
            photo.id,
            photo.file_path,
            photo.file_name,
            photo.file_hash,
            photo.input_revision,
            photo.format,
            photo.companion_path,
            photo.companion_format,
            photo.companion_size,
            photo.width,
            photo.height,
            photo.thumb_grid,
            photo.thumb_preview,
            photo.country,
            photo.province,
            photo.city,
            photo.district,
            photo.place,
            photo.created_at,
            photo.shot_at,
            photo.pipeline_version,
            photo.grade,
            photo.quality_score,
            photo.bird_count,
            photo.analysis_status,
            photo.analysis_error,
            photo.decision,
            photo.scene_id,
            photo.species,
            photo.species_latin,
            photo.species_source,
            photo.group_species,
            photo.group_species_latin,
            photo.group_species_confidence,
            photo.group_species_support,
            photo.group_species_evidence,
            photo.group_species_total,
            photo.species_conflict,
        )
    )
    photo.review_revision = digest.hexdigest()


class LibraryProjectionNotFound(RuntimeError):
    """The requested library or photo does not exist in the snapshot."""


_SELECT_PHOTO_PROJECTION = (
    "SELECT p.id, p.library_id, p.file_path, p.file_name, p.format, p.width, p.height, "
    "p.thumb_grid, p.thumb_preview, p.created_at, p.file_mtime, p.exif_json, "
    "p.input_revision, p.file_hash, "
    "p.scene_id, p.companion_path, p.companion_format, p.companion_size, "
    "p.country, p.province, p.city, p.district, p.place, "
    "ar.pipeline_version, ar.grade, ar.quality_score, ar.bird_count, ar.species, ar.result_json, "
    "pd.decision, tq.status AS task_status, tq.error_message AS task_error "
    "FROM photos p "
    "LEFT JOIN analysis_results ar ON ar.photo_id = p.id AND ar.is_active = 1 "
    "AND ar.input_revision = p.input_revision "
    "LEFT JOIN photo_decisions pd ON pd.photo_id = p.id "
    # A photo can have historical task rows. Only the latest gives its status.
    "LEFT JOIN task_queue tq ON tq.rowid = ("
    "    SELECT MAX(rowid) FROM task_queue WHERE photo_id = p.id"
    ") "
)
_PHOTO_PROJECTION_ORDER = "ORDER BY p.file_mtime ASC, p.id ASC"


async def _expand_scene_rows(
    conn: aiosqlite.Connection, library_id: str, rows: list[Row]
) -> list[Row]:
    """Read each touched scene in the same order as the full library."""
    scene_ids = sorted({int(row["scene_id"]) for row in rows if row["scene_id"] is not None})
    if not scene_ids:
        return rows
    context_rows = [row for row in rows if row["scene_id"] is None]
    # Keep the parameter count below older SQLite builds' variable limit.
    for start in range(0, len(scene_ids), 500):
        scenes = scene_ids[start : start + 500]
        placeholders = ",".join("?" for _ in scenes)
        async with conn.execute(
            _SELECT_PHOTO_PROJECTION
            + f"WHERE p.library_id = ? AND p.scene_id IN ({placeholders}) "
            + _PHOTO_PROJECTION_ORDER,
            (library_id, *scenes),
        ) as cursor:
            context_rows.extend(await cursor.fetchall())
    return context_rows


@overload
async def load_library_photos(
    db: Database,
    library_id: str,
    *,
    limit: int | None = None,
    offset: int = 0,
    summary: Literal[False] = False,
) -> list[PhotoRow]: ...


@overload
async def load_library_photos(
    db: Database,
    library_id: str,
    *,
    limit: int | None = None,
    offset: int = 0,
    summary: Literal[True],
) -> list[PhotoSummary]: ...


@overload
async def load_library_photos(
    db: Database,
    library_id: str,
    *,
    limit: int | None = None,
    offset: int = 0,
    summary: bool,
) -> list[PhotoRow] | list[PhotoSummary]: ...


async def load_library_photos(
    db: Database,
    library_id: str,
    *,
    limit: int | None = None,
    offset: int = 0,
    summary: bool = False,
) -> list[PhotoRow] | list[PhotoSummary]:
    """Copy SQL inputs from one snapshot, then project off the event loop."""
    rows, context_rows, species_overrides = await read_library_projection_inputs(
        db, library_id, limit=limit, offset=offset
    )
    projected = await asyncio.to_thread(
        project_library_photos, rows, context_rows, species_overrides, summary
    )
    return cast("list[PhotoRow] | list[PhotoSummary]", projected)


async def read_library_projection_inputs(
    db: Database, library_id: str, *, limit: int | None = None, offset: int = 0
) -> tuple[list[Row], list[Row], dict[str, list[SpeciesOverrideRecord]]]:
    async with db.read_snapshot() as conn:
        async with conn.execute("SELECT 1 FROM libraries WHERE id = ?", (library_id,)) as cur:
            if await cur.fetchone() is None:
                raise LibraryProjectionNotFound(library_id)
        sql = _SELECT_PHOTO_PROJECTION + f"WHERE p.library_id = ? {_PHOTO_PROJECTION_ORDER}"
        params: tuple[object, ...] = (library_id,)
        if limit is not None:
            sql += " LIMIT ? OFFSET ?"
            params = (library_id, limit, offset)
        async with conn.execute(sql, params) as cur:
            rows = list(await cur.fetchall())

        context_rows = (
            await _expand_scene_rows(conn, library_id, rows) if limit is not None else rows
        )
        override_photo_ids = [str(row["id"]) for row in context_rows] if limit is not None else None
        species_overrides = await list_species_overrides(
            db, library_id, override_photo_ids, connection=conn
        )
    return rows, context_rows, species_overrides


def project_summary_scenes(
    rows: list[Row], overrides: dict[str, list[SpeciesOverrideRecord]], batch_size: int
) -> Iterator[tuple[list[int], list[PhotoSummary]]]:
    """Project complete scenes in bounded groups. Indices restore SQL order."""
    by_scene: dict[int, list[int]] = {}
    for index, row in enumerate(rows):
        if (scene := row["scene_id"]) is not None:
            by_scene.setdefault(int(scene), []).append(index)

    batch: list[int] = []
    for index, row in enumerate(rows):
        scene = row["scene_id"]
        if scene is None:
            indices = [index]
        else:
            indices = by_scene.pop(int(scene), None)
            if indices is None:
                continue
        if batch and len(batch) + len(indices) > batch_size:
            batch_rows = [rows[position] for position in batch]
            yield (
                batch,
                cast(
                    "list[PhotoSummary]",
                    project_library_photos(batch_rows, batch_rows, overrides, True),
                ),
            )
            batch = []
        batch.extend(indices)
    if batch:
        batch_rows = [rows[position] for position in batch]
        yield (
            batch,
            cast(
                "list[PhotoSummary]",
                project_library_photos(batch_rows, batch_rows, overrides, True),
            ),
        )


async def load_photo_review(db: Database, photo_id: str) -> tuple[str, PhotoRow]:
    """Read full review data and only the selected photo's scene evidence."""
    async with db.read_snapshot() as conn:
        async with conn.execute(_SELECT_PHOTO_PROJECTION + "WHERE p.id = ?", (photo_id,)) as cur:
            row = await cur.fetchone()
        if row is None:
            raise LibraryProjectionNotFound(photo_id)
        library_id = str(row["library_id"])
        context_rows = await _expand_scene_rows(conn, library_id, [row])
        overrides = await list_species_overrides(
            db, library_id, [str(r["id"]) for r in context_rows], connection=conn
        )

    photos = await asyncio.to_thread(
        project_library_photos, [row], context_rows, overrides, True, full_photo_id=photo_id
    )
    return library_id, cast(PhotoRow, photos[0])


def project_library_photos(
    rows: list[Row],
    context_rows: list[Row],
    species_overrides: dict[str, list[SpeciesOverrideRecord]],
    summary: bool = False,
    *,
    full_photo_id: str | None = None,
) -> list[ProjectedPhoto]:
    """Pure projection; full scene evidence is fixed before any filtering."""

    def _parse_exif(raw: object) -> dict[str, Any] | None:
        if not raw:
            return None
        try:
            data = json.loads(str(raw))
            return data if isinstance(data, dict) else None
        except (ValueError, TypeError):
            return None

    def _compact_exif(exif: dict[str, Any] | None) -> dict[str, Any] | None:
        if exif is None:
            return None
        compact = {key: exif[key] for key in (*_SUMMARY_EXIF_KEYS, *_GPS_KEYS) if key in exif}
        gps = exif.get("GPSInfo")
        if isinstance(gps, dict):
            compact["GPSInfo"] = {
                key: gps[key] for key in (*_GPS_KEYS, "1", "2", "3", "4") if key in gps
            }
        return compact or None

    def _resolve_shot_at(row: Row, exif: dict[str, Any] | None) -> str:
        """Prefer captured time over file modification and import time."""
        dto = exif.get("DateTimeOriginal") if exif else None
        if isinstance(dto, str) and dto:
            return dto.replace(":", "-", 2).replace(" ", "T")
        return str(row["file_mtime"] or row["created_at"])

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
        compact: bool,
    ) -> BirdDetectionDetail | BirdDetectionSummary:
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
            head_keys = ("bill", "crown", "nape", "left_eye", "right_eye")
            torso_keys = ("belly", "breast", "back", "tail", "left_wing", "right_wing")
            head_points = [pose_d.get(name) for name in head_keys]
            has_head = all(head_points)

            def _point_values(kp: dict) -> tuple[float, float, float]:
                return float(kp.get("x", 0)), float(kp.get("y", 0)), float(kp.get("confidence", 0))

            # Validate points in both views so a malformed legacy result cannot
            # acquire a species/flight identity only in summary.
            if compact:
                points = (
                    (*head_points, *(pose_d.get(name) for name in torso_keys))
                    if has_head
                    else head_points
                )
                for kp in points:
                    if kp:
                        _point_values(kp)
            else:

                def _keypoint(kp: dict | None) -> dict[str, float] | None:
                    if not kp:
                        return None
                    x, y, confidence = _point_values(kp)
                    return {"x": x, "y": y, "confidence": confidence}

                head_kpts = {
                    name: _keypoint(kp) for name, kp in zip(head_keys, head_points, strict=True)
                }

            if has_head:
                pose = {
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
                if not compact:
                    pose.update(head_kpts)
                    # Legacy v1 results did not carry torso points.
                    placeholder = {"x": 0.0, "y": 0.0, "confidence": 0.0}
                    pose.update(
                        {name: _keypoint(pose_d.get(name)) or placeholder for name in torso_keys}
                    )

        species, latin, manual = _display_species(detection, override)
        raw_candidates = detection.get("species_candidates", [])
        if not isinstance(raw_candidates, list) or any(
            not isinstance(candidate, dict) for candidate in raw_candidates
        ):
            raise ValueError("Invalid species candidates")
        english = override.get("canonical_en") if override is not None else None
        if not english:
            english = _candidate_english(raw_candidates, latin)
        # Scene consensus uses the first five model candidates from the best bird.
        candidates = raw_candidates
        if compact:
            candidates = [
                {key: candidate[key] for key in _SUMMARY_CANDIDATE_KEYS if key in candidate}
                for candidate in (raw_candidates[:5] if is_best else [])
            ]
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
        fields = {
            "index": index,
            "bbox": bbox,
            "pose": pose,
            "quality": detection.get("quality"),
            "species": species,
            "species_latin": latin,
            "species_english": english,
            "manual_species": manual,
            "species_source": detection_source,
            "species_candidates": candidates,
            "is_best": is_best,
        }
        if compact:
            fields["candidate_confidence"] = (
                _species_candidate_confidence(raw_candidates[0]) if raw_candidates else None
            )
            fields["candidate_recognition_state"] = candidate_state
            return BirdDetectionSummary.model_validate(fields)
        return BirdDetectionDetail.model_validate(fields)

    def _extract_detection_details(
        result_json: object,
        overrides: list[SpeciesOverrideRecord],
        compact: bool,
    ) -> tuple[
        list[BirdDetectionDetail | BirdDetectionSummary] | None,
        BestDetection | DetectionSummary | None,
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
            data = json.loads(str(result_json))
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
                    compact=compact,
                )
                for i, d in enumerate(detections_raw)
            ]
            best = detections[best_index]
            best_model = DetectionSummary if compact else BestDetection
            return (
                detections,
                best_model.model_construct(**best.__dict__),
                model_species,
                model_latin,
            )
        except Exception:
            return None, None, None, None

    photo_by_id: dict[str, ProjectedPhoto] = {}
    for r in context_rows:
        photo_id = str(r["id"])
        compact = summary and photo_id != full_photo_id
        details, best, model_species, model_species_latin = _extract_detection_details(
            r["result_json"],
            species_overrides.get(photo_id, []),
            compact,
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
        exif = _parse_exif(r["exif_json"])
        photo_model = PhotoSummary if compact else PhotoRow
        photo = photo_model(
            id=photo_id,
            file_path=str(r["file_path"]),
            file_name=str(r["file_name"]),
            input_revision=int(r["input_revision"]),
            file_hash=str(r["file_hash"]) if r["file_hash"] else None,
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
            shot_at=_resolve_shot_at(r, exif),
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
            exif=_compact_exif(exif) if compact else exif,
            best_detection=best,  # type: ignore[arg-type]
            detections=details,  # type: ignore[arg-type]
        )
        photo_by_id[photo.id] = photo

    _apply_group_species_consensus(list(photo_by_id.values()))
    photos: list[ProjectedPhoto] = []
    for row in rows:
        photo = photo_by_id[str(row["id"])]
        best = photo.best_detection
        if (
            photo.species_source == "group_consensus"
            and best is not None
            and not best.species_english
        ):
            # An older consensus vote may lack the English label although
            # a lower candidate from this photo supplies the same label.
            candidates = best.species_candidates
            if isinstance(photo, PhotoSummary):
                raw_best = json.loads(str(row["result_json"]))["detections"][best.index]
                candidates = raw_best.get("species_candidates", [])
            english = _candidate_english(candidates, best.species_latin)
            if english:
                best.species_english = english
                for detection in photo.detections or []:
                    if detection.is_best:
                        detection.species_english = english
                        break
        if isinstance(photo, PhotoSummary) and photo.best_detection is not None:
            photo.best_detection.species_candidates = []
            for detection in photo.detections or []:
                detection.species_candidates = []
        _stamp_photo_revisions(photo, row)
        photos.append(photo)
    return photos
