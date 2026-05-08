# pyright: basic
"""羽迹页面聚合 API — 三级地图按省/市/拍摄点聚合鸟种数 + 照片数。

数据流:
- photos.country/province/city/district/place 由 location_backfill 持久化
- 鸟种来自 analysis_results 的 best detection 物种(JSON 字段) ∪ photo_species_overrides
- 请求路径不做 reverse_geocoding;先用 SQL 过滤有效照片,再按羽迹有效物种口径聚合

API:
- GET /archive/geo/provinces → 一级中国地图:每个省鸟种数 + 照片数
- GET /archive/geo/cities?province=江苏省 → 二级省地图:每个市鸟种数 + 照片数
- GET /archive/geo/spots?province=...&city=... → 三级市内 marker:每个拍摄点
  (lat/lon, place 名, 鸟种, 照片缩略图)
"""

from __future__ import annotations

import json
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass
from time import monotonic
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from engine.api.routes.library import _apply_group_species_consensus, _match_overrides_to_detections
from engine.api.schemas.library import BestDetection, BirdDetectionDetail, PhotoRow
from engine.core.database import Database
from engine.services.decisions import SpeciesOverride, SpeciesOverrideRecord
from engine.services.geo_constants import UNRESOLVED_COUNTRY
from engine.services.gps import parse_gps_from_exif

router = APIRouter(prefix="/archive", tags=["archive"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
async def _db(request: Request) -> Database:
    db = getattr(request.app.state, "db", None)
    if db is None:
        raise HTTPException(status_code=503, detail="Database not initialized")
    return db


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------
class GeoSpecies(BaseModel):
    name: str
    latin_name: str | None = None
    english_name: str | None = None
    photo_count: int = 1


class GeoProvinceRow(BaseModel):
    province: str
    photo_count: int  # 该省照片总数
    species_count: int  # 该省去重后的鸟种数(拉丁名 distinct)


class GeoCityRow(BaseModel):
    city: str
    photo_count: int
    species_count: int


class GeoSpotPhoto(BaseModel):
    photo_id: str
    file_name: str
    species: list[GeoSpecies] = Field(default_factory=list)
    # Back-compat fields for old renderers. New UI reads `species`.
    species_latin: str | None = None
    species_zh: str | None = None
    thumb_grid: str | None
    grade: str | None
    quality_score: float | None


class GeoSpot(BaseModel):
    """单个拍摄地点。

    优先按 reverse geocoding 持久化的 place 名聚合,表示一个物理地点
    (如"洋湖国家湿地公园")有哪些鸟;缺少 place 时才退回 GPS round 到
    4 位小数(≈ 11m)聚合。
    """

    lat: float
    lon: float
    place: str | None
    photo_count: int
    species_count: int
    species: list[GeoSpecies] = Field(default_factory=list)
    photos: list[GeoSpotPhoto]  # 该点照片样本(默认最多 500 张,避免响应过大)


class GeoSummary(BaseModel):
    """整体进度:有多少照片有 GPS、多少已 backfill 完成。前端用于显示
    "解析地理位置 120/300..." 进度条。"""

    total_with_gps: int  # 有可用经纬度的照片总数
    resolved: int  # 有可用经纬度且已解析到真实地名的照片数
    pending: int  # 有可用经纬度但未填充地名
    unresolved_count: int = 0  # 有可用经纬度但 provider 链路无法解析
    photos_without_gps: int  # 没有可用经纬度的


# ---------------------------------------------------------------------------
# Effective archive species projection
# ---------------------------------------------------------------------------
ARCHIVE_GRADES = {"select", "usable", "record"}
ARCHIVE_SPECIES_SOURCES = {"manual", "model", "group_consensus"}
_ARCHIVE_GEO_CACHE_TTL_SECONDS = 10.0
_archive_geo_cache: dict[str, tuple[float, Any]] = {}


@dataclass
class _GeoPhoto:
    library_id: str
    photo: PhotoRow
    exif_json: str | None
    province: str | None
    city: str | None
    place: str | None
    thumb_grid: str | None


def _parse_json(raw: object) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        data = json.loads(str(raw))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _resolve_shot_at(row: Any) -> str:
    exif = _parse_json(row["exif_json"])
    dto = exif.get("DateTimeOriginal")
    if isinstance(dto, str) and dto:
        return dto.replace(":", "-", 2).replace(" ", "T")
    if row["file_mtime"] is not None:
        return str(row["file_mtime"])
    return str(row["created_at"])


def _detection_score(detection: dict[str, Any]) -> float:
    quality = detection.get("quality") or {}
    try:
        return float(quality.get("combined", -1))
    except Exception:
        return -1.0


def _display_species(
    detection: dict[str, Any],
    override: SpeciesOverride | None,
) -> tuple[str | None, str | None, str | None, bool]:
    if override is not None:
        sci = str(override["canonical_sci"])
        name = override.get("canonical_zh") or override.get("canonical_en") or sci
        return str(name), sci, override.get("canonical_en"), True

    if detection.get("species"):
        direct_latin = detection.get("species_latin")
        candidates = detection.get("species_candidates") or []
        latin = direct_latin
        english = None
        if candidates:
            first = candidates[0] or {}
            if first.get("recognition_state") == "unrecognized":
                return None, None, None, False
            latin = latin or first.get("canonical_sci")
            english = first.get("canonical_en")
        return (
            str(detection["species"]),
            str(latin) if latin else None,
            str(english) if english else None,
            False,
        )

    candidates = detection.get("species_candidates") or []
    if candidates:
        first = candidates[0] or {}
        if first.get("recognition_state") == "unrecognized":
            return None, None, None, False
        sci = first.get("canonical_sci")
        name = first.get("canonical_zh") or first.get("canonical_en") or sci
        english = first.get("canonical_en")
        return (
            str(name) if name else None,
            str(sci) if sci else None,
            str(english) if english else None,
            False,
        )
    return None, None, None, False


def _candidate_recognition_state(detection: dict[str, Any]) -> str | None:
    candidates = detection.get("species_candidates") or []
    if not candidates:
        return None
    first = candidates[0] or {}
    state = first.get("recognition_state")
    return str(state) if state else None


def _build_detection_detail(
    index: int,
    detection: dict[str, Any],
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
    pose: dict[str, Any] | None = None
    pose_d = detection.get("pose")
    if isinstance(pose_d, dict):

        def _kp(name: str) -> dict[str, float] | None:
            kp = pose_d.get(name)
            if not isinstance(kp, dict):
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

    species, latin, _english, manual = _display_species(detection, override)
    candidate_state = _candidate_recognition_state(detection)
    if manual:
        species_source = "manual"
    elif not species or candidate_state == "unrecognized":
        species_source = "none"
    elif candidate_state == "uncertain":
        species_source = "model_unconfirmed"
    else:
        species_source = (
            "model" if pose is not None and pose["head_visible"] else "model_unconfirmed"
        )
    if species_source == "none":
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
            "species_source": species_source,
            "species_candidates": detection.get("species_candidates", []),
            "is_best": is_best,
        }
    )


async def _list_overrides_for_photos(
    db: Database,
    photo_ids: list[str],
) -> dict[str, list[SpeciesOverrideRecord]]:
    out: dict[str, list[SpeciesOverrideRecord]] = {}
    if not photo_ids:
        return out
    chunk_size = 500
    for start in range(0, len(photo_ids), chunk_size):
        chunk = photo_ids[start : start + chunk_size]
        placeholders = ",".join("?" for _ in chunk)
        async with db.conn.execute(
            "SELECT photo_id, bird_index, canonical_sci, canonical_zh, canonical_en, "
            "bbox_x1, bbox_y1, bbox_x2, bbox_y2 "
            "FROM photo_species_overrides "
            f"WHERE photo_id IN ({placeholders})",
            chunk,
        ) as cur:
            async for row in cur:
                x1 = row["bbox_x1"]
                y1 = row["bbox_y1"]
                x2 = row["bbox_x2"]
                y2 = row["bbox_y2"]
                bbox = (
                    (float(x1), float(y1), float(x2), float(y2))
                    if x1 is not None and y1 is not None and x2 is not None and y2 is not None
                    else None
                )
                out.setdefault(str(row["photo_id"]), []).append(
                    {
                        "bird_index": int(row["bird_index"]),
                        "canonical_sci": str(row["canonical_sci"]),
                        "canonical_zh": (
                            str(row["canonical_zh"]) if row["canonical_zh"] is not None else None
                        ),
                        "canonical_en": (
                            str(row["canonical_en"]) if row["canonical_en"] is not None else None
                        ),
                        "bbox": bbox,
                    }
                )
    return out


def _photo_from_row(row: Any, overrides: list[SpeciesOverrideRecord]) -> PhotoRow:
    result = _parse_json(row["result_json"])
    detections_raw = result.get("detections") or []
    if not isinstance(detections_raw, list):
        detections_raw = []
    detections = [d for d in detections_raw if isinstance(d, dict)]

    details: list[BirdDetectionDetail] | None = None
    best: BestDetection | None = None
    model_species: str | None = None
    model_species_latin: str | None = None
    effective_species = str(row["species"]) if row["species"] is not None else None
    effective_species_latin: str | None = None
    manual_species = False
    species_source = "none"

    if detections:
        best_index = max(
            range(len(detections)),
            key=lambda i: _detection_score(detections[i]),
        )
        matched = _match_overrides_to_detections(detections, overrides)
        details = [
            _build_detection_detail(i, d, matched.get(i), i == best_index)
            for i, d in enumerate(detections)
        ]
        if details:
            best_detail = details[min(best_index, len(details) - 1)]
            best = BestDetection.model_validate(best_detail.model_dump())
            effective_species = best.species or effective_species
            effective_species_latin = best.species_latin
            manual_species = bool(best.manual_species)
            species_source = best.species_source
        model_name, model_latin, _model_en, _manual = _display_species(detections[best_index], None)
        model_species = model_name
        model_species_latin = model_latin

    return PhotoRow(
        id=str(row["id"]),
        file_path=str(row["file_path"]),
        file_name=str(row["file_name"]),
        format=(str(row["format"]) if row["format"] is not None else None),
        width=(int(row["width"]) if row["width"] is not None else None),
        height=(int(row["height"]) if row["height"] is not None else None),
        thumb_grid=(str(row["thumb_grid"]) if row["thumb_grid"] is not None else None),
        thumb_preview=(str(row["thumb_preview"]) if row["thumb_preview"] is not None else None),
        companion_path=(str(row["companion_path"]) if row["companion_path"] is not None else None),
        companion_format=(
            str(row["companion_format"]) if row["companion_format"] is not None else None
        ),
        companion_size=(int(row["companion_size"]) if row["companion_size"] is not None else None),
        created_at=str(row["created_at"]),
        shot_at=_resolve_shot_at(row),
        scene_id=(int(row["scene_id"]) if row["scene_id"] is not None else None),
        pipeline_version=(
            str(row["pipeline_version"]) if row["pipeline_version"] is not None else None
        ),
        grade=(str(row["grade"]) if row["grade"] is not None else None),
        quality_score=(float(row["quality_score"]) if row["quality_score"] is not None else None),
        bird_count=(int(row["bird_count"]) if row["bird_count"] is not None else None),
        species=effective_species,
        species_latin=effective_species_latin,
        manual_species=manual_species,
        species_source=species_source,  # type: ignore[arg-type]
        model_species=model_species,
        model_species_latin=model_species_latin,
        decision=(str(row["decision"]) if row["decision"] is not None else None),
        exif=_parse_json(row["exif_json"]),
        best_detection=best,
        detections=details,
    )


async def _load_geo_photos(
    db: Database,
    where_sql: str,
    params: tuple[object, ...] = (),
) -> list[_GeoPhoto]:
    async with db.conn.execute(
        "SELECT p.id, p.library_id, p.file_path, p.file_name, p.format, p.width, p.height, "
        "p.thumb_grid, p.thumb_preview, p.created_at, p.file_mtime, p.exif_json, "
        "p.scene_id, p.companion_path, p.companion_format, p.companion_size, "
        "p.province, p.city, p.place, "
        "ar.pipeline_version, ar.grade, ar.quality_score, ar.bird_count, ar.species, "
        "ar.result_json, pd.decision "
        "FROM photos p "
        "JOIN analysis_results ar ON ar.photo_id = p.id AND ar.is_active = 1 "
        "LEFT JOIN photo_decisions pd ON pd.photo_id = p.id "
        f"WHERE ({where_sql}) "
        "AND ar.pipeline_version IS NOT NULL "
        "AND ar.bird_count > 0 "
        "AND COALESCE(pd.decision, ar.grade) IN ('select', 'usable', 'record') "
        "ORDER BY p.library_id, p.file_mtime ASC, p.id ASC",
        params,
    ) as cur:
        rows = await cur.fetchall()

    overrides = await _list_overrides_for_photos(db, [str(row["id"]) for row in rows])
    photos = [
        _GeoPhoto(
            library_id=str(row["library_id"]),
            photo=_photo_from_row(row, overrides.get(str(row["id"]), [])),
            exif_json=(str(row["exif_json"]) if row["exif_json"] is not None else None),
            province=(str(row["province"]) if row["province"] is not None else None),
            city=(str(row["city"]) if row["city"] is not None else None),
            place=(str(row["place"]) if row["place"] is not None else None),
            thumb_grid=(str(row["thumb_grid"]) if row["thumb_grid"] is not None else None),
        )
        for row in rows
    ]
    by_library: dict[str, list[PhotoRow]] = {}
    for item in photos:
        by_library.setdefault(item.library_id, []).append(item.photo)
    for library_photos in by_library.values():
        _apply_group_species_consensus(library_photos)
    return photos


def _get_geo_cache(key: str) -> Any | None:
    cached = _archive_geo_cache.get(key)
    if cached is None:
        return None
    created_at, value = cached
    if monotonic() - created_at > _ARCHIVE_GEO_CACHE_TTL_SECONDS:
        _archive_geo_cache.pop(key, None)
        return None
    return value


def _set_geo_cache(key: str, value: Any) -> Any:
    _archive_geo_cache[key] = (monotonic(), value)
    if len(_archive_geo_cache) > 64:
        oldest = min(_archive_geo_cache.items(), key=lambda item: item[1][0])[0]
        _archive_geo_cache.pop(oldest, None)
    return value


def _species_from_candidate(
    candidate: dict[str, Any], fallback_name: str | None
) -> GeoSpecies | None:
    latin = candidate.get("canonical_sci")
    name = candidate.get("canonical_zh") or candidate.get("canonical_en") or fallback_name or latin
    if not name and not latin:
        return None
    return GeoSpecies(
        name=str(name),
        latin_name=str(latin) if latin else None,
        english_name=(str(candidate["canonical_en"]) if candidate.get("canonical_en") else None),
    )


def _archive_species_for_photo(photo: PhotoRow) -> list[GeoSpecies]:
    grade = photo.decision or photo.grade
    if (
        photo.pipeline_version is None
        or (photo.bird_count or 0) <= 0
        or grade not in ARCHIVE_GRADES
    ):
        return []

    detections = photo.detections or (
        [] if photo.best_detection is None else [photo.best_detection]
    )
    out: list[GeoSpecies] = []
    seen: set[str] = set()
    for detection in detections:
        if detection.species_source not in ARCHIVE_SPECIES_SOURCES:
            continue
        species: GeoSpecies | None = None
        for candidate in detection.species_candidates:
            if (
                detection.species_latin
                and candidate.get("canonical_sci") != detection.species_latin
            ):
                continue
            species = _species_from_candidate(candidate, detection.species)
            break
        if species is None and (detection.species or detection.species_latin):
            species = GeoSpecies(
                name=detection.species or detection.species_latin or "",
                latin_name=detection.species_latin,
            )
        if species is None:
            continue
        key = species.latin_name or f"name:{species.name}"
        if key in seen:
            continue
        seen.add(key)
        out.append(species)
    return out


def _species_key(species: GeoSpecies) -> str:
    return species.latin_name or f"name:{species.name}"


def _species_summary(species_items: list[GeoSpecies]) -> list[GeoSpecies]:
    counts: Counter[str] = Counter()
    meta: dict[str, GeoSpecies] = {}
    for species in species_items:
        key = _species_key(species)
        counts[key] += 1
        meta.setdefault(key, species)
    return [
        GeoSpecies(
            name=meta[key].name,
            latin_name=meta[key].latin_name,
            english_name=meta[key].english_name,
            photo_count=count,
        )
        for key, count in sorted(counts.items(), key=lambda item: (-item[1], meta[item[0]].name))
    ]


_PLACE_PUNCT_RE = re.compile(r"[\s,，、;；:：|/\\]+")


def _normalize_place_name(place: str | None) -> str | None:
    """把 provider 返回的 place 规范化成聚合 key。

    同一个物理地点的照片经常有几米到几百米的 GPS 差异,但 reverse
    geocoding 已经给出相同 POI/地点名。城市层级应表达"这个地点有哪些鸟",
    所以不能再按坐标网格拆分。这里只做保守规范化:unicode 兼容折叠、
    去空白和常见分隔符;不做激进截断,避免把同城不同地点误合并。
    """
    if place is None:
        return None
    normalized = unicodedata.normalize("NFKC", place).strip()
    if not normalized:
        return None
    normalized = _PLACE_PUNCT_RE.sub("", normalized)
    return normalized or None


def _gps_from_exif(exif_json: str | None) -> tuple[float, float] | None:
    return parse_gps_from_exif(exif_json)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@router.get("/geo/summary", response_model=GeoSummary)
async def geo_summary(request: Request) -> GeoSummary:
    """整体地理解析进度 — 羽迹页面顶部进度条用。

    pending 必须只计"有可用经纬度但还没 backfill"的。部分相机会写入空的
    GPSInfo 容器(GPSVersionID/GPSSatellites 等),但不含 GPSLatitude/GPSLongitude;
    这些照片要算作无坐标,否则进度条会永远显示 X/Y。
    """
    db = await _db(request)
    async with db.conn.execute("SELECT COUNT(*) AS total FROM photos") as cur:
        total_row = await cur.fetchone()
    async with db.conn.execute(
        "SELECT exif_json, country FROM photos "
        "WHERE (exif_json LIKE '%\"GPSLatitude\"%' "
        "AND exif_json LIKE '%\"GPSLongitude\"%') "
        "OR country IS NOT NULL",
    ) as cur:
        rows = await cur.fetchall()

    total = int(total_row["total"] or 0) if total_row is not None else 0
    has_gps = 0
    resolved = 0
    unresolved = 0
    for row in rows:
        if _gps_from_exif(str(row["exif_json"]) if row["exif_json"] is not None else None) is None:
            continue
        has_gps += 1
        country = str(row["country"]) if row["country"] is not None else None
        if country == UNRESOLVED_COUNTRY:
            unresolved += 1
        elif country is not None:
            resolved += 1
    pending = max(0, has_gps - resolved - unresolved)
    return GeoSummary(
        total_with_gps=has_gps,
        resolved=resolved,
        pending=pending,
        unresolved_count=unresolved,
        photos_without_gps=total - has_gps,
    )


@router.get("/geo/provinces", response_model=list[GeoProvinceRow])
async def geo_provinces(request: Request) -> list[GeoProvinceRow]:
    """一级地图:每个省的照片数 + 鸟种数(去重后)。"""
    db = await _db(request)
    cache_key = f"{db.path}:provinces"
    cached = _get_geo_cache(cache_key)
    if cached is not None:
        return cached

    photos = await _load_geo_photos(db, "p.province IS NOT NULL")
    by_province: dict[str, dict[str, Any]] = {}
    for item in photos:
        if not item.province:
            continue
        species = _archive_species_for_photo(item.photo)
        if not species:
            continue
        bucket = by_province.setdefault(item.province, {"species": set(), "photos": 0})
        bucket["photos"] += 1
        for entry in species:
            bucket["species"].add(_species_key(entry))

    return _set_geo_cache(
        cache_key,
        [
            GeoProvinceRow(
                province=prov,
                photo_count=int(b["photos"]),
                species_count=len(b["species"]),
            )
            for prov, b in sorted(by_province.items(), key=lambda x: -int(x[1]["photos"]))
        ],
    )


@router.get("/geo/cities", response_model=list[GeoCityRow])
async def geo_cities(
    request: Request,
    province: str = Query(..., description="省名(如 '江苏省')"),
) -> list[GeoCityRow]:
    """二级地图:某省内每个市的照片数 + 鸟种数。"""
    db = await _db(request)
    cache_key = f"{db.path}:cities:{province}"
    cached = _get_geo_cache(cache_key)
    if cached is not None:
        return cached

    photos = await _load_geo_photos(db, "p.province = ? AND p.city IS NOT NULL", (province,))
    by_city: dict[str, dict[str, Any]] = {}
    for item in photos:
        if not item.city:
            continue
        species = _archive_species_for_photo(item.photo)
        if not species:
            continue
        bucket = by_city.setdefault(item.city, {"species": set(), "photos": 0})
        bucket["photos"] += 1
        for entry in species:
            bucket["species"].add(_species_key(entry))

    return _set_geo_cache(
        cache_key,
        [
            GeoCityRow(
                city=city,
                photo_count=int(b["photos"]),
                species_count=len(b["species"]),
            )
            for city, b in sorted(by_city.items(), key=lambda x: -int(x[1]["photos"]))
        ],
    )


@router.get("/geo/spots", response_model=list[GeoSpot])
async def geo_spots(
    request: Request,
    province: str = Query(...),
    city: str = Query(...),
    max_photos_per_spot: int = Query(500, ge=1, le=1000),
) -> list[GeoSpot]:
    """三级地图:某省某市的所有拍摄地点。

    聚合口径是"物理地点优先":同一个 place 名下的照片合成一个 GeoSpot,
    用于回答"洋湖国家湿地公园有哪些鸟"。只有 place 缺失时,才按 GPS
    4 位小数 round 兜底生成临时点位。
    """
    db = await _db(request)
    cache_key = f"{db.path}:spots:{province}:{city}:{max_photos_per_spot}"
    cached = _get_geo_cache(cache_key)
    if cached is not None:
        return cached

    photos = await _load_geo_photos(db, "p.province = ? AND p.city = ?", (province, city))

    spots: dict[str, dict[str, Any]] = {}
    for item in photos:
        species = _archive_species_for_photo(item.photo)
        if not species:
            continue
        gps = _gps_from_exif(item.exif_json)
        if gps is None:
            continue
        lat, lon = gps

        place_key = _normalize_place_name(item.place)
        key = (
            f"place:{place_key}"
            if place_key is not None
            else f"gps:{round(lat, 4):.4f},{round(lon, 4):.4f}"
        )
        bucket = spots.setdefault(
            key,
            {
                "lat_sum": 0.0,
                "lon_sum": 0.0,
                "place": item.place,
                "photos": [],
                "photo_total": 0,  # 真实总数(独立于 photos 列表的 cap)
                "species": [],
            },
        )
        bucket["photo_total"] = int(bucket["photo_total"]) + 1
        bucket["lat_sum"] = float(bucket["lat_sum"]) + lat
        bucket["lon_sum"] = float(bucket["lon_sum"]) + lon
        if bucket["place"] is None and item.place is not None:
            bucket["place"] = item.place
        bucket["species"].extend(species)
        if len(bucket["photos"]) < max_photos_per_spot:
            primary = species[0] if species else None
            bucket["photos"].append(
                GeoSpotPhoto(
                    photo_id=item.photo.id,
                    file_name=item.photo.file_name,
                    species=species,
                    species_latin=primary.latin_name if primary else None,
                    species_zh=primary.name if primary else None,
                    thumb_grid=item.thumb_grid,
                    grade=item.photo.decision or item.photo.grade,
                    quality_score=(
                        float(item.photo.quality_score)
                        if item.photo.quality_score is not None
                        else None
                    ),
                )
            )

    return _set_geo_cache(
        cache_key,
        [
            GeoSpot(
                lat=float(b["lat_sum"]) / max(1, int(b["photo_total"])),
                lon=float(b["lon_sum"]) / max(1, int(b["photo_total"])),
                place=b["place"],
                # 真实总数(可能 > max_photos_per_spot,bucket["photos"] 列表只截断展示);
                # 前端 tooltip 显示总数,弹卡片缩略图列表显示截断后的样本。
                photo_count=int(b["photo_total"]),
                species_count=len({_species_key(s) for s in b["species"]}),
                species=_species_summary(b["species"]),
                photos=b["photos"],
            )
            for b in sorted(spots.values(), key=lambda x: -int(x["photo_total"]))
        ],
    )
